// VIS Applicator: technology selection and sizing (flow, level, pressure, temperature, analysis).
//
// How it fits in: backend/server.js calls
//   - applicate(catalog, body) for POST /api/applicator/select: ranks every product of one measured variable
//     against the process conditions and, for each suitable one, adds a sizing result;
//   - size(body) for POST /api/applicator/sizing: sizes one measured variable on its own.
// The frontend (frontend/js/main.js) renders the returned JSON. Every function here is pure (no I/O), so it is easy to test.
//
// Main flow of applicate():
//   1. selectTechnology(): hard limits (medium, temperature, pressure, Ex, hygienic, conductivity) decide
//      "suitable" or "unsuitable"; soft rules (close to a limit, accuracy, medium fit) give a score of 0–100.
//   2. sizeFor(): picks the sizing function for each suitable technology and runs it with the optional inputs.
//
// Units used throughout: temperature °C, pressure bar (gauge, i.e. above atmosphere; −1 bar = full vacuum),
// differential pressure mbar, flow m³/h, velocity m/s, pipe size DN (nominal diameter, ≈ inner diameter in mm),
// tank height / nozzle m, density kg/m³, conductivity µS/cm.
//
// Texts: t('English text with {placeholders}', vars) in the language of input.lang (see lib/i18n.js).
// Write whole sentences (no words glued into a sentence), so they can be translated with correct grammar.
// i18n rule for THIS file: tools/i18n-check.mjs treats every single-quoted string with a space (outside comments)
// as a translation key. Use double quotes or template literals for text that must not be translated.
const { translator } = require('./i18n');

// ---------- Inputs ----------
const MEDIA = ['liquid', 'gas', 'steam', 'slurry', 'solid'];
const VARIABLES = ['flow', 'level', 'pressure', 'temperature', 'analysis'];

/** Form value → number; empty / missing → null (an invalid text gives NaN, which callers reject). */
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/** True when a form field was filled in (0 counts as filled). */
const isFilled = (v) => v !== '' && v !== null && v !== undefined;

// ---------- Technology selection (scoring) ----------
// Every product starts at BASE_SCORE. Running close to a limit costs points; accuracy and a good medium fit add points.
// The raw score (0–120) is scaled to 0–100 % for display.
const BASE_SCORE = 100;
const MAX_RAW_SCORE = 120;
const RAW_TO_PERCENT = 1.2; // 120 raw points = 100 %
// Above 85 % of the max. temperature / pressure the device still works, but has little safety margin.
const NEAR_LIMIT_FACTOR = 0.85;
const NEAR_LIMIT_PENALTY = 15;
// Accuracy bonus: 10 points for a perfect device, minus 10 points per 1 % error (so ±1 % or worse gives 0).
const MAX_ACCURACY_BONUS = 10;
// Electrode-based meters (electromagnetic flow) need a conductive liquid; only liquids and slurries are checked.
const CONDUCTIVE_MEDIA = ['liquid', 'slurry'];
// The lowest gauge pressure possible: full vacuum.
const MIN_PRESSURE_BAR = -1;

const NOT_A_NUMBER = {
    temperature: 'Temperature must be a number.',
    pressure: 'Pressure must be a number.',
    conductivity: 'Conductivity must be a number.',
};
const NOT_FOR_MEDIUM = {
    liquid: 'Not designed for liquid.',
    gas: 'Not designed for gas.',
    steam: 'Not designed for steam.',
    slurry: 'Not designed for slurry.',
    solid: 'Not designed for solid.',
};

/**
 * Read and check the process conditions of the form.
 * Returns { error } or { conditions: { variable, medium, temp, pressure, conductivity, ex, hygienic } }.
 */
function readConditions(input, t) {
    const variable = String(input.variable || '');
    const medium = String(input.medium || '');
    if (!VARIABLES.includes(variable)) return { error: t('Please choose a measured variable.') };
    if (!MEDIA.includes(medium)) return { error: t('Please choose a medium.') };

    const temp = num(input.temperature);
    const pressure = num(input.pressure);
    const conductivity = num(input.conductivity);
    const numbers = [['temperature', temp], ['pressure', pressure], ['conductivity', conductivity]];
    for (const [key, value] of numbers) {
        if (value !== null && !Number.isFinite(value)) return { error: t(NOT_A_NUMBER[key]) };
    }
    if (pressure !== null && pressure < MIN_PRESSURE_BAR) return { error: t('Pressure cannot be below −1 bar (vacuum).') };

    const ex = Boolean(input.ex);
    const hygienic = Boolean(input.hygienic);
    return { conditions: { variable, medium, temp, pressure, conductivity, ex, hygienic } };
}

/**
 * Rate one product against the conditions.
 * Returns { fails, notes, score }: any fail makes the product unsuitable; notes are hints for suitable ones.
 */
