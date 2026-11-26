#!/usr/bin/env node
// Translation check: collects every English text of the site and compares it with frontend/i18n/<lang>.json.
//
//   node tools/i18n-check.mjs            report missing / unused keys and broken placeholders or tags
//   node tools/i18n-check.mjs --write    also write frontend/i18n/keys.json (all English keys) and
//                                        frontend/i18n/missing-<lang>.json (keys still to translate)
//
// Needs Node 22+ and Chromium (the static page is read in a real browser with the same code as js/i18n.js).
// Sources of keys:
//   - index.html: I18N.collect() on a freshly parsed copy of the page
//   - frontend/js/main.js: T('…') calls · backend/server.js: t('…') calls
//   - backend/lib/applicator.js: every quoted sentence (messages are also kept in maps)
//   - catalog texts: localizeCatalog() from backend/lib/i18n.js with a recording translator
// Flow: read keys from the source code → start the backend and a headless Chromium on a random port →
// read catalog + page keys → stop both → compare with each dictionary. Exit code 1 if anything is missing or broken.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = join(ROOT, 'frontend', 'i18n');
const WRITE = process.argv.includes('--write');
/** Languages to check (English is the source). */
const LANGS = ['ru', 'az'];
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/** A JS string literal from our own source → its value. */
const unquote = (literal) => new Function(`return ${literal}`)();

// ---------- Keys from source code ----------
/** A single-quoted JS string literal (with \-escapes). */
const QUOTED = `'(?:[^'\\\\]|\\\\.)*'`;

/** The literal first argument of every fn('…') call in file. */
const literalCalls = (file, fn) => [...read(file).matchAll(new RegExp(`\\b${fn}\\((${QUOTED})`, 'g'))]
    .map((match) => unquote(match[1]));

/** Source code without /* … *\/ and // comments (rough, but good enough for our own files). */
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** Every single-quoted string in file that looks like a sentence (has a space and a word). */
const sentences = (file) => [...withoutComments(read(file)).matchAll(new RegExp(QUOTED, 'g'))]
    .map((match) => unquote(match[0]))
    .filter((text) => / /.test(text) && /\p{L}{2}/u.test(text) && !/^(use strict)$/.test(text));

const codeKeys = [
    ...literalCalls('frontend/js/main.js', 'T'),
    ...literalCalls('backend/server.js', 't'),
    ...literalCalls('backend/lib/applicator.js', 't'),
    ...sentences('backend/lib/applicator.js'),
];

// ---------- Server + browser: catalog texts and the static page ----------
/** Random port, so several checks (or a running dev server) don't collide; Chromium's debug port is port + 1000. */
const port = 3900 + Math.floor(Math.random() * 90);
const debugPort = port + 1000;
const server = spawn(process.execPath, [join(ROOT, 'backend', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
});
const profile = mkdtempSync(join(tmpdir(), 'i18n-check-'));
const chrome = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

/** Stops the server and Chromium and deletes the temporary browser profile. */
const cleanup = () => {
    server.kill();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
};

/** Calls load() up to 50 times, 200 ms apart, until it succeeds (the processes need a moment to start). */
async function retry(load) {
    for (let attempt = 0; attempt < 50; attempt++) {
        try { return await load(); } catch { await sleep(200); }
    }
    return undefined;
}

/** Every text localizeCatalog() would translate, recorded with a translator that changes nothing. */
async function readCatalogKeys() {
    const catalog = await retry(async () => (await fetch(`http://127.0.0.1:${port}/api/catalog?lang=en`)).json());
    if (!catalog) throw new Error('server did not start');
    const { localizeCatalog } = require(join(ROOT, 'backend', 'lib', 'i18n.js'));
    const ownIds = new Set(JSON.parse(read('backend/data/icss-products.json')).map((product) => product.id));
    const seen = [];
    localizeCatalog(catalog, (key) => { seen.push(key); return key; }, ownIds);
    return seen;
}

/** The static page keys: opens the site in Chromium (DevTools protocol) and runs I18N.collect() on index.html. */
async function readPageKeys() {
    const targets = await retry(async () => (await fetch(`http://127.0.0.1:${debugPort}/json`)).json());
    if (!targets) throw new Error('Chromium did not start (set CHROMIUM=/path/to/chromium)');
    const ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((done) => ws.addEventListener('open', done));

    // Minimal DevTools client: send a command, resolve with the answer that has the same id.
    let lastId = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        pending.get(message.id)?.(message);
    });
    const send = (method, params) => new Promise((done) => {
        pending.set(++lastId, done);
        ws.send(JSON.stringify({ id: lastId, method, params }));
    });

    await send('Page.enable', {});
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await sleep(2500); // let the page load js/i18n.js
    // A freshly parsed copy, so texts that main.js has already rendered into the page are not counted.
    const answer = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const html = await (await fetch('/')).text();
        return I18N.collect(new DOMParser().parseFromString(html, 'text/html'));
    })()` });
    const keys = answer.result.result.value;
    if (!Array.isArray(keys)) throw new Error('could not read the page: ' + JSON.stringify(answer.result));
    ws.close();
    return keys;
}

let catalogKeys;
let staticKeys;
try {
    catalogKeys = await readCatalogKeys();
    staticKeys = await readPageKeys();
} finally {
    cleanup();
}

// ---------- Compare ----------
const keys = [...new Set([...staticKeys, ...codeKeys, ...catalogKeys].filter((key) => key && /\p{L}/u.test(key)))];
const counts = `page ${new Set(staticKeys).size}, code ${new Set(codeKeys).size}, catalog ${new Set(catalogKeys).size}`;
console.log(`English keys: ${keys.length} (${counts})`);
if (WRITE) writeFileSync(join(I18N_DIR, 'keys.json'), JSON.stringify(keys, null, 1) + '\n');

/** {a} is the English article (a / an); other languages may leave it out. Every other placeholder must stay. */
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => p !== 'a'))]
    .sort().join(',');
/** The HTML tags in a text, sorted: a translation must keep the same markup. */
const tags = (text) => [...text.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[0].toLowerCase()).sort().join(',');

let problems = 0;
for (const lang of LANGS) {
    const file = join(I18N_DIR, `${lang}.json`);
    const dict = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const missing = keys.filter((key) => !(key in dict) || !String(dict[key]).trim());
    const unused = Object.keys(dict).filter((key) => !keys.includes(key));
    const broken = keys.filter((key) => dict[key]
        && (placeholders(key) !== placeholders(dict[key]) || tags(key) !== tags(dict[key])));

    const translated = keys.length - missing.length;
    console.log(`\n[${lang}] translated ${translated}/${keys.length} · missing ${missing.length} · unused ${unused.length}`
        + ` · placeholder/tag mismatch ${broken.length}`);
    missing.slice(0, 15).forEach((key) => console.log(`  missing: ${key.slice(0, 110)}`));
    if (missing.length > 15) console.log(`  … and ${missing.length - 15} more`);
    unused.slice(0, 10).forEach((key) => console.log(`  unused:  ${key.slice(0, 110)}`));
    broken.forEach((key) => console.log(`  MISMATCH: ${key.slice(0, 90)}\n         → ${String(dict[key]).slice(0, 90)}`));
    problems += missing.length + broken.length;
    if (WRITE) {
        const todo = Object.fromEntries(missing.map((key) => [key, '']));
        writeFileSync(join(I18N_DIR, `missing-${lang}.json`), JSON.stringify(todo, null, 1) + '\n');
    }
}
process.exitCode = problems ? 1 : 0;
