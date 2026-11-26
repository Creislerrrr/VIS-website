/**
 * i18n.js — language switch: English, Russian, Azerbaijani.
 *
 * The English text is the key (gettext style): i18n/ru.json and i18n/az.json map English → translation.
 * A missing translation simply shows the English text.
 *  - Static page (index.html): translated at start-up, see units() for what counts as one text.
 *  - Script texts: I18N.t('English text with {placeholders}', { placeholders }).
 *  - Catalog data and server messages are translated by the server (?lang= / body.lang) from the same files.
 * New texts: run tools/i18n-check (see README) to list keys that are missing in a language.
 *
 * Loaded before js/main.js. Flow: pick the language → load its dictionary → draw the EN / RU / AZ buttons →
 * translate the page → remove the "i18n-pending" class (index.html hides the page until then).
 * Exposes window.I18N = { lang, langs, locale, t, apply, collect, ready }; main.js awaits I18N.ready.
 */
(() => {
    // ---------- Languages ----------
    /** Supported languages: button label, full name (tooltip) and locale for number / date formatting. */
    const LANGS = {
        en: { name: 'English', short: 'EN', locale: 'en-GB' },
        ru: { name: 'Русский', short: 'RU', locale: 'ru-RU' },
        az: { name: 'Azərbaycan', short: 'AZ', locale: 'az-Latn-AZ' },
    };
    /** localStorage key of the chosen language (also read by the inline script in index.html). */
    const STORE = 'vis-lang';

    /** Saves the chosen language; ignored where localStorage is blocked (private mode). */
    function rememberLang(code) {
        try { localStorage.setItem(STORE, code); } catch { /* private mode */ }
    }

    /** The saved language, or null. */
    function savedLang() {
        try {
            const saved = localStorage.getItem(STORE);
            if (LANGS[saved]) return saved;
        } catch { /* private mode */ }
        return null;
    }

    /** First supported language from the browser settings, or null. */
    function browserLang() {
        const preferred = navigator.languages || [navigator.language];
        return preferred.map((code) => String(code).slice(0, 2).toLowerCase()).find((code) => LANGS[code]) || null;
    }

    /** ?lang=xx (also remembered) → saved choice → browser language → English. */
    function pickLang() {
        const fromUrl = new URLSearchParams(location.search).get('lang');
        if (LANGS[fromUrl]) {
            rememberLang(fromUrl);
            return fromUrl;
        }
        return savedLang() || browserLang() || 'en';
    }

    const lang = pickLang();
    document.documentElement.lang = lang;
    /** English text → translation for the current language (stays empty for English). */
    let dict = {};

    // ---------- Text helpers ----------
    /** Collapses whitespace, so a key does not depend on how the HTML is indented. */
    const norm = (text) => text.replace(/\s+/g, ' ').trim();
    /** True if the text contains at least one letter (numbers and symbols are not translated). */
    const hasWords = (text) => /\p{L}/u.test(text);
    /** Replaces {name} placeholders with vars.name; unknown placeholders stay. */
    const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match)) : text);
    /** Translate an English text; {name} placeholders are filled from vars. */
    const t = (key, vars) => fill(dict[key] ?? key, vars);

    // ---------- Static page ----------
    // An element that holds text and only inline markup (<strong>, <a>, …) is translated as one unit (its innerHTML),
    // so a sentence with a link stays one sentence. Otherwise each text node is translated on its own.
    const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'A', 'SPAN', 'BR', 'CODE', 'SMALL', 'SUP', 'SUB', 'ABBR']);
    /** Elements whose content is never translated (also any element with data-i18n-skip). */
    const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'TEMPLATE', 'NOSCRIPT']);
    /** Attributes a visitor can see or hear (screen readers), so they are translated too. */
    const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
    const TEXT_NODE = 3;
    const ELEMENT_NODE = 1;

    /** True if el contains only text and inline elements (recursively). */
    const inlineOnly = (el) => [...el.childNodes].every((node) => node.nodeType === TEXT_NODE
        || (node.nodeType === ELEMENT_NODE && INLINE.has(node.tagName) && inlineOnly(node)));
    /** The text nodes directly inside el that contain words. */
    const directText = (el) => [...el.childNodes].filter((node) => node.nodeType === TEXT_NODE && hasWords(node.nodeValue));

    /** Every translatable piece below root: { kind: 'html' | 'text' | 'attr', key, … }. */
    function units(root) {
        const out = [];
        const visit = (el) => {
            if (SKIP.has(el.tagName) || el.hasAttribute('data-i18n-skip')) return;
            ATTRS.forEach((attr) => {
                const value = el.getAttribute(attr);
                if (value && hasWords(value)) out.push({ kind: 'attr', el, attr, key: norm(value) });
            });
            const text = directText(el);
            if (text.length && inlineOnly(el)) {
                out.push({ kind: 'html', el, key: norm(el.innerHTML) });
                return;
            }
            text.forEach((node) => out.push({ kind: 'text', node, key: norm(node.nodeValue) }));
            [...el.children].forEach(visit);
        };
        visit(root);
        return out;
    }

    /** Translates the static texts below root, plus the page title and meta description. */
    function apply(root = document.body) {
        if (lang === 'en') return;
        units(root).forEach((unit) => {
            const translation = dict[unit.key];
            if (!translation) return;
            if (unit.kind === 'attr') unit.el.setAttribute(unit.attr, translation);
            else if (unit.kind === 'html') unit.el.innerHTML = translation;
            // Text node: keep its leading / trailing whitespace, so words don't run into the neighbouring elements.
            else unit.node.nodeValue = unit.node.nodeValue.replace(/^(\s*)[\s\S]*?(\s*)$/, `$1${translation}$2`);
        });
        document.title = t(norm(document.title));
        const desc = document.querySelector('meta[name="description"]');
        if (desc) desc.content = t(norm(desc.content));
    }

    /** All static keys of a page, e.g. a freshly parsed index.html (for tools/i18n-check.mjs). */
    const collect = (doc = document) => [...new Set([
        norm(doc.title),
        norm(doc.querySelector('meta[name="description"]')?.content || ''),
        ...units(doc.body).map((unit) => unit.key),
    ])].filter(Boolean);

    // ---------- Switcher ----------
    /** Fills every [data-lang-switch] box with one button per language. */
    function renderSwitchers() {
        document.querySelectorAll('[data-lang-switch]').forEach((box) => {
            box.innerHTML = Object.entries(LANGS).map(([code, info]) => `<button type="button" class="lang-btn"
                data-set-lang="${code}" lang="${code}" aria-pressed="${code === lang}"
                title="${info.name}">${info.short}</button>`)
                .join('');
        });
    }

    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-set-lang]');
        if (!button || button.dataset.setLang === lang) return;
        rememberLang(button.dataset.setLang);
        // Reload in the new language (the inquiry list is kept in localStorage); ?lang= keeps the link shareable.
        const url = new URL(location.href);
        url.searchParams.set('lang', button.dataset.setLang);
        location.replace(url);
    });

    // ---------- Start-up ----------
    /** Resolves once the dictionary is loaded and the page is translated. */
    const ready = (async () => {
        try {
            if (lang !== 'en') {
                const res = await fetch(`i18n/${lang}.json`, { cache: 'no-cache' });
                if (res.ok) dict = await res.json();
            }
        } catch { /* stay in English */ }
        renderSwitchers();
        apply();
        document.documentElement.classList.remove('i18n-pending');
    })();

    window.I18N = { lang, langs: LANGS, locale: LANGS[lang].locale, t, apply, collect, ready };
})();