function rateProduct(product, conditions, t) {
    const { medium, temp, pressure, conductivity, ex, hygienic } = conditions;
    const fails = [];
    const notes = [];
    let score = BASE_SCORE;

    // Hard limits from the data sheet.
    if (!product.media.includes(medium)) fails.push(t(NOT_FOR_MEDIUM[medium]));
    if (temp !== null && product.tempMax != null) {
        if (temp > product.tempMax) {
            fails.push(t('Process temperature {temp} °C exceeds max. {max} °C.', { temp, max: product.tempMax }));
        } else if (temp > product.tempMax * NEAR_LIMIT_FACTOR) {
            score -= NEAR_LIMIT_PENALTY;
            notes.push(t('Close to the temperature limit ({max} °C).', { max: product.tempMax }));
        }
    }
    if (pressure !== null && product.pressureMax != null) {
        if (pressure > product.pressureMax) {
            fails.push(t('Process pressure {pressure} bar exceeds max. {max} bar.', { pressure, max: product.pressureMax }));
        } else if (pressure > product.pressureMax * NEAR_LIMIT_FACTOR) {
            score -= NEAR_LIMIT_PENALTY;
            notes.push(t('Close to the pressure limit ({max} bar).', { max: product.pressureMax }));
        }
    }
    // Ex = approved for explosive atmospheres; 3-A / EHEDG = hygienic design for food and pharma.
    if (ex && !product.ex) fails.push(t('No hazardous-area (Ex) approval.'));
    if (hygienic && !product.hygienic) fails.push(t('No hygienic design (3-A / EHEDG).'));
    if (product.minConductivity != null && CONDUCTIVE_MEDIA.includes(medium)) {
        const min = product.minConductivity;
        if (conductivity === null) {
            notes.push(t('Requires a conductivity of at least {min} µS/cm.', { min }));
        } else if (conductivity < min) {
            fails.push(t('Conductivity {value} µS/cm is below the min. {min} µS/cm.', { value: conductivity, min }));
        }
    }

    // Prefer more accurate devices (accuracy in % of reading; other units are not comparable, so no bonus).
    if (product.accuracy != null && (!product.accuracyUnit || product.accuracyUnit === '%')) {
        score += Math.max(0, MAX_ACCURACY_BONUS - product.accuracy * 10);
    }
    // Rules of thumb: vortex is the standard meter for steam; electromagnetic meters have no moving parts and a
    // smooth liner, so abrasive slurries do little harm; Coriolis has a high minimum mass flow for light gases.
    if (medium === 'steam' && product.id === 'vortex') {
        score += 15;
        notes.push(t('Preferred technology for steam.'));
    }
    if (medium === 'slurry' && product.id === 'electromagnetic') {
        score += 10;
        notes.push(t('Handles abrasive slurries well.'));
    }
    if (medium === 'gas' && product.id === 'coriolis') notes.push(t('For gases, check the minimum mass flow.'));

    return { fails, notes, score };
}

/** Raw score → 0–100 % (clamped to 0–120 first). */
const scorePercent = (score) => Math.round(Math.max(0, Math.min(score, MAX_RAW_SCORE)) / RAW_TO_PERCENT);

/**
 * Rank all products of one measured variable against the process conditions.
 * Returns { suitable: [...], unsuitable: [...] }, every product with reasons; suitable ones sorted by score.
 */
function selectTechnology(catalog, input) {
    const t = translator(input.lang);
    const { error, conditions } = readConditions(input, t);
    if (error) return { error };

    const suitable = [];
    const unsuitable = [];
    for (const product of catalog.products.filter((x) => x.category === conditions.variable)) {
        const { fails, notes, score } = rateProduct(product, conditions, t);
        const entry = {
            id: product.id,
            name: product.name,
            principle: product.principle,
            highlights: product.highlights,
            brands: product.brands,
            accuracy: product.accuracy,
            accuracyUnit: product.accuracyUnit || '%',
            tempMax: product.tempMax,
            pressureMax: product.pressureMax,
        };
        if (fails.length) unsuitable.push({ ...entry, reasons: fails });
        else suitable.push({ ...entry, score: scorePercent(score), notes });
    }

    suitable.sort((a, b) => b.score - a.score);
    return { suitable, unsuitable };
}

// ---------- Flow sizing ----------
// A flowmeter measures best in a certain flow-velocity window: too slow gives a weak signal (electromagnetic,
// ultrasonic) or no vortices at all (vortex); too fast causes wear, pressure loss and noise.
// Recommended velocity windows in m/s per technology and medium (typical manufacturer guidance):
// min / max = usable range, optMin / optMax = best accuracy.
const VELOCITY = {
    electromagnetic: {
        liquid: { min: 0.3, max: 10, optMin: 1, optMax: 3 },
        slurry: { min: 1, max: 5, optMin: 1.5, optMax: 3 },
    },
    vortex: {
        liquid: { min: 0.3, max: 9, optMin: 1, optMax: 5 },
        gas: { min: 3, max: 75, optMin: 10, optMax: 40 },
        steam: { min: 3, max: 75, optMin: 10, optMax: 40 },
    },
    'ultrasonic-flow': {
        liquid: { min: 0.1, max: 12, optMin: 1, optMax: 5 },
        gas: { min: 0.5, max: 40, optMin: 5, optMax: 25 },
    },
    coriolis: {
        liquid: { min: 0.2, max: 8, optMin: 1, optMax: 4 },
        slurry: { min: 0.5, max: 4, optMin: 1, optMax: 3 },
        gas: { min: 1, max: 60, optMin: 5, optMax: 30 },
    },
    'thermal-mass': {
        gas: { min: 0.5, max: 100, optMin: 5, optMax: 40 },
    },
};
// Standard nominal pipe diameters (DN, ≈ inner diameter in mm).
const DN = [15, 25, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 500, 600, 800, 1000];
const MAX_FLOW_M3H = 1e6;
const SECONDS_PER_HOUR = 3600;

