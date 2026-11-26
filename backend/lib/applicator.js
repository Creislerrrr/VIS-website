// VIS Applicator — technology selection and sizing (flow, level, pressure, temperature, analysis).
// Pure functions, no I/O, so they are easy to test.
// Texts: t('English text with {placeholders}', vars) in the language of input.lang (see lib/i18n.js).
// Write whole sentences (no words glued into a sentence), so they can be translated with correct grammar.
const { translator } = require('./i18n');

const MEDIA = ['liquid', 'gas', 'steam', 'slurry', 'solid'];
const VARIABLES = ['flow', 'level', 'pressure', 'temperature', 'analysis'];

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/**
 * Rank all products of one measured variable against the process conditions.
 * Returns { suitable: [...], unsuitable: [...] } — every product with reasons.
 */
function selectTechnology(catalog, input) {
    const t = translator(input.lang);
    const variable = String(input.variable || '');
    const medium = String(input.medium || '');
    if (!VARIABLES.includes(variable)) return { error: t('Please choose a measured variable.') };
    if (!MEDIA.includes(medium)) return { error: t('Please choose a medium.') };

    const temp = num(input.temperature);
    const pressure = num(input.pressure);
    const conductivity = num(input.conductivity);
    const notNumber = { temperature: 'Temperature must be a number.', pressure: 'Pressure must be a number.', conductivity: 'Conductivity must be a number.' };
    for (const [key, v] of [['temperature', temp], ['pressure', pressure], ['conductivity', conductivity]]) {
        if (v !== null && !Number.isFinite(v)) return { error: t(notNumber[key]) };
    }
    if (pressure !== null && pressure < -1) return { error: t('Pressure cannot be below −1 bar (vacuum).') };
    const ex = Boolean(input.ex);
    const hygienic = Boolean(input.hygienic);
    const notFor = { liquid: 'Not designed for liquid.', gas: 'Not designed for gas.', steam: 'Not designed for steam.', slurry: 'Not designed for slurry.', solid: 'Not designed for solid.' };

    const suitable = [];
    const unsuitable = [];

    for (const p of catalog.products.filter((x) => x.category === variable)) {
        const fails = [];
        const notes = [];
        let score = 100;

        if (!p.media.includes(medium)) fails.push(t(notFor[medium]));
        if (temp !== null && p.tempMax != null) {
            if (temp > p.tempMax) fails.push(t('Process temperature {temp} °C exceeds max. {max} °C.', { temp, max: p.tempMax }));
            else if (temp > p.tempMax * 0.85) { score -= 15; notes.push(t('Close to the temperature limit ({max} °C).', { max: p.tempMax })); }
        }
        if (pressure !== null && p.pressureMax != null) {
            if (pressure > p.pressureMax) fails.push(t('Process pressure {pressure} bar exceeds max. {max} bar.', { pressure, max: p.pressureMax }));
            else if (pressure > p.pressureMax * 0.85) { score -= 15; notes.push(t('Close to the pressure limit ({max} bar).', { max: p.pressureMax })); }
        }
        if (ex && !p.ex) fails.push(t('No hazardous-area (Ex) approval.'));
        if (hygienic && !p.hygienic) fails.push(t('No hygienic design (3-A / EHEDG).'));
        if (p.minConductivity != null && ['liquid', 'slurry'].includes(medium)) {
            if (conductivity === null) notes.push(t('Requires a conductivity of at least {min} µS/cm.', { min: p.minConductivity }));
            else if (conductivity < p.minConductivity) fails.push(t('Conductivity {value} µS/cm is below the min. {min} µS/cm.', { value: conductivity, min: p.minConductivity }));
        }

        // Prefer more accurate devices and those that suit the medium especially well.
        if (p.accuracy != null && (!p.accuracyUnit || p.accuracyUnit === '%')) score += Math.max(0, 10 - p.accuracy * 10);
        if (medium === 'steam' && p.id === 'vortex') { score += 15; notes.push(t('Preferred technology for steam.')); }
        if (medium === 'slurry' && p.id === 'electromagnetic') { score += 10; notes.push(t('Handles abrasive slurries well.')); }
        if (medium === 'gas' && p.id === 'coriolis') notes.push(t('For gases, check the minimum mass flow.'));

        const entry = {
            id: p.id, name: p.name, principle: p.principle, highlights: p.highlights,
            brands: p.brands, accuracy: p.accuracy, accuracyUnit: p.accuracyUnit || '%',
            tempMax: p.tempMax, pressureMax: p.pressureMax,
        };
        if (fails.length) unsuitable.push({ ...entry, reasons: fails });
        else suitable.push({ ...entry, score: Math.round(Math.max(0, Math.min(score, 120)) / 1.2), notes });
    }

    suitable.sort((a, b) => b.score - a.score);
    return { suitable, unsuitable };
}

