/**
 * i18n.js — language switch: English, Russian, Azerbaijani.
 *
 * The English text is the key (gettext style): i18n/ru.json and i18n/az.json map English → translation.
 * A missing translation simply shows the English text.
 *  - Static page (index.html): translated at start-up, see units() for what counts as one text.
 *  - Script texts: I18N.t('English text with {placeholders}', { placeholders }).
 *  - Catalog data and server messages are translated by the server (?lang= / body.lang) from the same files.
 * New texts: run tools/i18n-check (see README) to list keys that are missing in a language.
 */
(() => {
    const LANGS = {
        en: { name: 'English', short: 'EN', locale: 'en-GB' },
        ru: { name: 'Русский', short: 'RU', locale: 'ru-RU' },
        az: { name: 'Azərbaycan', short: 'AZ', locale: 'az-Latn-AZ' },
    };
    const STORE = 'vis-lang';

    // ?lang=xx (also remembered) → saved choice → browser language → English.
    function pickLang() {
        const q = new URLSearchParams(location.search).get('lang');
        if (LANGS[q]) { try { localStorage.setItem(STORE, q); } catch { /* private mode */ } return q; }
        try { const saved = localStorage.getItem(STORE); if (LANGS[saved]) return saved; } catch { /* private mode */ }
        return (navigator.languages || [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => LANGS[l]) || 'en';
    }

    const lang = pickLang();
    document.documentElement.lang = lang;
    let dict = {};

    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const hasWords = (s) => /\p{L}/u.test(s);
    const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s);
    /** Translate an English text; {name} placeholders are filled from vars. */
    const t = (key, vars) => fill(dict[key] ?? key, vars);

    // ---------- Static page ----------
    // An element that holds text and only inline markup (<strong>, <a>, …) is translated as one unit (its innerHTML),
    // so a sentence with a link stays one sentence. Otherwise each text node is translated on its own.
    const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'A', 'SPAN', 'BR', 'CODE', 'SMALL', 'SUP', 'SUB', 'ABBR']);
    const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'TEMPLATE', 'NOSCRIPT']);
    const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
    const inlineOnly = (el) => [...el.childNodes].every((n) => n.nodeType === 3 || (n.nodeType === 1 && INLINE.has(n.tagName) && inlineOnly(n)));
    const directText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && hasWords(n.nodeValue));

    /** Every translatable piece below root: { kind: 'html' | 'text' | 'attr', key, … }. */
    function units(root) {
        const out = [];
        const visit = (el) => {
            if (SKIP.has(el.tagName) || el.hasAttribute('data-i18n-skip')) return;
            ATTRS.forEach((attr) => {
                const v = el.getAttribute(attr);
                if (v && hasWords(v)) out.push({ kind: 'attr', el, attr, key: norm(v) });
            });
            const text = directText(el);
            if (text.length && inlineOnly(el)) { out.push({ kind: 'html', el, key: norm(el.innerHTML) }); return; }
            text.forEach((node) => out.push({ kind: 'text', node, key: norm(node.nodeValue) }));
            [...el.children].forEach(visit);
        };
        visit(root);
        return out;
    }

    function apply(root = document.body) {
        if (lang === 'en') return;
        units(root).forEach((u) => {
            const tr = dict[u.key];
            if (!tr) return;
            if (u.kind === 'attr') u.el.setAttribute(u.attr, tr);
            else if (u.kind === 'html') u.el.innerHTML = tr;
            else u.node.nodeValue = u.node.nodeValue.replace(/^(\s*)[\s\S]*?(\s*)$/, `$1${tr}$2`);
        });
        document.title = t(norm(document.title));
        const desc = document.querySelector('meta[name="description"]');
        if (desc) desc.content = t(norm(desc.content));
    }

    /** All static keys of a page, e.g. a freshly parsed index.html (for tools/i18n-check.mjs). */
    const collect = (doc = document) => [...new Set([norm(doc.title), norm(doc.querySelector('meta[name="description"]')?.content || ''),
        ...units(doc.body).map((u) => u.key)])].filter(Boolean);

    // ---------- Switcher ----------
    function renderSwitchers() {
        document.querySelectorAll('[data-lang-switch]').forEach((box) => {
            box.innerHTML = Object.entries(LANGS).map(([code, l]) => `<button type="button" class="lang-btn" data-set-lang="${code}"
                lang="${code}" aria-pressed="${code === lang}" title="${l.name}">${l.short}</button>`).join('');
        });
    }
    document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-set-lang]');
        if (!b || b.dataset.setLang === lang) return;
        try { localStorage.setItem(STORE, b.dataset.setLang); } catch { /* private mode */ }
        // Reload in the new language (the inquiry list is kept in localStorage); ?lang= keeps the link shareable.
        const url = new URL(location.href);
        url.searchParams.set('lang', b.dataset.setLang);
        location.replace(url);
    });

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