const NOT_SIZED_FOR_MEDIUM = {
    liquid: 'This technology is not sized for liquid. Choose another medium.',
    gas: 'This technology is not sized for gas. Choose another medium.',
    steam: 'This technology is not sized for steam. Choose another medium.',
    slurry: 'This technology is not sized for slurry. Choose another medium.',
    solid: 'This technology is not sized for solid. Choose another medium.',
};
// Disturbances (bends, valves) distort the flow profile; the meter needs this much straight pipe before / after it.
const STRAIGHT_RUNS = {
    electromagnetic: 'Straight pipe runs: 5 × DN upstream, 2 × DN downstream.',
    vortex: 'Straight pipe runs: 15 × DN upstream, 5 × DN downstream (more after bends and valves).',
    'ultrasonic-flow': 'Straight pipe runs: 10 × DN upstream, 5 × DN downstream.',
    coriolis: 'Straight pipe runs: no straight runs needed.',
    'thermal-mass': 'Straight pipe runs: 15 × DN upstream, 5 × DN downstream.',
};

/** Velocity in m/s for a flow in m³/h through a pipe of nominal diameter dn (mm), rated against the window. */
function velocityRow(dn, flow, window) {
    const area = Math.PI * (dn / 1000) ** 2 / 4; // m²
    const velocity = flow / SECONDS_PER_HOUR / area;
    let status = 'ok';
    if (velocity < window.min || velocity > window.max) status = 'out';
    else if (velocity >= window.optMin && velocity <= window.optMax) status = 'optimal';
    return { dn, velocity: Number(velocity.toPrecision(3)), status };
}

/** Advice for the existing pipe row compared with the recommended DN (or undefined when there is none). */
function pipeNote(row, recommended, t) {
    const vars = { pipe: row.dn, velocity: row.velocity, recommended };
    if (row.status === 'optimal') {
        return t('Your DN {pipe} pipe is in the optimal range: the meter can have the same size as the pipe.', vars);
    }
    if (row.status === 'ok') {
        return t('Your DN {pipe} pipe works ({velocity} m/s). DN {recommended} would give the best accuracy.', vars);
    }
    // Too slow → a smaller meter with reducers raises the velocity; too fast → a larger pipe and meter.
    if (recommended && recommended < row.dn) {
        return t('Velocity in DN {pipe} is too low ({velocity} m/s): use a DN {recommended} meter with reducers (concentric, max. 8° cone angle).', vars);
    }
    if (recommended) {
        return t('Velocity in DN {pipe} is too high ({velocity} m/s): a larger pipe and meter (DN {recommended}) are recommended.', vars);
    }
    return undefined;
}

/** Flow velocity for every standard nominal diameter, with a recommended DN (and a check of the existing pipe). */
function sizeFlowmeter(input) {
    const t = translator(input.lang);
    const technology = String(input.technology || '');
    const medium = String(input.medium || '');
    const flow = num(input.flow);
    const windows = VELOCITY[technology];
    if (!windows) return { error: t('Please choose a flow technology.') };
    const window = windows[medium];
    if (!window) {
        if (NOT_SIZED_FOR_MEDIUM[medium]) return { error: t(NOT_SIZED_FOR_MEDIUM[medium]) };
        return { error: t('This technology is not sized for {medium}. Choose another medium.', { medium }) };
    }
    if (flow === null || !Number.isFinite(flow) || flow <= 0) {
        return { error: t('Please enter a flow rate greater than 0 m³/h.') };
    }
    if (flow > MAX_FLOW_M3H) return { error: t('Flow rate is out of range.') };

    const rows = DN.map((dn) => velocityRow(dn, flow, window));
    // Recommend the smallest DN in the optimal window (cheapest), else the smallest usable one.
    const recommended = rows.find((r) => r.status === 'optimal') || rows.find((r) => r.status === 'ok') || null;
    const result = {
        variable: 'flow',
        technology,
        medium,
        flow,
        window,
        rows,
        recommended: recommended ? recommended.dn : null,
        notes: [],
    };

    // Existing pipe: velocity there, and whether the meter needs reducers.
    const pipe = num(input.pipeDn);
    const pipeRow = pipe ? rows.find((r) => r.dn === pipe) : undefined;
    if (pipeRow) {
        result.pipe = pipeRow;
        const note = pipeNote(pipeRow, result.recommended, t);
        if (note) result.notes.push(note);
    }
    result.notes.push(t(STRAIGHT_RUNS[technology]));
    return result;
}

