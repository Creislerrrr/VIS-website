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
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = join(ROOT, 'frontend', 'i18n');
const WRITE = process.argv.includes('--write');
const LANGS = ['ru', 'az'];
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
// A JS string literal from our own source → its value.
const unquote = (lit) => new Function(`return ${lit}`)();

// ---------- Keys from source code ----------
const literalCalls = (file, fn) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(new RegExp(`\\b${fn}\\(('(?:[^'\\\\]|\\\\.)*')`, 'g'))].map((m) => unquote(m[1]));
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const sentences = (file) => [...withoutComments(readFileSync(join(ROOT, file), 'utf8')).matchAll(/'(?:[^'\\]|\\.)*'/g)].map((m) => unquote(m[0]))
    .filter((s) => / /.test(s) && /\p{L}{2}/u.test(s) && !/^(use strict)$/.test(s));
const codeKeys = [
    ...literalCalls('frontend/js/main.js', 'T'),
    ...literalCalls('backend/server.js', 't'),
    ...literalCalls('backend/lib/applicator.js', 't'),
    ...sentences('backend/lib/applicator.js'),
];

// ---------- Server + browser: catalog texts and the static page ----------
const port = 3900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [join(ROOT, 'backend', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'i18n-check-'));
const chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', `--remote-debugging-port=${port + 1000}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { server.kill(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } };

let catalogKeys; let staticKeys;
try {
    let catalog;
    for (let i = 0; i < 50 && !catalog; i++) { try { catalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog?lang=en`)).json(); } catch { await sleep(200); } }
    if (!catalog) throw new Error('server did not start');
    const { localizeCatalog } = require(join(ROOT, 'backend', 'lib', 'i18n.js'));
    const ownIds = new Set(JSON.parse(readFileSync(join(ROOT, 'backend', 'data', 'icss-products.json'), 'utf8')).map((p) => p.id));
    const seen = [];
    localizeCatalog(catalog, (k) => { seen.push(k); return k; }, ownIds);
    catalogKeys = seen;

    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port + 1000}/json`)).json(); } catch { await sleep(200); } }
    if (!targets) throw new Error('Chromium did not start (set CHROMIUM=/path/to/chromium)');
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
    const send = (method, params) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send('Page.enable', {});
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await sleep(2500);
    const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const html = await (await fetch('/')).text();
        return I18N.collect(new DOMParser().parseFromString(html, 'text/html'));
    })()` });
    staticKeys = r.result.result.value;
    if (!Array.isArray(staticKeys)) throw new Error('could not read the page: ' + JSON.stringify(r.result));
    ws.close();
} finally {
    cleanup();
}

// ---------- Compare ----------
const keys = [...new Set([...staticKeys, ...codeKeys, ...catalogKeys].filter((k) => k && /\p{L}/u.test(k)))];
console.log(`English keys: ${keys.length} (page ${new Set(staticKeys).size}, code ${new Set(codeKeys).size}, catalog ${new Set(catalogKeys).size})`);
if (WRITE) writeFileSync(join(I18N_DIR, 'keys.json'), JSON.stringify(keys, null, 1) + '\n');

// {a} is the English article (a / an); other languages may leave it out. Every other placeholder must stay.
const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => p !== 'a'))].sort().join(',');
const tags = (s) => [...s.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[0].toLowerCase()).sort().join(',');
let problems = 0;
for (const lang of LANGS) {
    const file = join(I18N_DIR, `${lang}.json`);
    const dict = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const missing = keys.filter((k) => !(k in dict) || !String(dict[k]).trim());
    const unused = Object.keys(dict).filter((k) => !keys.includes(k));
    const broken = keys.filter((k) => dict[k] && (placeholders(k) !== placeholders(dict[k]) || tags(k) !== tags(dict[k])));
    console.log(`\n[${lang}] translated ${keys.length - missing.length}/${keys.length} · missing ${missing.length} · unused ${unused.length} · placeholder/tag mismatch ${broken.length}`);
    missing.slice(0, 15).forEach((k) => console.log(`  missing: ${k.slice(0, 110)}`));
    if (missing.length > 15) console.log(`  … and ${missing.length - 15} more`);
    unused.slice(0, 10).forEach((k) => console.log(`  unused:  ${k.slice(0, 110)}`));
    broken.forEach((k) => console.log(`  MISMATCH: ${k.slice(0, 90)}\n         → ${String(dict[k]).slice(0, 90)}`));
    problems += missing.length + broken.length;
    if (WRITE) writeFileSync(join(I18N_DIR, `missing-${lang}.json`), JSON.stringify(Object.fromEntries(missing.map((k) => [k, ''])), null, 1) + '\n');
}
process.exitCode = problems ? 1 : 0;