// Recommended flow-velocity windows in m/s (typical manufacturer guidance).
const VELOCITY = {
    electromagnetic: { liquid: { min: 0.3, max: 10, optMin: 1, optMax: 3 }, slurry: { min: 1, max: 5, optMin: 1.5, optMax: 3 } },
    vortex: { liquid: { min: 0.3, max: 9, optMin: 1, optMax: 5 }, gas: { min: 3, max: 75, optMin: 10, optMax: 40 }, steam: { min: 3, max: 75, optMin: 10, optMax: 40 } },
    'ultrasonic-flow': { liquid: { min: 0.1, max: 12, optMin: 1, optMax: 5 }, gas: { min: 0.5, max: 40, optMin: 5, optMax: 25 } },
    coriolis: { liquid: { min: 0.2, max: 8, optMin: 1, optMax: 4 }, slurry: { min: 0.5, max: 4, optMin: 1, optMax: 3 }, gas: { min: 1, max: 60, optMin: 5, optMax: 30 } },
    'thermal-mass': { gas: { min: 0.5, max: 100, optMin: 5, optMax: 40 } },
};
const DN = [15, 25, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 500, 600, 800, 1000];

/** Flow velocity for every standard nominal diameter, with a recommended DN (and a check of the existing pipe). */
function sizeFlowmeter(input) {
    const t = translator(input.lang);
    const technology = String(input.technology || '');
    const medium = String(input.medium || '');
    const flow = num(input.flow);
    const windows = VELOCITY[technology];
    if (!windows) return { error: t('Please choose a flow technology.') };
    const w = windows[medium];
    const notSized = { liquid: 'This technology is not sized for liquid. Choose another medium.', gas: 'This technology is not sized for gas. Choose another medium.',
        steam: 'This technology is not sized for steam. Choose another medium.', slurry: 'This technology is not sized for slurry. Choose another medium.',
        solid: 'This technology is not sized for solid. Choose another medium.' };
    if (!w) return { error: notSized[medium] ? t(notSized[medium]) : t('This technology is not sized for {medium}. Choose another medium.', { medium }) };
    if (flow === null || !Number.isFinite(flow) || flow <= 0) return { error: t('Please enter a flow rate greater than 0 m³/h.') };
    if (flow > 1e6) return { error: t('Flow rate is out of range.') };

    const rows = DN.map((dn) => {
        const area = Math.PI * (dn / 1000) ** 2 / 4;
        const v = flow / 3600 / area;
        let status = 'ok';
        if (v < w.min || v > w.max) status = 'out';
        else if (v >= w.optMin && v <= w.optMax) status = 'optimal';
        return { dn, velocity: Number(v.toPrecision(3)), status };
    });
    // Recommend the smallest DN in the optimal window (cheapest), else the closest valid one.
    const recommended = rows.find((r) => r.status === 'optimal') || rows.find((r) => r.status === 'ok') || null;
    const result = { variable: 'flow', technology, medium, flow, window: w, rows, recommended: recommended ? recommended.dn : null, notes: [] };
    // Existing pipe: velocity there, and whether the meter needs reducers.
    const pipe = num(input.pipeDn);
    if (pipe) {
        const row = rows.find((r) => r.dn === pipe);
        if (row) {
            result.pipe = row;
            const vars = { pipe, velocity: row.velocity, recommended: result.recommended };
            if (row.status === 'optimal') result.notes.push(t('Your DN {pipe} pipe is in the optimal range: the meter can have the same size as the pipe.', vars));
            else if (row.status === 'ok') result.notes.push(t('Your DN {pipe} pipe works ({velocity} m/s). DN {recommended} would give the best accuracy.', vars));
            else if (result.recommended && result.recommended < pipe) result.notes.push(t('Velocity in DN {pipe} is too low ({velocity} m/s): use a DN {recommended} meter with reducers (concentric, max. 8° cone angle).', vars));
            else if (result.recommended) result.notes.push(t('Velocity in DN {pipe} is too high ({velocity} m/s): a larger pipe and meter (DN {recommended}) are recommended.', vars));
        }
    }
    const runs = { electromagnetic: 'Straight pipe runs: 5 × DN upstream, 2 × DN downstream.', vortex: 'Straight pipe runs: 15 × DN upstream, 5 × DN downstream (more after bends and valves).',
        'ultrasonic-flow': 'Straight pipe runs: 10 × DN upstream, 5 × DN downstream.', coriolis: 'Straight pipe runs: no straight runs needed.', 'thermal-mass': 'Straight pipe runs: 15 × DN upstream, 5 × DN downstream.' };
    result.notes.push(t(runs[technology]));
    return result;
}