// ---------- Helpers for the other measured variables ----------
/** Round to d decimals and return a number. */
const round = (v, d = 2) => Number(v.toFixed(d));
/** First value in an ascending list that is ≥ v (the next standard size), or null. */
const nextUp = (list, v) => list.find((x) => x >= v) ?? null;
/** Error for a required positive value: `empty` when missing / ≤ 0, `tooBig` (with {max}) above max. */
const positive = (v, max, empty, tooBig) => {
    if (v === null || !Number.isFinite(v) || v <= 0) return empty;
    if (max && v > max) return tooBig;
    return null;
};
/** Range in mbar → "250 mbar" or, from 1000 mbar on, "4 bar". */
const pressureLabel = (mbar) => (mbar >= 1000 ? `${mbar / 1000} bar` : `${mbar} mbar`);

// ---------- Level sizing ----------
const LEVEL_TECHNOLOGIES = ['radar-level', 'guided-radar', 'hydrostatic-level', 'ultrasonic-level'];
const MAX_TANK_HEIGHT_M = 150;
const DEFAULT_DENSITY = 1000; // kg/m³, water
const DEFAULT_NOZZLE_M = 0.2;
const RADAR_MAX_RANGE_M = 120;
const GUIDED_RADAR_MAX_PROBE_M = 45;
const GUIDED_RADAR_ROD_MAX_M = 4; // longer probes are cables
const PROBE_BOTTOM_GAP_M = 0.05; // the probe ends ≈ 50 mm above the bottom
const GRAVITY = 9.81; // m/s²
// Standard hydrostatic sensor ranges in mbar (100 mbar … 40 bar).
const HYDROSTATIC_RANGES = [100, 250, 400, 1000, 2000, 4000, 10000, 40000];
const ANTENNA_INCH = { 50: '2"', 80: '3"', 100: '4"' };

/** Radar antenna DN: a larger antenna focuses the beam better, which longer ranges and dusty solids need. */
function radarAntennaDn(range, medium) {
    if (medium === 'liquid') {
        if (range <= 10) return 50;
        if (range <= 30) return 80;
        return 100;
    }
    return range <= 15 ? 80 : 100;
}

/** Ultrasonic blocking distance in m: right below the sensor it cannot hear the echo (grows with the range). */
function ultrasonicBlockingDistance(range) {
    if (range <= 5) return 0.25;
    if (range <= 8) return 0.35;
    return 0.6;
}

/** Non-contact radar: antenna size for the measuring distance. Returns out (filled) or a fail result. */
function sizeRadarLevel(out, range, medium, t) {
    if (range > RADAR_MAX_RANGE_M) return { ...out, headline: t('Out of range'), fail: t('Radar measures up to 120 m.') };
    const antenna = radarAntennaDn(range, medium);
    out.headline = t('{range} m range · DN {antenna} antenna', { range: Math.ceil(range), antenna });
    out.summary.push(
        [t('Recommended antenna / nozzle'), `DN ${antenna} (${ANTENNA_INCH[antenna]})`],
        [t('Max. nozzle length'), antenna === 50 ? "≈ 0.5 m" : t('≈ 1 m (80 GHz, narrow beam)')],
    );
    out.notes.push(t('80 GHz radar: narrow beam, mount away from inlets, agitators and the tank wall (≥ 0.3 m).'));
    if (medium === 'solid') out.notes.push(t('Bulk solids: a larger antenna and an air purge connection help with dust.'));
    return out;
}

/** Guided radar: probe length (flange to just above the bottom) and probe type. */
function sizeGuidedRadar(out, height, nozzle, medium, t) {
    const probe = round(height + nozzle - PROBE_BOTTOM_GAP_M);
    let type = t('Rod probe (Ø 8–16 mm)');
    if (medium === 'solid') type = t('Cable probe (Ø 4–8 mm, tensile load!)');
    else if (probe > GUIDED_RADAR_ROD_MAX_M) type = t('Cable probe (Ø 4 mm) with weight');
    if (probe > GUIDED_RADAR_MAX_PROBE_M) {
        const fail = t('Guided radar probes are available up to 45 m. Use non-contact radar.');
        return { ...out, headline: t('Out of range'), fail };
    }
    out.headline = t('{probe} m probe', { probe });
    out.summary.push(
        [t('Probe length'), t('{probe} m (ends ≈ 50 mm above the bottom)', { probe })],
        [t('Probe type'), type],
        [t('Nozzle'), t('DN 50 / 2" or larger, nozzle height ≤ nozzle diameter')],
    );
    // εr = relative permittivity (dielectric constant); oils and plastics are low, water is about 80.
    out.notes.push(t('Coaxial probes for low-dielectric media (εr < 1.6) and interface measurement.'));
    if (medium === 'solid') out.notes.push(t('Check the tensile load on the cable probe (silo height, product, flow).'));
    return out;
}

