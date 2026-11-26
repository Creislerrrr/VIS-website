// VIS website backend — zero-dependency Node.js server.
// Serves ../frontend and stores contact inquiries in data/inquiries.json.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { applicate, size } = require('./lib/applicator');
const { LANGS, pickLang, translator, localizeCatalog } = require('./lib/i18n');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
const DATA_FILE = path.resolve(__dirname, 'data', 'inquiries.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CATALOG = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data', 'catalog.json'), 'utf8'));
// Manufacturer portfolios shown in the product finder: Emerson (lead brand) first, then Endress+Hauser.
const readPortfolio = (file, brand) => JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data', file), 'utf8')).map((p) => ({ ...p, brand }));
// icss-products.json: DeltaV, AMS and FIELDVUE products from the ICSS specification (kept separate, because
// emerson-products.json is regenerated from the Emerson sitemap by tools/build-emerson-catalog.py).
const ICSS = readPortfolio('icss-products.json', 'Emerson');
const EMERSON = [...readPortfolio('emerson-products.json', 'Emerson'), ...ICSS];
// E+H products are only offered where Emerson has no equivalent: an E+H product whose technology
// (Coriolis, radar, pH, …) Emerson also covers is left out. eh-products.json itself keeps the full portfolio.
// Texts for the product details window (product lines, product types, categories).
CATALOG.info = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data', 'product-info.json'), 'utf8'));
const EMERSON_TECH = new Set(EMERSON.map((p) => p.tech).filter(Boolean));
CATALOG.eh = [...EMERSON, ...readPortfolio('eh-products.json', 'Endress+Hauser').filter((p) => !p.tech || !EMERSON_TECH.has(p.tech))];
const PRODUCT_IDS = new Set([...CATALOG.products, ...CATALOG.eh].map((p) => p.id));