// ---------- Sizing for the other measured variables ----------
const round = (v, d = 2) => Number(v.toFixed(d));
const nextUp = (list, v) => list.find((x) => x >= v) ?? null;
// Error for a required positive value: `empty` when missing / ≤ 0, `tooBig` (with {max}) above max.
const positive = (v, max, empty, tooBig) => {
    if (v === null || !Number.isFinite(v) || v <= 0) return empty;
    if (max && v > max) return tooBig;
    return null;
};
const pressureLabel = (bar) => (bar >= 1000 ? `${bar / 1000} bar` : `${bar} mbar`);

/** Level: measuring range, antenna / nozzle size, probe length or hydrostatic sensor range for a tank. */
function sizeLevel(input) {
    const t = translator(input.lang);
    const technology = String(input.technology || 'radar-level');
    const medium = input.medium === 'solid' ? 'solid' : 'liquid';
    const height = num(input.height);
    const density = num(input.density) ?? 1000;
    const nozzle = num(input.nozzle) ?? 0.2;
    const err = positive(height, 150, t('Please enter a tank height in m greater than 0.'), t('A tank height in m is out of range (max. {max}).', { max: 150 }));
    if (err) return { error: err };
    if (!Number.isFinite(density) || density < 100 || density > 25000) return { error: t('Density must be between 100 and 25,000 kg/m³.') };
    if (!Number.isFinite(nozzle) || nozzle < 0 || nozzle > 5) return { error: t('Nozzle height must be between 0 and 5 m.') };

    const range = height + nozzle; // from the flange to the tank bottom
    const out = { variable: 'level', technology, medium, summary: [[t('Tank height'), `${height} m`], [t('Measuring distance (flange → bottom)'), `${round(range)} m`]], notes: [] };
    const outOfRange = t('Out of range');

    if (technology === 'radar-level') {
        if (range > 120) return { ...out, headline: outOfRange, fail: t('Radar measures up to 120 m.') };
        const antenna = medium === 'liquid' ? (range <= 10 ? 50 : range <= 30 ? 80 : 100) : (range <= 15 ? 80 : 100);
        out.headline = t('{range} m range · DN {antenna} antenna', { range: Math.ceil(range), antenna });
        out.summary.push([t('Recommended antenna / nozzle'), `DN ${antenna} (${{ 50: '2"', 80: '3"', 100: '4"' }[antenna]})`],
            [t('Max. nozzle length'), antenna === 50 ? '≈ 0.5 m' : t('≈ 1 m (80 GHz, narrow beam)')]);
        out.notes.push(t('80 GHz radar: narrow beam, mount away from inlets, agitators and the tank wall (≥ 0.3 m).'));
        if (medium === 'solid') out.notes.push(t('Bulk solids: a larger antenna and an air purge connection help with dust.'));
    } else if (technology === 'guided-radar') {
        const probe = round(height + nozzle - 0.05);
        let type = t('Rod probe (Ø 8–16 mm)');
        if (probe > 4 || medium === 'solid') type = medium === 'solid' ? t('Cable probe (Ø 4–8 mm, tensile load!)') : t('Cable probe (Ø 4 mm) with weight');
        if (probe > 45) return { ...out, headline: outOfRange, fail: t('Guided radar probes are available up to 45 m. Use non-contact radar.') };
        out.headline = t('{probe} m probe', { probe });
        out.summary.push([t('Probe length'), t('{probe} m (ends ≈ 50 mm above the bottom)', { probe })], [t('Probe type'), type], [t('Nozzle'), t('DN 50 / 2" or larger, nozzle height ≤ nozzle diameter')]);
        out.notes.push(t('Coaxial probes for low-dielectric media (εr < 1.6) and interface measurement.'));
        if (medium === 'solid') out.notes.push(t('Check the tensile load on the cable probe (silo height, product, flow).'));
    } else if (technology === 'hydrostatic-level') {
        if (medium === 'solid') return { error: t('Hydrostatic level works for liquids only.') };
        const mbar = density * 9.81 * height / 100;
        const RANGES = [100, 250, 400, 1000, 2000, 4000, 10000, 40000];
        const sensor = nextUp(RANGES, mbar);
        if (!sensor) return { ...out, headline: outOfRange, fail: t('The hydrostatic pressure exceeds 40 bar.') };
        out.headline = t('{range} sensor', { range: pressureLabel(sensor) });
        out.summary.push([t('Density'), `${density} kg/m³`], [t('Hydrostatic pressure at full tank'), `${round(mbar, 0)} mbar`],
            [t('Recommended sensor range'), `0 … ${pressureLabel(sensor)}`], [t('Turndown used'), `${round(sensor / mbar, 1)} : 1`]);
        out.notes.push(t('Closed, pressurised tanks: use a differential pressure (DP) transmitter or electronic DP to cancel the head pressure.'));
        if (density !== 1000) out.notes.push(t('If the density changes, the level reading changes with it.'));
    } else if (technology === 'ultrasonic-level') {
        const max = medium === 'liquid' ? 20 : 10;
        if (range > max) {
            return { ...out, headline: outOfRange, fail: medium === 'liquid'
                ? t('Ultrasonic sensors measure up to about {max} m in liquids. Use radar.', { max })
                : t('Ultrasonic sensors measure up to about {max} m in bulk solids. Use radar.', { max }) };
        }
        const block = range <= 5 ? 0.25 : range <= 8 ? 0.35 : 0.6;
        out.headline = t('{range} m range', { range: Math.ceil(range) });
        out.summary.push([t('Blocking distance'), `${block} m`], [t('Mounting'), t('Max. level at least {block} m below the sensor', { block })]);
        out.notes.push(t('Avoid foam, heavy vapour and strong dust; these weaken the echo.'));
    } else return { error: t('Please choose a level technology.') };
    return out;
}