/** Hydrostatic: pressure of the full liquid column (p = ρ·g·h) → next standard sensor range. */
function sizeHydrostaticLevel(out, height, density, medium, t) {
    if (medium === 'solid') return { error: t('Hydrostatic level works for liquids only.') };
    const mbar = density * GRAVITY * height / 100; // Pa / 100 = mbar
    const sensor = nextUp(HYDROSTATIC_RANGES, mbar);
    if (!sensor) return { ...out, headline: t('Out of range'), fail: t('The hydrostatic pressure exceeds 40 bar.') };
    out.headline = t('{range} sensor', { range: pressureLabel(sensor) });
    out.summary.push(
        [t('Density'), `${density} kg/m³`],
        [t('Hydrostatic pressure at full tank'), `${round(mbar, 0)} mbar`],
        [t('Recommended sensor range'), `0 … ${pressureLabel(sensor)}`],
        // Turndown = sensor range / used span; the lower, the better the accuracy.
        [t('Turndown used'), `${round(sensor / mbar, 1)} : 1`],
    );
    out.notes.push(t('Closed, pressurised tanks: use a differential pressure (DP) transmitter or electronic DP to cancel the head pressure.'));
    if (density !== DEFAULT_DENSITY) out.notes.push(t('If the density changes, the level reading changes with it.'));
    return out;
}

/** Ultrasonic: max. range (sound is damped more by solids) and blocking distance. */
function sizeUltrasonicLevel(out, range, medium, t) {
    const max = medium === 'liquid' ? 20 : 10;
    if (range > max) {
        const fail = medium === 'liquid'
            ? t('Ultrasonic sensors measure up to about {max} m in liquids. Use radar.', { max })
            : t('Ultrasonic sensors measure up to about {max} m in bulk solids. Use radar.', { max });
        return { ...out, headline: t('Out of range'), fail };
    }
    const block = ultrasonicBlockingDistance(range);
    out.headline = t('{range} m range', { range: Math.ceil(range) });
    out.summary.push(
        [t('Blocking distance'), `${block} m`],
        [t('Mounting'), t('Max. level at least {block} m below the sensor', { block })],
    );
    out.notes.push(t('Avoid foam, heavy vapour and strong dust; these weaken the echo.'));
    return out;
}

/**
 * Level: measuring range, antenna / nozzle size, probe length or hydrostatic sensor range for a tank.
 * Returns { variable, technology, medium, summary: [[label, value]…], notes, headline } or { …, fail } or { error }.
 */
function sizeLevel(input) {
    const t = translator(input.lang);
    const technology = String(input.technology || 'radar-level');
    const medium = input.medium === 'solid' ? 'solid' : 'liquid';
    const height = num(input.height);
    const density = num(input.density) ?? DEFAULT_DENSITY;
    const nozzle = num(input.nozzle) ?? DEFAULT_NOZZLE_M;
    const err = positive(
        height,
        MAX_TANK_HEIGHT_M,
        t('Please enter a tank height in m greater than 0.'),
        t('A tank height in m is out of range (max. {max}).', { max: MAX_TANK_HEIGHT_M }),
    );
    if (err) return { error: err };
    if (!Number.isFinite(density) || density < 100 || density > 25000) {
        return { error: t('Density must be between 100 and 25,000 kg/m³.') };
    }
    if (!Number.isFinite(nozzle) || nozzle < 0 || nozzle > 5) return { error: t('Nozzle height must be between 0 and 5 m.') };

    const range = height + nozzle; // from the flange (top of the nozzle) to the tank bottom
    const out = {
        variable: 'level',
        technology,
        medium,
        summary: [
            [t('Tank height'), `${height} m`],
            [t('Measuring distance (flange → bottom)'), `${round(range)} m`],
        ],
        notes: [],
    };

    if (technology === 'radar-level') return sizeRadarLevel(out, range, medium, t);
    if (technology === 'guided-radar') return sizeGuidedRadar(out, height, nozzle, medium, t);
    if (technology === 'hydrostatic-level') return sizeHydrostaticLevel(out, height, density, medium, t);
    if (technology === 'ultrasonic-level') return sizeUltrasonicLevel(out, range, medium, t);
    return { error: t('Please choose a level technology.') };
}

// ---------- Pressure sizing ----------
const PRESSURE_TYPES = ['gauge', 'absolute', 'differential'];
const PRESSURE_TYPE_LABEL = {
    gauge: 'Gauge pressure',
    absolute: 'Absolute pressure',
    differential: 'Differential pressure',
};
// Standard upper range limits (URL): differential pressure in mbar, gauge / absolute pressure in bar.
const DP_RANGES_MBAR = [10, 30, 100, 500, 3000, 16000, 40000];
const PRESSURE_RANGES_BAR = [0.1, 0.4, 1, 2, 4, 10, 40, 100, 160, 400, 700];
const MAX_DP_MBAR = 40000;
const MAX_PRESSURE_BAR = 1000;
// Run at no more than ~80 % of the sensor's upper range limit: sensor ≥ 1.25 × max. operating pressure.
const RANGE_MARGIN = 1.25;
// A process hotter than this would damage the sensor diaphragm directly.
const DIRECT_MOUNT_MAX_TEMP = 120;

/** DP transmitters see the line pressure on both sides: their body must be rated for it (160 / 250 / 420 bar). */
function staticRating(staticBar) {
    if (staticBar > 250) return '420';
    if (staticBar > 160) return '250';
    return '160';
}

