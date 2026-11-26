/**
 * lib/i18n.js — translations for the server: catalog texts and messages (errors, Applicator results).
 *
 * Same dictionaries as the browser: frontend/i18n/<lang>.json maps the English text → translation;
 * a missing entry keeps the English text. See frontend/js/i18n.js.
 * Used by server.js: translator(lang) for messages, localizeCatalog() once per language at start-up.
 * tools/i18n-check.mjs also calls localizeCatalog() with a recording translator to list every catalog key.
 */
const fs = require('node:fs');
const path = require('node:path');

// ---------- Dictionaries ----------
/** Supported languages; English is the source language and needs no dictionary. */
const LANGS = ['en', 'ru', 'az'];
const DIR = path.resolve(__dirname, '..', '..', 'frontend', 'i18n');

/** Reads frontend/i18n/<lang>.json (an empty dictionary if the file does not exist). */
function loadDictionary(lang) {
    if (lang === 'en') return {};
    try {
        return JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return {};
    }
}

/** lang → { 'English text': 'translation' }, read once at start-up. */
const dicts = Object.fromEntries(LANGS.map((lang) => [lang, loadDictionary(lang)]));

// ---------- Translating ----------
/** A supported language code; anything else falls back to 'en'. */
const pickLang = (value) => (LANGS.includes(value) ? value : 'en');

/** Replaces {name} placeholders in text with vars.name; unknown placeholders stay as they are. */
const fill = (text, vars) => {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
};

/** t('English text with {placeholders}', vars) for one language. */
function translator(lang) {
    const dict = dicts[pickLang(lang)];
    return (key, vars) => fill(dict[key] ?? key, vars);
}

// ---------- Catalog ----------
/**
 * A copy of the catalog with the texts a visitor reads translated. Ids, brands and manufacturer product names
 * (Rosemount 3051S …) stay; of the portfolio items only our own ones (ownIds, e.g. icss-products.json) are translated.
 * t: a translator from translator(lang).
 */
function localizeCatalog(catalog, t, ownIds = new Set()) {
    const copy = structuredClone(catalog);

    /** Translates the given string properties of obj in place (missing / empty ones are skipped). */
    const translateProps = (obj, ...props) => props.forEach((prop) => {
        if (typeof obj?.[prop] === 'string' && obj[prop]) obj[prop] = t(obj[prop]);
    });
    /** Translates every value of a { key: 'text' } map in place. */
    const translateValues = (map) => Object.keys(map).forEach((key) => { map[key] = t(map[key]); });
    /**
     * Category names can need a different word than the same English text elsewhere (e.g. "Flow" as a menu entry →
     * "Измерение расхода", as the Applicator's measured variable → "Расход"): the key "<name> (category)" wins if
     * translated.
     */
    const translateCategory = (name) => {
        const categoryKey = `${name} (category)`;
        const translated = t(categoryKey);
        return translated === categoryKey ? t(name) : translated;
    };

    // Menus, industries, own product groups, FAQ
    copy.categories.forEach((category) => {
        category.name = translateCategory(category.name);
        translateProps(category, 'text');
    });
    copy.ehCategories.forEach((category) => { category.name = translateCategory(category.name); });
    copy.industries.forEach((industry) => translateProps(industry, 'name', 'text'));
    copy.products.forEach((product) => {
        translateProps(product, 'name', 'principle');
        product.highlights = product.highlights.map((highlight) => t(highlight));
    });
    copy.faq.forEach((entry) => translateProps(entry, 'q', 'a'));

    // Valve datasheet form: labels, placeholders, units, choice texts (the option values stay), hints
    translateProps(copy.valveDatasheet, 'intro');
    copy.valveDatasheet.fields.forEach((field) => {
        translateProps(field, 'label', 'placeholder', 'unit');
        if (field.options) field.options = field.options.map(([value, text]) => [value, t(text)]);
        if (field.hints) translateValues(field.hints);
    });

    // ICSS requirements (Control & safety systems section)
    translateProps(copy.icss, 'intro');
    copy.icss.requirements.forEach((requirement) => translateProps(requirement, 'title', 'text'));

    // Product details window texts (product-info.json)
    if (copy.info) {
        translateValues(copy.info.lines);
        copy.info.types.forEach((type) => translateProps(type, 'text'));
        translateValues(copy.info.categories);
        copy.info.service = copy.info.service.map((line) => t(line));
    }

    // Product type of every portfolio item (the line under the name, e.g. "Coriolis flowmeter"); the manufacturer's
    // product name stays. typeEn: the product-info texts are chosen by matching English patterns against the type.
    copy.eh.forEach((product) => {
        product.typeEn = product.type;
        translateProps(product, 'type');
    });
    copy.eh.filter((product) => ownIds.has(product.id)).forEach((product) => translateProps(product, 'description'));
    return copy;
}

module.exports = { LANGS, pickLang, translator, localizeCatalog };