/** Pressure: sensor range, calibrated span and turndown for the operating pressure. */
function sizePressure(input) {
    const t = translator(input.lang);
    const type = ['gauge', 'absolute', 'differential'].includes(input.type) ? input.type : 'gauge';
    const max = num(input.maxPressure);
    const temp = num(input.temperature);
    const medium = String(input.medium || 'liquid');
    const err = type === 'differential'
        ? positive(max, 40000, t('Please enter a max. differential pressure in mbar greater than 0.'), t('A max. differential pressure in mbar is out of range (max. {max}).', { max: 40000 }))
        : positive(max, 1000, t('Please enter a max. operating pressure in bar greater than 0.'), t('A max. operating pressure in bar is out of range (max. {max}).', { max: 1000 }));
    if (err) return { error: err };
    const unit = type === 'differential' ? 'mbar' : 'bar';
    const RANGES = type === 'differential' ? [10, 30, 100, 500, 3000, 16000, 40000] : [0.1, 0.4, 1, 2, 4, 10, 40, 100, 160, 400, 700];
    // Run at no more than ~80 % of the sensor's upper range limit.
    const sensor = nextUp(RANGES, max * 1.25);
    if (!sensor) return { error: t('The pressure is above the largest standard range ({max} {unit}).', { max: RANGES.at(-1), unit }) };
    const span = Number((max * 1.25).toPrecision(2));
    const out = { variable: 'pressure', technology: type === 'differential' ? 'dp-transmitter' : 'pressure-transmitter', headline: t('0 … {sensor} {unit} sensor', { sensor, unit }),
        summary: [[t('Measurement'), t({ gauge: 'Gauge pressure', absolute: 'Absolute pressure', differential: 'Differential pressure' }[type])],
            [t('Max. operating pressure'), `${max} ${unit}`], [t('Recommended sensor (URL)'), `0 … ${sensor} ${unit}`],
            [t('Calibrated span'), `0 … ${Math.min(span, sensor)} ${unit}`], [t('Turndown'), `${round(sensor / Math.min(span, sensor), 1)} : 1`]], notes: [] };
    if (type === 'absolute' && max < 1.5) out.notes.push(t('Close to vacuum: an absolute (not gauge) sensor is the right choice.'));
    if (type === 'differential') {
        const stat = num(input.staticPressure);
        if (stat) out.summary.push([t('Static pressure'), t('{stat} bar → choose a {rating} bar static rating', { stat, rating: stat > 250 ? '420' : stat > 160 ? '250' : '160' })]);
        out.notes.push(t('Use a 3- or 5-valve manifold for zeroing and isolation.'));
    }
    if (medium === 'steam') out.notes.push(t('Steam: mount with a siphon (pigtail) or a filled impulse line to protect the sensor.'));
    else if (temp !== null && temp > 120) out.notes.push(t('At {temp} °C use a diaphragm seal with capillary or a temperature isolator.', { temp }));
    if (medium === 'slurry') out.notes.push(t('Slurries / viscous media: use a flush diaphragm or a diaphragm seal.'));
    return out;
}