/** Error text for a missing or out-of-range max. pressure, or null when it is fine. */
function pressureInputError(type, max, t) {
    if (type === 'differential') {
        return positive(
            max,
            MAX_DP_MBAR,
            t('Please enter a max. differential pressure in mbar greater than 0.'),
            t('A max. differential pressure in mbar is out of range (max. {max}).', { max: MAX_DP_MBAR }),
        );
    }
    return positive(
        max,
        MAX_PRESSURE_BAR,
        t('Please enter a max. operating pressure in bar greater than 0.'),
        t('A max. operating pressure in bar is out of range (max. {max}).', { max: MAX_PRESSURE_BAR }),
    );
}

/** Pressure: sensor range, calibrated span and turndown for the operating pressure. */
function sizePressure(input) {
    const t = translator(input.lang);
    const type = PRESSURE_TYPES.includes(input.type) ? input.type : 'gauge';
    const max = num(input.maxPressure);
    const temp = num(input.temperature);
    const medium = String(input.medium || 'liquid');
    const err = pressureInputError(type, max, t);
    if (err) return { error: err };

    const isDp = type === 'differential';
    const unit = isDp ? 'mbar' : 'bar';
    const ranges = isDp ? DP_RANGES_MBAR : PRESSURE_RANGES_BAR;
    const sensor = nextUp(ranges, max * RANGE_MARGIN);
    if (!sensor) {
        return { error: t('The pressure is above the largest standard range ({max} {unit}).', { max: ranges.at(-1), unit }) };
    }
    // The transmitter is calibrated (set) to 0 … 1.25 × max, but never beyond the sensor itself.
    const span = Math.min(Number((max * RANGE_MARGIN).toPrecision(2)), sensor);
    const out = {
        variable: 'pressure',
        technology: isDp ? 'dp-transmitter' : 'pressure-transmitter',
        headline: t('0 … {sensor} {unit} sensor', { sensor, unit }),
        summary: [
            [t('Measurement'), t(PRESSURE_TYPE_LABEL[type])],
            [t('Max. operating pressure'), `${max} ${unit}`],
            [t('Recommended sensor (URL)'), `0 … ${sensor} ${unit}`],
            [t('Calibrated span'), `0 … ${span} ${unit}`],
            [t('Turndown'), `${round(sensor / span, 1)} : 1`],
        ],
        notes: [],
    };

    if (type === 'absolute' && max < 1.5) {
        out.notes.push(t('Close to vacuum: an absolute (not gauge) sensor is the right choice.'));
    }
    if (isDp) {
        const stat = num(input.staticPressure);
        if (stat) {
            const rating = staticRating(stat);
            out.summary.push([t('Static pressure'), t('{stat} bar → choose a {rating} bar static rating', { stat, rating })]);
        }
        out.notes.push(t('Use a 3- or 5-valve manifold for zeroing and isolation.'));
    }
    if (medium === 'steam') {
        out.notes.push(t('Steam: mount with a siphon (pigtail) or a filled impulse line to protect the sensor.'));
    } else if (temp !== null && temp > DIRECT_MOUNT_MAX_TEMP) {
        out.notes.push(t('At {temp} °C use a diaphragm seal with capillary or a temperature isolator.', { temp }));
    }
    if (medium === 'slurry') out.notes.push(t('Slurries / viscous media: use a flush diaphragm or a diaphragm seal.'));
    return out;
}

// ---------- Temperature sizing ----------
// Outside diameter in mm of the standard steel pipe for each DN (EN 10220 / ISO 4200 series).
const PIPE_OD = {
    15: 21.3, 25: 33.7, 40: 48.3, 50: 60.3, 65: 76.1, 80: 88.9, 100: 114.3, 125: 139.7,
    150: 168.3, 200: 219.1, 250: 273, 300: 323.9, 350: 355.6, 400: 406.4, 500: 508, 600: 610,
};
const THERMOWELL_TIP_MM = 9;
// A sensor reads the medium temperature only when immersed deep enough (heat flows away along the stem):
// rule of thumb 10 × tip diameter in liquids, 15 × in gases (worse heat transfer).
const IMMERSION_FACTOR = { liquid: 10, gas: 15 };
const NECK_MM = 80; // neck / nozzle height above the pipe wall
const MAX_IMMERSION_SHARE = 0.66; // never deeper than 2/3 of the outside diameter
const SMALL_PIPE_DN = 50; // up to this size a straight insertion is never deep enough
// Standard insertion lengths U in mm.
const INSERTION_LENGTHS = [50, 70, 100, 115, 160, 225, 250, 315, 400, 500];
const LONGEST_INSERTION = 500;
// Above these velocities (m/s) vortex shedding can make the thermowell vibrate and break.
const WAKE_VELOCITY_LIMIT = { liquid: 3, gas: 25 };

/** Sensor element for the temperature: Pt100 RTDs are most accurate, thermocouples go hotter. */
function temperatureSensor(temp, t) {
    if (temp <= 400) return t('Pt100 RTD (thin film), class A');
    if (temp <= 600) return t('Pt100 RTD (wire-wound)');
    if (temp <= 1100) return t('Thermocouple type K or N');
    return t('Thermocouple type S / R / B (noble metal)');
}