// Valves and actuators need a valve datasheet (fields: CATALOG.valveDatasheet) with every inquiry.
// Not needed for services, spare parts, software and positioners in the same category.
const NO_DATASHEET = /(^|\s)var\s|act automation|controlinc|valvelink|recycle|fluid systems modules|generic parts|gearboxes|positioner|valve controller/i;
const needsDatasheet = (p) => p.id === 'valve-positioner' || (p.category === 'valves' && Boolean(p.url) && !NO_DATASHEET.test(`${p.name} ${p.type}`));
[...CATALOG.products, ...CATALOG.eh].forEach((p) => { if (needsDatasheet(p)) p.datasheet = true; });
const DATASHEET_IDS = new Set([...CATALOG.products, ...CATALOG.eh].filter((p) => p.datasheet).map((p) => p.id));
// One catalog per language (texts translated, see lib/i18n.js). It is ~250 KB, so it is served pre-compressed.
const OWN_IDS = new Set(ICSS.map((p) => p.id));
const LOCAL = Object.fromEntries(LANGS.map((lang) => {
    const catalog = lang === 'en' ? CATALOG : localizeCatalog(CATALOG, translator(lang), OWN_IDS);
    const json = Buffer.from(JSON.stringify(catalog));
    return [lang, { catalog, json, gz: zlib.gzipSync(json) }];
}));

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function readBody(req, limit = 20_000) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function loadInquiries() {
    try { return JSON.parse(await fsp.readFile(DATA_FILE, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

let writeQueue = Promise.resolve();
function saveInquiry(entry) {
    // Serialize writes so concurrent submissions don't clobber each other.
    writeQueue = writeQueue.then(async () => {
        const all = await loadInquiries();
        all.push(entry);
        await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
        await fsp.writeFile(DATA_FILE + '.tmp', JSON.stringify(all, null, 2));
        await fsp.rename(DATA_FILE + '.tmp', DATA_FILE);
    });
    return writeQueue;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Checks one valve datasheet against the field definitions in catalog.json → { datasheet } or { error }.
// catalog / t: the visitor's language (field labels and messages).
function validateDatasheet(raw, productName, catalog, t) {
    const ds = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const f of catalog.valveDatasheet.fields) {
        const v = ds[f.id];
        const empty = v === undefined || v === null || String(v).trim() === '';
        if (empty) {
            if (f.required) return { error: t('Valve datasheet for {product}: please enter “{field}”.', { product: productName, field: f.label }) };
            continue;
        }
        if (f.type === 'number') {
            const n = Number(v);
            if (!Number.isFinite(n) || n < f.min || n > f.max) return { error: t('Valve datasheet for {product}: “{field}” must be between {min} and {max} {unit}.', { product: productName, field: f.label, min: f.min, max: f.max, unit: f.unit }) };
            out[f.id] = n;
        } else if (f.type === 'choice') {
            if (!f.options.some(([value]) => value === v)) return { error: t('Valve datasheet for {product}: please choose “{field}”.', { product: productName, field: f.label }) };
            out[f.id] = v;
        } else {
            out[f.id] = clean(String(v), f.max);
        }
    }
    if (out.outletPressure > out.inletPressure) return { error: t('Valve datasheet for {product}: the outlet pressure cannot be higher than the inlet pressure.', { product: productName }) };
    return { datasheet: out };
}

function validate(b) {
    const t = translator(b.lang);
    const { catalog } = LOCAL[pickLang(b.lang)];
    const data = {
        name: clean(b.name, 120), company: clean(b.company, 160),
        email: clean(b.email, 200), message: clean(b.message, 5000),
        project: clean(b.project, 160), // optional project name / reference
        lang: pickLang(b.lang), // the visitor's language, so the reply can be in it
    };
    if (!data.name || !data.company || !data.email || !data.message) return { error: t('Please fill in all fields.') };
    if (!EMAIL_RE.test(data.email)) return { error: t('Please enter a valid email address.') };
    // Optional inquiry list: product ids with quantities and whether a tag / reference number is wanted; only known products are kept.
    data.items = (Array.isArray(b.items) ? b.items : [])
        .filter((i) => i && PRODUCT_IDS.has(i.id))
        .slice(0, 50)
        .map((i) => ({
            id: i.id, qty: Math.min(999, Math.max(1, parseInt(i.qty, 10) || 1)),
            tag: i.tag === true, tagNo: i.tag === true ? clean(i.tagNo, 120) : '',
            ...(DATASHEET_IDS.has(i.id) && { datasheet: i.datasheet }),
        }));
    for (const item of data.items.filter((i) => 'datasheet' in i)) {
        const name = [...catalog.products, ...catalog.eh].find((p) => p.id === item.id).name;
        const { error, datasheet } = validateDatasheet(item.datasheet, name, catalog, t);
        if (error) return { error };
        item.datasheet = datasheet;
    }
    return { data };
}

async function handleContact(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req, 60_000)); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON' }); }
    if (body && body.website) return sendJson(res, 200, { ok: true }); // honeypot: silently drop bots
    const { error, data } = validate(body || {});
    if (error) return sendJson(res, 422, { error });
    const entry = { id: Date.now().toString(36), receivedAt: new Date().toISOString(), ...data };
    await saveInquiry(entry);
    console.log(`[contact] ${entry.receivedAt} ${entry.name} <${entry.email}> (${entry.company})${entry.project ? ` project "${entry.project}"` : ''}`);
    sendJson(res, 201, { ok: true, id: entry.id });
}

async function handleJsonPost(req, res, fn) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON' }); }
    const result = fn(body || {});
    sendJson(res, result.error ? 422 : 200, result);
}

async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(FRONTEND, '.' + rel);
    if (!file.startsWith(FRONTEND + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) throw new Error();
        // Always revalidate, so a changed file is picked up on the next reload (304 when unchanged).
        const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
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
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    }
}

const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
        if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
        if (pathname === '/api/catalog') {
            const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
            const local = LOCAL[pickLang(new URL(req.url, 'http://localhost').searchParams.get('lang'))];
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(gz && { 'Content-Encoding': 'gzip' }) });
            return res.end(gz ? local.gz : local.json);
        }
        if (pathname === '/api/applicator/select') return await handleJsonPost(req, res, (b) => applicate(LOCAL[pickLang(b.lang)].catalog, b));
        if (pathname === '/api/applicator/sizing') return await handleJsonPost(req, res, size);
        if (pathname === '/api/contact') {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
            return await handleContact(req, res);
        }
        if (pathname === '/api/inquiries') {
            if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return sendJson(res, 401, { error: 'Unauthorized' });
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