/** Temperature: insertion length for the pipe, thermowell and sensor type. */
const PIPE_OD = { 15: 21.3, 25: 33.7, 40: 48.3, 50: 60.3, 65: 76.1, 80: 88.9, 100: 114.3, 125: 139.7, 150: 168.3, 200: 219.1, 250: 273, 300: 323.9, 350: 355.6, 400: 406.4, 500: 508, 600: 610 };
function sizeTemperature(input) {
    const t = translator(input.lang);
    const dn = num(input.pipeDn);
    const temp = num(input.temperature);
    const velocity = num(input.velocity);
    const medium = String(input.medium || 'liquid');
    if (!PIPE_OD[dn]) return { error: t('Please choose a pipe size.') };
    if (temp === null || !Number.isFinite(temp) || temp < -200 || temp > 1700) return { error: t('Please enter a process temperature between −200 and 1700 °C.') };

    const gas = ['gas', 'steam'].includes(medium);
    const minImmersion = (gas ? 15 : 10) * 9; // ~9 mm thermowell tip: 10 × Ø in liquids, 15 × Ø in gases
    const neck = 80; // neck / nozzle height above the pipe wall
    const toCentre = PIPE_OD[dn] / 2;
    let install = t('Straight pipe, 90° to the flow, tip in the pipe centre (to 1/3 of the pipe diameter)');
    let immersion = Math.max(toCentre, Math.min(minImmersion, PIPE_OD[dn] * 0.66));
    if (immersion < minImmersion) {
        install = dn <= 50
            ? t('Pipe too small for a straight insertion: mount in an elbow against the flow, or widen the pipe to DN 80 at the measuring point')
            : t('Mount at 45° against the flow, or in an elbow, to get enough immersion');
    }
    if (dn <= 50) immersion = minImmersion;
    const LENGTHS = [50, 70, 100, 115, 160, 225, 250, 315, 400, 500];
    const U = nextUp(LENGTHS, immersion + neck) || 500;

    const sensor = temp <= 400 ? t('Pt100 RTD (thin film), class A') : temp <= 600 ? t('Pt100 RTD (wire-wound)') : temp <= 1100 ? t('Thermocouple type K or N') : t('Thermocouple type S / R / B (noble metal)');
    const out = { variable: 'temperature', technology: 'temp-assembly', headline: t('{length} mm insertion length', { length: U }),
        summary: [[t('Pipe'), t('DN {dn} (OD {od} mm)', { dn, od: PIPE_OD[dn] })], [t('Immersion into the medium'), `≈ ${Math.round(immersion)} mm`],
            [t('Insertion length U (incl. ≈ 80 mm nozzle)'), `${U} mm`], [t('Installation'), install], [t('Sensor'), sensor],
            [t('Thermowell'), temp > 600 ? t('Ceramic or Inconel® protection tube') : t('Machined thermowell, Ø 9–12 mm tip, 316L (or higher alloy)')]], notes: [] };
    if (velocity !== null && velocity > (gas ? 25 : 3)) out.notes.push(t('At {velocity} m/s a wake-frequency calculation (ASME PTC 19.3 TW) is required, and our engineers will do it.', { velocity }));
    else out.notes.push(t('Our engineers check the thermowell strength (ASME PTC 19.3 TW) against flow velocity and pressure.'));
    out.notes.push(t('Add a temperature transmitter (4–20 mA / HART) in the head or on a DIN rail.'));
    return out;
}