/** Temperature: insertion length for the pipe, thermowell and sensor type. */
function sizeTemperature(input) {
    const t = translator(input.lang);
    const dn = num(input.pipeDn);
    const temp = num(input.temperature);
    const velocity = num(input.velocity);
    const medium = String(input.medium || 'liquid');
    if (!PIPE_OD[dn]) return { error: t('Please choose a pipe size.') };
    if (temp === null || !Number.isFinite(temp) || temp < -200 || temp > 1700) {
        return { error: t('Please enter a process temperature between −200 and 1700 °C.') };
    }

    const gas = ['gas', 'steam'].includes(medium);
    const minImmersion = (gas ? IMMERSION_FACTOR.gas : IMMERSION_FACTOR.liquid) * THERMOWELL_TIP_MM;
    const od = PIPE_OD[dn];
    const toCentre = od / 2;
    // Aim for the minimum immersion, at least to the pipe centre, at most 2/3 of the diameter.
    let immersion = Math.max(toCentre, Math.min(minImmersion, od * MAX_IMMERSION_SHARE));
    let install = t('Straight pipe, 90° to the flow, tip in the pipe centre (to 1/3 of the pipe diameter)');
    if (immersion < minImmersion) {
        // A straight insertion is too short: an angled or elbow mounting gives more length in the medium.
        install = dn <= SMALL_PIPE_DN
            ? t('Pipe too small for a straight insertion: mount in an elbow against the flow, or widen the pipe to DN 80 at the measuring point')
            : t('Mount at 45° against the flow, or in an elbow, to get enough immersion');
    }
    if (dn <= SMALL_PIPE_DN) immersion = minImmersion; // elbow mounting: the full minimum fits
    const insertion = nextUp(INSERTION_LENGTHS, immersion + NECK_MM) || LONGEST_INSERTION;

    const thermowell = temp > 600
        ? t('Ceramic or Inconel® protection tube')
        : t('Machined thermowell, Ø 9–12 mm tip, 316L (or higher alloy)');
    const out = {
        variable: 'temperature',
        technology: 'temp-assembly',
        headline: t('{length} mm insertion length', { length: insertion }),
        summary: [
            [t('Pipe'), t('DN {dn} (OD {od} mm)', { dn, od })],
            [t('Immersion into the medium'), `≈ ${Math.round(immersion)} mm`],
            [t('Insertion length U (incl. ≈ 80 mm nozzle)'), `${insertion} mm`],
            [t('Installation'), install],
            [t('Sensor'), temperatureSensor(temp, t)],
            [t('Thermowell'), thermowell],
        ],
        notes: [],
    };
    const wakeLimit = gas ? WAKE_VELOCITY_LIMIT.gas : WAKE_VELOCITY_LIMIT.liquid;
    if (velocity !== null && velocity > wakeLimit) {
        out.notes.push(t('At {velocity} m/s a wake-frequency calculation (ASME PTC 19.3 TW) is required, and our engineers will do it.', { velocity }));
    } else {
        out.notes.push(t('Our engineers check the thermowell strength (ASME PTC 19.3 TW) against flow velocity and pressure.'));
    }
    out.notes.push(t('Add a temperature transmitter (4–20 mA / HART) in the head or on a DIN rail.'));
    return out;
}

// ---------- Analysis sizing (pH / conductivity) ----------
const GLASS_PH_MAX_TEMP = 135;
const STANDARD_ASSEMBLY_MAX_BAR = 16;
// Retractable assemblies need at least DN 80; below DN 50 the pipe is too small for any assembly.
const BYPASS_BELOW_DN = 50;
const RETRACTABLE_FROM_DN = 80;

/** Assembly for the pipe size and whether the sensor must be cleaned during operation: [assembly, headline, installation]. */
function analysisAssembly(dn, cleaning) {
    if (dn < BYPASS_BELOW_DN) {
        return [
            'Flow-through assembly in a bypass',
            'Flow-through assembly in a bypass',
            'Bypass line with shut-off valves, so the sensor can be removed without stopping the process',
        ];
    }
    if (dn < RETRACTABLE_FROM_DN) {
        if (cleaning) {
            return [
                'Retractable assembly in a bypass',
                'Retractable assembly in a bypass',
                'Bypass line, or widen the pipe to DN 80 at the measuring point (retractable assemblies need DN 80+)',
            ];
        }
        return [
            'Fixed (immersion) assembly with a 25 mm (1") pipe connection',
            'Fixed',
            'Inline in the pipe, sensor tip in the flow',
        ];
    }
    if (cleaning) {
        return [
            'Retractable assembly (sensor can be removed / cleaned while the process runs)',
            'Retractable assembly',
            'Directly in the main pipe',
        ];
    }
    return [
        'Fixed assembly or retractable assembly with DN 25 / 1½" connection',
        'Fixed assembly or retractable assembly with DN 25 / 1½" connection',
        'Directly in the main pipe',
    ];
}

