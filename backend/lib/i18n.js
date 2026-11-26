// Translations for the server: catalog texts and messages (errors, Applicator results).
// Same dictionaries as the browser: frontend/i18n/<lang>.json maps the English text → translation;
// a missing entry keeps the English text. See frontend/js/i18n.js.
const fs = require('node:fs');
const path = require('node:path');

const LANGS = ['en', 'ru', 'az'];
const DIR = path.resolve(__dirname, '..', '..', 'frontend', 'i18n');

const dicts = Object.fromEntries(LANGS.map((lang) => {
    if (lang === 'en') return [lang, {}];
    try { return [lang, JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8'))]; }
    catch (e) { if (e.code !== 'ENOENT') throw e; return [lang, {}]; }
}));

const pickLang = (v) => (LANGS.includes(v) ? v : 'en');
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** t('English text with {placeholders}', vars) for one language. */
function translator(lang) {
    const d = dicts[pickLang(lang)];
    return (key, vars) => fill(d[key] ?? key, vars);
}

/**
 * A copy of the catalog with the texts a visitor reads translated. Ids, brands and manufacturer product names
 * (Rosemount 3051S …) stay; of the portfolio items only our own ones (ownIds, e.g. icss-products.json) are translated.
 */
function localizeCatalog(catalog, t, ownIds = new Set()) {
    const c = structuredClone(catalog);
    const tx = (o, ...keys) => keys.forEach((k) => { if (typeof o?.[k] === 'string' && o[k]) o[k] = t(o[k]); });
    const txMap = (o) => Object.keys(o).forEach((k) => { o[k] = t(o[k]); });
    // Category names can need a different word than the same English text elsewhere (e.g. "Flow" as a menu entry →
    // "Измерение расхода", as the Applicator's measured variable → "Расход"): the key "<name> (category)" wins if translated.
    const tCat = (s) => { const k = `${s} (category)`; const v = t(k); return v === k ? t(s) : v; };

    c.categories.forEach((x) => { x.name = tCat(x.name); tx(x, 'text'); });
    c.ehCategories.forEach((x) => { x.name = tCat(x.name); });
    c.industries.forEach((x) => tx(x, 'name', 'text'));
    c.products.forEach((x) => { tx(x, 'name', 'principle'); x.highlights = x.highlights.map((h) => t(h)); });
    c.faq.forEach((x) => tx(x, 'q', 'a'));
    tx(c.valveDatasheet, 'intro');
    c.valveDatasheet.fields.forEach((f) => {
        tx(f, 'label', 'placeholder', 'unit');
        if (f.options) f.options = f.options.map(([value, text]) => [value, t(text)]);
        if (f.hints) txMap(f.hints);
    });
    tx(c.icss, 'intro');
    c.icss.requirements.forEach((r) => tx(r, 'title', 'text'));
    if (c.info) {
        txMap(c.info.lines);
        c.info.types.forEach((x) => tx(x, 'text'));
        txMap(c.info.categories);
        c.info.service = c.info.service.map((s) => t(s));
    }
    // Product type of every portfolio item (the line under the name, e.g. "Coriolis flowmeter"); the manufacturer's
    // product name stays. typeEn: the product-info texts are chosen by matching English patterns against the type.
    c.eh.forEach((p) => { p.typeEn = p.type; tx(p, 'type'); });
    c.eh.filter((p) => ownIds.has(p.id)).forEach((p) => tx(p, 'description'));
    return c;
}

module.exports = { LANGS, pickLang, translator, localizeCatalog };