/** Liquid analysis: how to install the sensor for the pipe size. */
function sizeAnalysis(input) {
    const t = translator(input.lang);
    const dn = num(input.pipeDn);
    const temp = num(input.temperature);
    const pressure = num(input.pressure);
    const cleaning = Boolean(input.cleaning);
    if (!PIPE_OD[dn]) return { error: t('Please choose a pipe size.') };
    // [assembly, short headline, installation]
    let a;
    if (dn < 50) a = ['Flow-through assembly in a bypass', 'Flow-through assembly in a bypass', 'Bypass line with shut-off valves, so the sensor can be removed without stopping the process'];
    else if (dn < 80) a = ['Fixed (immersion) assembly with a 25 mm (1") pipe connection', 'Fixed', 'Inline in the pipe, sensor tip in the flow'];
    else if (cleaning) a = ['Retractable assembly (sensor can be removed / cleaned while the process runs)', 'Retractable assembly', 'Directly in the main pipe'];
    else a = ['Fixed assembly or retractable assembly with DN 25 / 1½" connection', 'Fixed assembly or retractable assembly with DN 25 / 1½" connection', 'Directly in the main pipe'];
    if (cleaning && dn < 80 && dn >= 50) a = ['Retractable assembly in a bypass', 'Retractable assembly in a bypass', 'Bypass line, or widen the pipe to DN 80 at the measuring point (retractable assemblies need DN 80+)'];
    const [assembly, headline, install] = a.map((s) => t(s));
    const out = { variable: 'analysis', technology: 'ph-conductivity', headline,
        summary: [[t('Pipe'), `DN ${dn}`], [t('Recommended assembly'), assembly], [t('Installation'), install],
            [t('Mounting angle (glass pH / ORP)'), t('At least 15° above horizontal, never upside down')], [t('Flow velocity at the sensor'), t('Ideally 0.1–1 m/s (pH), max. ≈ 2 m/s')]], notes: [] };
    if (temp !== null && temp > 135) out.notes.push(t('Glass pH sensors are limited to about 135 °C; at {temp} °C cool the sample (sample conditioning).', { temp }));
    if (pressure !== null && pressure > 16) out.notes.push(t('At {pressure} bar use a high-pressure assembly or reduce the pressure in the bypass.', { pressure }));
    out.notes.push(t('Conductivity: inductive (toroidal) sensors for dirty or high-conductivity media, conductive sensors for clean water.'));
    return out;
}

/**
 * Size one technology with the Applicator inputs. Returns null when the technology has no sizing
 * or the sizing values were left empty (sizing is optional).
 */
function sizeFor(tech, input) {
    const medium = String(input.medium || 'liquid');
    const liquidLike = medium === 'slurry' ? 'liquid' : medium;
    const filled = (v) => v !== '' && v !== null && v !== undefined;
    const { lang } = input;
    let r = null;
    if (VELOCITY[tech] && filled(input.flow)) r = sizeFlowmeter({ lang, technology: tech, medium, flow: input.flow, pipeDn: input.pipeDn });
    else if (['radar-level', 'guided-radar', 'hydrostatic-level', 'ultrasonic-level'].includes(tech) && filled(input.height)) {
        r = sizeLevel({ lang, technology: tech, medium: medium === 'solid' ? 'solid' : 'liquid', height: input.height, nozzle: filled(input.nozzle) ? input.nozzle : null, density: filled(input.density) ? input.density : null });
    } else if (tech === 'pressure-transmitter' && filled(input.pressure)) {
        r = sizePressure({ lang, type: num(input.pressure) < 1 ? 'absolute' : 'gauge', maxPressure: Math.max(num(input.pressure), 0.05), medium, temperature: input.temperature });
    } else if (tech === 'dp-transmitter' && filled(input.dp)) {
        r = sizePressure({ lang, type: 'differential', maxPressure: input.dp, staticPressure: input.pressure, medium, temperature: input.temperature });
    } else if (['temp-assembly', 'temp-transmitter'].includes(tech) && filled(input.pipeDn)) {
        r = sizeTemperature({ lang, pipeDn: input.pipeDn, temperature: input.temperature, medium: liquidLike, velocity: filled(input.velocity) ? input.velocity : null });
    } else if (tech === 'ph-conductivity' && filled(input.pipeDn)) {
        r = sizeAnalysis({ lang, pipeDn: input.pipeDn, temperature: input.temperature, pressure: input.pressure, cleaning: input.cleaning });
    }
    return r;
}

/** Applicator: ranked technologies for the conditions, each suitable one sized with the optional sizing values. */
function applicate(catalog, input) {
    const result = selectTechnology(catalog, input);
    if (result.error) return result;
    for (const p of result.suitable) {
        const s = sizeFor(p.id, input);
        if (s) p.sizing = s;
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

module.exports = { selectTechnology, applicate, sizeFor, sizeFlowmeter, sizeLevel, sizePressure, sizeTemperature, sizeAnalysis, size, MEDIA, VARIABLES };