/** Liquid analysis: how to install the sensor for the pipe size. */
function sizeAnalysis(input) {
    const t = translator(input.lang);
    const dn = num(input.pipeDn);
    const temp = num(input.temperature);
    const pressure = num(input.pressure);
    const cleaning = Boolean(input.cleaning);
    if (!PIPE_OD[dn]) return { error: t('Please choose a pipe size.') };

    const [assembly, headline, install] = analysisAssembly(dn, cleaning).map((s) => t(s));
    const out = {
        variable: 'analysis',
        technology: 'ph-conductivity',
        headline,
        summary: [
            [t('Pipe'), `DN ${dn}`],
            [t('Recommended assembly'), assembly],
            [t('Installation'), install],
            // Glass pH sensors hold an inner liquid and an air bubble: tilted, the bubble stays away from the glass.
            [t('Mounting angle (glass pH / ORP)'), t('At least 15° above horizontal, never upside down')],
            [t('Flow velocity at the sensor'), t('Ideally 0.1–1 m/s (pH), max. ≈ 2 m/s')],
        ],
        notes: [],
    };
    if (temp !== null && temp > GLASS_PH_MAX_TEMP) {
        out.notes.push(t('Glass pH sensors are limited to about 135 °C; at {temp} °C cool the sample (sample conditioning).', { temp }));
    }
    if (pressure !== null && pressure > STANDARD_ASSEMBLY_MAX_BAR) {
        out.notes.push(t('At {pressure} bar use a high-pressure assembly or reduce the pressure in the bypass.', { pressure }));
    }
    out.notes.push(t('Conductivity: inductive (toroidal) sensors for dirty or high-conductivity media, conductive sensors for clean water.'));
    return out;
}

// ---------- Entry points ----------
/**
 * Size one technology with the Applicator inputs. Returns null when the technology has no sizing
 * or the sizing values were left empty (sizing is optional).
 */
function sizeFor(tech, input) {
    const medium = String(input.medium || 'liquid');
    const { lang } = input;
    if (VELOCITY[tech] && isFilled(input.flow)) {
        return sizeFlowmeter({ lang, technology: tech, medium, flow: input.flow, pipeDn: input.pipeDn });
    }
    if (LEVEL_TECHNOLOGIES.includes(tech) && isFilled(input.height)) {
        return sizeLevel({
            lang,
            technology: tech,
            medium: medium === 'solid' ? 'solid' : 'liquid',
            height: input.height,
            nozzle: isFilled(input.nozzle) ? input.nozzle : null,
            density: isFilled(input.density) ? input.density : null,
        });
    }
    if (tech === 'pressure-transmitter' && isFilled(input.pressure)) {
        // Below 1 bar(g) the process is near vacuum, so an absolute sensor; at least 0.05 bar so the range is not 0.
        const pressure = num(input.pressure);
        return sizePressure({
            lang,
            type: pressure < 1 ? 'absolute' : 'gauge',
            maxPressure: Math.max(pressure, 0.05),
            medium,
            temperature: input.temperature,
        });
    }
    if (tech === 'dp-transmitter' && isFilled(input.dp)) {
        return sizePressure({
            lang,
            type: 'differential',
            maxPressure: input.dp,
            staticPressure: input.pressure,
            medium,
            temperature: input.temperature,
        });
    }
    if (['temp-assembly', 'temp-transmitter'].includes(tech) && isFilled(input.pipeDn)) {
        return sizeTemperature({
            lang,
            pipeDn: input.pipeDn,
            temperature: input.temperature,
            medium: medium === 'slurry' ? 'liquid' : medium, // a slurry transfers heat like a liquid
            velocity: isFilled(input.velocity) ? input.velocity : null,
        });
    }
    if (tech === 'ph-conductivity' && isFilled(input.pipeDn)) {
        return sizeAnalysis({
            lang,
            pipeDn: input.pipeDn,
            temperature: input.temperature,
            pressure: input.pressure,
            cleaning: input.cleaning,
        });
    }
    return null;
}

/** Applicator: ranked technologies for the conditions, each suitable one sized with the optional sizing values. */
function applicate(catalog, input) {
    const result = selectTechnology(catalog, input);
    if (result.error) return result;
    for (const product of result.suitable) {
        const sizing = sizeFor(product.id, input);
        if (sizing) product.sizing = sizing;
    }
    return result;
}

/** One entry point for sizing a single variable (API: /api/applicator/sizing). */
function size(input) {
    const variable = String(input.variable || 'flow');
    if (variable === 'flow') return sizeFlowmeter(input);
    if (variable === 'level') return sizeLevel(input);
    if (variable === 'pressure') return sizePressure(input);
    if (variable === 'temperature') return sizeTemperature(input);
    if (variable === 'analysis') return sizeAnalysis(input);
    return { error: translator(input.lang)('Please choose a measured variable.') };
}

module.exports = {
    selectTechnology,
    applicate,
    sizeFor,
    sizeFlowmeter,
    sizeLevel,
    sizePressure,
    sizeTemperature,
    sizeAnalysis,
    size,
    MEDIA,
    VARIABLES,
};
