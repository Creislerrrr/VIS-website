/**
 * server.js — the VIS website backend: a zero-dependency Node.js (18+) HTTP server.
 *
 * Start: `node backend/server.js` (env: PORT, default 3000 · HOST, default 127.0.0.1 · ADMIN_TOKEN for /api/inquiries).
 *
 * What it does:
 *  - serves the static site from ../frontend (index.html, js/, css/, images/, i18n/);
 *  - GET  /api/catalog?lang=xx         the product catalog, translated (lib/i18n.js) and gzip-compressed;
 *  - POST /api/applicator/select       product selection ("Applicator"), see lib/applicator.js;
 *  - POST /api/applicator/sizing       sizing of one measured variable (flow, level, pressure …), see lib/applicator.js;
 *  - POST /api/contact                 validates a contact inquiry and appends it to data/inquiries.json;
 *  - GET  /api/inquiries               all stored inquiries (needs "Authorization: Bearer <ADMIN_TOKEN>");
 *  - GET  /api/health                  { ok: true }.
 *
 * Start-up flow: read the JSON files in data/ → merge them into one catalog → mark the products that need a valve
 * datasheet → build one translated + compressed catalog per language → listen.
 * Error and Applicator messages are English texts passed through the t() translator; the English text is the translation key
 * (see lib/i18n.js and tools/i18n-check.mjs).
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { applicate, size } = require('./lib/applicator');
const { LANGS, pickLang, translator, localizeCatalog } = require('./lib/i18n');

// ---------- Configuration ----------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.resolve(DATA_DIR, 'inquiries.json');
/** Token for GET /api/inquiries; empty = the endpoint is closed. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

/** Request body limits in bytes (the contact form can carry several valve datasheets, so it gets more room). */
const MAX_BODY = 20_000;
const MAX_CONTACT_BODY = 60_000;

// ---------- Catalog (built once at start-up) ----------
/** Reads and parses one JSON file from backend/data. */
const readData = (file) => JSON.parse(fs.readFileSync(path.resolve(DATA_DIR, file), 'utf8'));

/** One manufacturer portfolio file, every product tagged with its brand. */
const readPortfolio = (file, brand) => readData(file).map((product) => ({ ...product, brand }));

/** Base catalog: own product groups, categories, industries, FAQ, valve datasheet fields, ICSS texts. */
const CATALOG = readData('catalog.json');
// Texts for the product details window (product lines, product types, categories).
CATALOG.info = readData('product-info.json');

// Manufacturer portfolios shown in the product finder: Emerson (lead brand) first, then Endress+Hauser.
// icss-products.json: DeltaV, AMS and FIELDVUE products from the ICSS specification (kept separate, because
// emerson-products.json is regenerated from the Emerson sitemap by tools/build-emerson-catalog.py).
const ICSS = readPortfolio('icss-products.json', 'Emerson');
const EMERSON = [...readPortfolio('emerson-products.json', 'Emerson'), ...ICSS];

// E+H products are only offered where Emerson has no equivalent: an E+H product whose technology
// (Coriolis, radar, pH, …) Emerson also covers is left out. eh-products.json itself keeps the full portfolio.
const EMERSON_TECH = new Set(EMERSON.map((product) => product.tech).filter(Boolean));
const EH_ONLY = readPortfolio('eh-products.json', 'Endress+Hauser')
    .filter((product) => !product.tech || !EMERSON_TECH.has(product.tech));
// The key is called "eh" for historical reasons; it holds the whole manufacturer portfolio (Emerson + E+H).
CATALOG.eh = [...EMERSON, ...EH_ONLY];

/** Own product groups + manufacturer portfolio, i.e. everything a visitor can put on the inquiry list. */
const ALL_PRODUCTS = [...CATALOG.products, ...CATALOG.eh];
const PRODUCT_IDS = new Set(ALL_PRODUCTS.map((product) => product.id));

// ---------- Valve datasheets ----------
// Valves and actuators need a valve datasheet (fields: CATALOG.valveDatasheet) with every inquiry.
// Not needed for services, spare parts, software and positioners in the same category.
const NO_DATASHEET = new RegExp([
    '(^|\\s)var\\s', 'act automation', 'controlinc', 'valvelink', 'recycle', 'fluid systems modules',
    'generic parts', 'gearboxes', 'positioner', 'valve controller',
].join('|'), 'i');

/** True if an inquiry for this product must come with a valve datasheet. */
function needsDatasheet(product) {
    if (product.id === 'valve-positioner') return true;
    return product.category === 'valves'
        && Boolean(product.url)
        && !NO_DATASHEET.test(`${product.name} ${product.type}`);
}

// The browser reads the flag from the catalog to show the datasheet form.
ALL_PRODUCTS.forEach((product) => { if (needsDatasheet(product)) product.datasheet = true; });
const DATASHEET_IDS = new Set(ALL_PRODUCTS.filter((product) => product.datasheet).map((product) => product.id));

// ---------- Translated catalogs ----------
// One catalog per language (texts translated, see lib/i18n.js). It is ~250 KB, so it is served pre-compressed.
// Only our own portfolio items (ICSS) get their descriptions translated; manufacturer texts stay English.
const OWN_IDS = new Set(ICSS.map((product) => product.id));

/** lang → { catalog (object), json (Buffer), gz (gzipped Buffer) }. */
const LOCAL = Object.fromEntries(LANGS.map((lang) => {
    const catalog = lang === 'en' ? CATALOG : localizeCatalog(CATALOG, translator(lang), OWN_IDS);
    const json = Buffer.from(JSON.stringify(catalog));
    return [lang, { catalog, json, gz: zlib.gzipSync(json) }];
}));

// ---------- HTTP helpers ----------
/** Content types of the static files, by file extension. */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

/** Sends body as a JSON answer with the given status code. */
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** Reads the whole request body as text; throws an error with status 413 if it is longer than limit bytes. */
async function readBody(req, limit = MAX_BODY) {
    let received = 0;
    const chunks = [];
    for await (const chunk of req) {
        received += chunk.length;
        if (received > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads and parses a JSON request body → { body } or, after an error answer was already sent, { failed: true }.
 * Too large → 413 'Payload too large', not JSON → 400 'Invalid JSON'.
 */
async function readJsonBody(req, res, limit) {
    try {
        return { body: JSON.parse(await readBody(req, limit)) };
    } catch (err) {
        sendJson(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
        return { failed: true };
    }
}

// ---------- Inquiry storage (data/inquiries.json) ----------
/** All stored inquiries (an empty list before the first one). */
async function loadInquiries() {
    try {
        return JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

let writeQueue = Promise.resolve();

/** Appends one inquiry to the file. */
function saveInquiry(entry) {
    // Serialize writes so concurrent submissions don't clobber each other.
    writeQueue = writeQueue.then(async () => {
        const all = await loadInquiries();
        all.push(entry);
        await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
        // Write to a temp file and rename: a crash mid-write never leaves a half-written inquiries.json.
        await fsp.writeFile(DATA_FILE + '.tmp', JSON.stringify(all, null, 2));
        await fsp.rename(DATA_FILE + '.tmp', DATA_FILE);
    });
    return writeQueue;
}

// ---------- Contact form validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Max. length of each contact field (longer input is cut off, not rejected). */
const MAX_LEN = { name: 120, company: 160, email: 200, message: 5000, project: 160, tagNo: 120 };
/** Inquiry list limits: at most 50 lines, quantity 1…999 per line. */
const MAX_ITEMS = 50;
const MAX_QTY = 999;

/** A trimmed string of at most max characters; anything that is not a string becomes ''. */
const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Checks one valve datasheet against the field definitions in catalog.json → { datasheet } or { error }.
 * catalog / t: the visitor's language (field labels and messages).
 */
function validateDatasheet(raw, productName, catalog, t) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const field of catalog.valveDatasheet.fields) {
        const value = input[field.id];
        const vars = { product: productName, field: field.label };
        const empty = value === undefined || value === null || String(value).trim() === '';
        if (empty) {
            if (field.required) return { error: t('Valve datasheet for {product}: please enter “{field}”.', vars) };
            continue;
        }
        if (field.type === 'number') {
            const number = Number(value);
            if (!Number.isFinite(number) || number < field.min || number > field.max) {
                return { error: t('Valve datasheet for {product}: “{field}” must be between {min} and {max} {unit}.',
                    { ...vars, min: field.min, max: field.max, unit: field.unit }) };
            }
            out[field.id] = number;
        } else if (field.type === 'choice') {
            if (!field.options.some(([optionValue]) => optionValue === value)) {
                return { error: t('Valve datasheet for {product}: please choose “{field}”.', vars) };
            }
            out[field.id] = value;
        } else {
            out[field.id] = clean(String(value), field.max);
        }
    }
    if (out.outletPressure > out.inletPressure) {
        return { error: t('Valve datasheet for {product}: the outlet pressure cannot be higher than the inlet pressure.',
            { product: productName }) };
    }
    return { datasheet: out };
}

/**
 * One line of the inquiry list, cleaned up: { id, qty, tag, tagNo, datasheet? }.
 * tag: the customer wants a tag / reference number on the device. The datasheet is only kept (still unchecked)
 * for products that need one.
 */
function cleanItem(item) {
    const qty = Math.min(MAX_QTY, Math.max(1, parseInt(item.qty, 10) || 1));
    const wantsTag = item.tag === true;
    return {
        id: item.id,
        qty,
        tag: wantsTag,
        tagNo: wantsTag ? clean(item.tagNo, MAX_LEN.tagNo) : '',
        ...(DATASHEET_IDS.has(item.id) && { datasheet: item.datasheet }),
    };
}

/** Checks a contact form submission → { data } (cleaned inquiry) or { error } (message in the visitor's language). */
function validate(body) {
    const t = translator(body.lang);
    const { catalog } = LOCAL[pickLang(body.lang)];
    const data = {
        name: clean(body.name, MAX_LEN.name),
        company: clean(body.company, MAX_LEN.company),
        email: clean(body.email, MAX_LEN.email),
        message: clean(body.message, MAX_LEN.message),
        project: clean(body.project, MAX_LEN.project), // optional project name / reference
        lang: pickLang(body.lang), // the visitor's language, so the reply can be in it
    };
    if (!data.name || !data.company || !data.email || !data.message) return { error: t('Please fill in all fields.') };
    if (!EMAIL_RE.test(data.email)) return { error: t('Please enter a valid email address.') };

    // Optional inquiry list: only known products are kept.
    data.items = (Array.isArray(body.items) ? body.items : [])
        .filter((item) => item && PRODUCT_IDS.has(item.id))
        .slice(0, MAX_ITEMS)
        .map(cleanItem);

    for (const item of data.items.filter((i) => 'datasheet' in i)) {
        // Product name in the visitor's language, for the error message.
        const name = [...catalog.products, ...catalog.eh].find((product) => product.id === item.id).name;
        const { error, datasheet } = validateDatasheet(item.datasheet, name, catalog, t);
        if (error) return { error };
        item.datasheet = datasheet;
    }
    return { data };
}

// ---------- API handlers ----------
/** POST /api/contact: validate, store, log → 201 { ok, id } or 422 { error }. */
async function handleContact(req, res) {
    const { body, failed } = await readJsonBody(req, res, MAX_CONTACT_BODY);
    if (failed) return;
    // Honeypot: the hidden "website" field is only filled in by bots; pretend success and drop it.
    if (body && body.website) return sendJson(res, 200, { ok: true });
    const { error, data } = validate(body || {});
    if (error) return sendJson(res, 422, { error });

    const entry = { id: Date.now().toString(36), receivedAt: new Date().toISOString(), ...data };
    await saveInquiry(entry);
    const project = entry.project ? ` project "${entry.project}"` : '';
    console.log(`[contact] ${entry.receivedAt} ${entry.name} <${entry.email}> (${entry.company})${project}`);
    sendJson(res, 201, { ok: true, id: entry.id });
}

/** Runs handler(body) on a JSON POST body and sends its result (422 if it has an error, else 200). */
async function handleJsonPost(req, res, handler) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const { body, failed } = await readJsonBody(req, res);
    if (failed) return;
    const result = handler(body || {});
    sendJson(res, result.error ? 422 : 200, result);
}

/** GET /api/catalog?lang=xx: the pre-built catalog, gzipped if the browser accepts it. */
function handleCatalog(req, res, searchParams) {
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const local = LOCAL[pickLang(searchParams.get('lang'))];
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Vary: 'Accept-Encoding',
        ...(acceptsGzip && { 'Content-Encoding': 'gzip' }),
    });
    res.end(acceptsGzip ? local.gz : local.json);
}

// ---------- Static files ----------
/** Sends a file from ../frontend (403 outside of it, 404 if missing). */
async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(FRONTEND, '.' + rel);
    // Block "../" tricks: the resolved path must stay inside the frontend folder.
    if (!file.startsWith(FRONTEND + path.sep)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) throw new Error();
        // Always revalidate, so a changed file is picked up on the next reload (304 when unchanged).
        const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag });
            return res.end();
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
            ETag: etag,
            'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    try {
        if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
        if (pathname === '/api/catalog') return handleCatalog(req, res, searchParams);
        if (pathname === '/api/applicator/select') {
            return await handleJsonPost(req, res, (body) => applicate(LOCAL[pickLang(body.lang)].catalog, body));
        }
        if (pathname === '/api/applicator/sizing') return await handleJsonPost(req, res, size);
        if (pathname === '/api/contact') {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
            return await handleContact(req, res);
        }
        if (pathname === '/api/inquiries') {
            const authorized = ADMIN_TOKEN && req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
            if (!authorized) return sendJson(res, 401, { error: 'Unauthorized' });
            return sendJson(res, 200, await loadInquiries());
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
        await serveStatic(req, res, pathname);
    } catch (err) {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    }
});

server.listen(PORT, HOST, () => console.log(`VIS website running at http://${HOST}:${PORT}`));
