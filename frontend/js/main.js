/**
 * main.js — all interactive parts of the VIS website (frontend/index.html).
 *
 * index.html is a static shell with empty containers (#product-grid, #brand-list, #inquiry-body, …).
 * This script fills them with HTML built from the catalog that the backend (backend/server.js) serves.
 * It is loaded after js/i18n.js, which provides window.I18N (translation function, language, locale).
 *
 * Flow:
 *   1. Start-up (bottom of the file): on DOMContentLoaded, bind the contact form, then load
 *      GET /api/catalog?lang=xx (catalog texts already translated) and wait until the translations are ready.
 *   2. Index the catalog: lookup maps by id, product-line sizes, featured ranking (used for sorting).
 *   3. Build the page: mega menu, filters, brands, industries, FAQ, ICSS, product grid, inquiry list.
 *   4. Event delegation: one click listener on the document reacts to data-* attributes
 *      (data-add, data-details, data-category, data-brand, …). Re-rendered HTML therefore needs no own listeners.
 *
 * Two kinds of products live in the catalog:
 *   - technology families (catalog.products, e.g. "Coriolis flowmeter"), used by the Applicator;
 *   - portfolio items of Emerson / Endress+Hauser (catalog.eh, they have a `url`), shown in the product finder.
 *
 * Other server calls: POST /api/applicator/select (Applicator), POST /api/contact (contact form + inquiry list).
 * The inquiry list itself lives only in the browser (localStorage) until the contact form is sent.
 */
(() => {
    // ---------- Basics ----------
    /** Shortcuts for querySelector / querySelectorAll (the latter returns a real array). */
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    /** Escapes a value for use inside HTML text or attributes (null / undefined become ''). */
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

    // Translation (js/i18n.js): T('English text with {placeholders}', vars). Keys must be literal strings (tools/i18n-check.mjs).
    const { t: T, lang: LANG, locale: LOCALE } = window.I18N;
    /** Number with the thousands separator of the visitor's language. */
    const fmt = (n) => n.toLocaleString(LOCALE);
    /** Translated name of a medium id (liquid, gas, …). */
    const mediumLabel = (medium) => ({
        liquid: T('Liquid'),
        gas: T('Gas'),
        steam: T('Steam'),
        slurry: T('Slurry'),
        solid: T('Bulk solid'),
    }[medium]);

    // ---------- Catalog data and page state ----------
    /** The catalog from /api/catalog (null until loaded). */
    let catalog = null;
    /** Every product (technology families and portfolio items) by id. */
    const byId = new Map();
    /** Technology families only, by id (portfolio items point to them via `tech`). */
    const techById = new Map();

    // Emerson is the lead brand: its products come first in the finder and in every product list.
    const LEAD_BRAND = 'Emerson';
    /** Brands whose full portfolio is in the product finder (the other brands only appear as technology families). */
    const PORTFOLIO_BRANDS = ['Emerson', 'Endress+Hauser'];

    /** Product finder filters: free text, category, technology, product line. */
    const EMPTY_FILTERS = { text: '', category: '', tech: '', family: '' };
    const filters = { ...EMPTY_FILTERS };
    /** Products shown on the first page of the finder; "Show more" adds two pages. */
    const PAGE_SIZE = 24;
    let shown = PAGE_SIZE;

    /** Allowed quantity per product in the inquiry list. */
    const MAX_QTY = 999;
    /** Max. length of a tag number or a datasheet value (the server cuts at the same length). */
    const MAX_TEXT = 120;
    const TOAST_MS = 2200;
    /** How long the "Click again to clear" confirmation stays. */
    const CLEAR_CONFIRM_MS = 3000;

    /** Quantity limited to 1…MAX_QTY (empty / invalid input counts as 1). */
    const clampQty = (qty) => Math.min(MAX_QTY, Math.max(1, qty || 1));
    const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- Small helpers ----------
    /** Restarts a CSS animation on an element (removing the class and forcing a reflow lets it run again). */
    const replay = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
    };

    /** Renders, then fades the matching children in one after another (delay capped after 8 items). */
    const stagger = (root, sel, render) => {
        render();
        $$(sel, root).forEach((el, i) => {
            el.style.setProperty('--i', Math.min(i, 8));
            el.classList.add('anim-in');
        });
    };

    /** Shows a short message at the bottom of the screen. */
    const toast = (msg) => {
        const box = $('#toast');
        box.textContent = msg;
        box.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => box.classList.remove('show'), TOAST_MS);
    };

    /** POSTs JSON and returns the JSON answer; throws with the server's error message if the request fails. */
    async function postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || T('Request failed'));
        return data;
    }

    // ---------- Product helpers ----------
    /** Category of a technology family / of a portfolio item (they use different category lists). */
    const category = (id) => catalog.categories.find((c) => c.id === id);
    const ehCategory = (id) => catalog.ehCategories.find((c) => c.id === id);

    /** True for a manufacturer portfolio item (Emerson / E+H), false for a technology family. */
    const isPortfolio = (product) => Boolean(product.url);
    const categoryName = (product) => (isPortfolio(product) ? ehCategory(product.category) : category(product.category)).name;

    /** Real photos are shown whole on white; illustrations fill the frame. */
    const hasPhoto = (product) => isPortfolio(product) && Boolean(product.image);
    const imageFit = (product) => (hasPhoto(product) ? 'object-contain bg-white p-2' : 'object-cover');

    /** Image of a product; falls back to the technology's illustration, then to the category image. */
    function imageOf(product) {
        if (!isPortfolio(product)) return product.image || category(product.category).image;
        if (product.image) return product.image;
        if (product.tech && techById.has(product.tech)) return techById.get(product.tech).image;
        return ehCategory(product.category).image;
    }

    /** Model number from the product name, e.g. "Rosemount 3051S Pressure Transmitter Family" -> "3051S". */
    function modelOf(product) {
        let name = product.name;
        if (product.family) {
            // Drop the product-line name in front, so its digits do not count.
            const startsWithLine = name.toLowerCase().startsWith(product.family.toLowerCase());
            name = name.slice(startsWithLine ? product.family.length : 0);
        }
        return name.split(' ').filter((word) => /\d/.test(word)).join(' ');
    }

    /** Typical accuracy as text, e.g. "±0.1 %" (null if unknown). */
    const accuracyText = (product) => (product.accuracy == null ? null : `±${product.accuracy} ${product.accuracyUnit || '%'}`);

    // ---------- Inquiry list (kept in the browser) ----------
    const STORAGE_KEY = 'vis-inquiry';

    /** Reads the saved list; an unreadable or blocked localStorage gives an empty list. */
    function loadInquiry() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
        } catch {
            return [];
        }
    }

    /**
     * The inquiry list ("cart"): items are { id, qty, tag?, tagNo?, ds? }.
     * save() stores AND re-renders; persist() only stores (used while typing, so the focus stays in the input).
     */
    const inquiry = {
        items: loadInquiry(),
        persist() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
            } catch { /* private mode */ }
        },
        save() {
            this.persist();
            renderInquiry();
        },
        find(id) { return this.items.find((item) => item.id === id); },
        has(id) { return this.items.some((item) => item.id === id); },
        add(id, qty = 1) {
            qty = clampQty(qty);
            if (!this.has(id)) this.items.push({ id, qty });
            this.save();
            replay($('#inquiry-count'), 'anim-pop');
            const product = byId.get(id);
            const name = `${qty > 1 ? `${qty} × ` : ''}${product?.name || T('Product')}`;
            // Valves need a datasheet: tell the visitor where to fill it in.
            toast(product?.datasheet
                ? T('{name} added to inquiry list, please fill in the valve datasheet in the contact form', { name })
                : T('{name} added to inquiry list', { name }));
        },
        remove(id) {
            this.items = this.items.filter((item) => item.id !== id);
            this.save();
        },
        setQty(id, qty) {
            const item = this.find(id);
            if (!item) return;
            item.qty = clampQty(qty);
            this.save();
        },
        clear() {
            this.items = [];
            this.save();
        },
        // Tag / reference number per product: `tag` = wanted, `tagNo` = the number(s), if the customer already has them.
        setTag(id, on) {
            const item = this.find(id);
            if (!item) return;
            item.tag = on;
            this.persist();
        },
        setTagNo(id, value) {
            const item = this.find(id);
            if (!item) return;
            item.tagNo = value.slice(0, MAX_TEXT);
            this.persist();
        },
        setTagAll(on) {
            this.items.forEach((item) => { item.tag = on; });
            this.save();
        },
        // Valve datasheet values per product (`ds`), entered in the contact form.
        setDs(id, field, value) {
            const item = this.find(id);
            if (!item) return;
            item.ds = { ...item.ds, [field]: String(value).slice(0, MAX_TEXT) };
            this.persist();
        },
    };

    /** Items in the inquiry list that are (still) in the catalog. */
    const listedItems = () => inquiry.items.filter((item) => byId.has(item.id));

    // ---------- Valve datasheet (fields defined in catalog.json → valveDatasheet) ----------
    const dsFields = () => catalog.valveDatasheet.fields;
    const dsRequired = () => dsFields().filter((field) => field.required);
    /** Number of required datasheet fields the item has filled in. */
    const dsFilled = (item) => dsRequired().filter((field) => String(item.ds?.[field.id] ?? '').trim() !== '').length;
    const dsComplete = (item) => dsFilled(item) === dsRequired().length;
    /** Field label with unit, e.g. "Line size (DN)". */
    const dsLabel = (field) => `${field.label}${field.unit ? ` (${field.unit})` : ''}`;
    /** Progress text, e.g. "Valve datasheet: 2 of 5 filled (in the contact form)". */
    const dsStatus = (item) => (dsComplete(item)
        ? T('✓ Valve datasheet complete')
        : T('Valve datasheet: {filled} of {total} filled (in the contact form)', {
            filled: dsFilled(item),
            total: dsRequired().length,
        }));
    /** Hints that belong to the chosen options (e.g. a note for a special valve type), joined into one text. */
    const dsHint = (item) => dsFields().map((field) => field.hints?.[item.ds?.[field.id]]).filter(Boolean).join(' ');

    /** One datasheet input. `inputId` is unique per item, `value` is the saved value. */
    function datasheetField(field, item, inputId) {
        const value = item.ds?.[field.id];
        const dataAttrs = `data-ds-item="${esc(item.id)}" data-ds-field="${esc(field.id)}"`;
        const required = field.required ? ' required' : '';
        const optionalNote = field.required ? '' : ` <span class="normal-case font-normal tracking-normal">${T('optional')}</span>`;
        const label = `${esc(dsLabel(field))}${optionalNote}`;

        // Required choice: segmented radio buttons.
        if (field.type === 'choice' && field.required) {
            const checked = (optionValue) => (value === optionValue ? ' checked' : '');
            const radios = field.options.map(([optionValue, text]) => `
                <label>`
                + `<input type="radio" name="${inputId}" value="${esc(optionValue)}" ${dataAttrs}${required}${checked(optionValue)}>`
                + `<span>${esc(text)}</span></label>`).join('');
            return `<fieldset class="ds-field"><legend class="filter-label">${label}</legend>`
                + `<div class="ds-seg">${radios}</div></fieldset>`;
        }

        // Optional choice: a select with "Not specified".
        if (field.type === 'choice') {
            const options = field.options.map(([optionValue, text]) =>
                `<option value="${esc(optionValue)}"${value === optionValue ? ' selected' : ''}>${esc(text)}</option>`).join('');
            return `<div class="ds-field"><label for="${inputId}" class="filter-label">${label}</label>`
                + `<select id="${inputId}" class="field" ${dataAttrs}>
                    <option value="">${T('Not specified')}</option>${options}</select></div>`;
        }

        // Number or text input (text fields may offer the shared line-size suggestions).
        const typeAttrs = field.type === 'number'
            ? `type="number" step="any" min="${field.min}" max="${field.max}" inputmode="decimal"`
            : `type="text" maxlength="${field.max}"${field.suggestions ? ' list="ds-line-sizes"' : ''}`;
        const placeholder = field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : '';
        return `<div class="ds-field"><label for="${inputId}" class="filter-label">${label}</label>
            <input id="${inputId}" class="field" ${typeAttrs} ${dataAttrs} value="${esc(value ?? '')}"${placeholder}${required}></div>`;
    }

    /** Datasheet inputs for one inquiry item in the contact form. `n` keeps the input ids / radio groups unique. */
    function datasheetBlock(item, n) {
        const hint = dsHint(item);
        const fields = dsFields().map((field) => datasheetField(field, item, `ds${n}-${field.id}`)).join('');
        return `<div class="ds-block">
            <div class="flex flex-wrap justify-between gap-x-3 gap-y-1 mb-2"><p class="info-title !mb-0">${T('Valve datasheet')}</p>
                <p class="text-xs ds-progress ${dsComplete(item) ? 'ds-ok' : ''}" data-ds-progress="${esc(item.id)}">`
                + `${esc(dsStatus(item))}</p></div>
            <p class="text-xs mb-3">${esc(catalog.valveDatasheet.intro)}</p>
            <div class="ds-grid">${fields}</div>
            <p class="text-xs ds-hint mt-2 ${hint ? '' : 'hidden'}" data-ds-hint="${esc(item.id)}">ⓘ ${esc(hint)}</p></div>`;
    }

    /** What the datasheet asks for, shown in the product details window of valves and actuators ('' for others). */
    function datasheetInfo(product) {
        if (!product.datasheet) return '';
        const fields = dsFields().map((field) => {
            const optional = field.required ? '' : ` <span class="text-xs">(${T('optional')})</span>`;
            return `<li>${esc(dsLabel(field))}${optional}</li>`;
        }).join('');
        return `<div class="ds-info mb-5"><h3 class="info-title">${T('Valve datasheet for your quotation')}</h3>
            <p class="text-sm mb-2">${T('To quote this product we need at least:')}</p>
            <ol class="ds-info-list">${fields}</ol>
            <p class="text-xs mt-2">${T('Add it to your inquiry list; the contact form asks for these values.')}</p></div>`;
    }

    // ---------- Inquiry list: rendering ----------
    /**
     * "Add to inquiry" control for a product card / details window.
     * Not in the list yet: choose the quantity, then add. Already added: show the quantity, click to edit it in the list.
     * The wrapper's data-addwrap lets renderInquiry() replace every copy when the list changes.
     */
    function addButton(id) {
        let inner;
        if (inquiry.has(id)) {
            const { qty } = inquiry.find(id);
            const label = T('✓ In inquiry list · {qty}', { qty });
            inner = `<button type="button" class="btn-small added" data-inquiry-open>${label}</button>`;
        } else {
            inner = `<span class="qty qty-sm" role="group" aria-label="${T('Quantity')}">
                    <button type="button" data-addstep="-1" aria-label="${T('Decrease quantity')}">−</button>
                    <input type="number" min="1" max="999" value="1" data-addqty aria-label="${T('Quantity to add')}">
                    <button type="button" data-addstep="1" aria-label="${T('Increase quantity')}">+</button></span>
                <button type="button" class="btn-small" data-add="${esc(id)}">${T('+ Add to inquiry')}</button>`;
        }
        return `<span class="add-group" data-addwrap="${esc(id)}">${inner}</span>`;
    }

    const TRASH_ICON = '<svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
        + ' viewBox="0 0 24 24">'
        + '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

    /** One row of the inquiry list window: thumbnail, name, datasheet status, quantity, remove button. */
    function inquiryRow(item) {
        const product = byId.get(item.id);
        const id = esc(item.id);
        const subtitle = isPortfolio(product) ? `${product.brand} · ${product.type}` : categoryName(product);
        const datasheetStatus = product.datasheet
            ? `<p class="ds-status ${dsComplete(item) ? 'ds-ok' : ''}" data-ds-status="${id}">${esc(dsStatus(item))}</p>`
            : '';
        return `<li class="inq-item" data-item="${id}">
            <img src="${esc(imageOf(product))}" alt="" class="inq-thumb ${imageFit(product)}">
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-brand-ink text-sm leading-snug truncate"
                    title="${esc(product.name)}">${esc(product.name)}</p>
                <p class="text-xs truncate mb-2">${esc(subtitle)}</p>
                ${datasheetStatus}
                <div class="qty" role="group" aria-label="${T('Quantity for {name}', { name: esc(product.name) })}">
                    <button type="button" data-step="-1" data-for="${id}" aria-label="${T('Decrease quantity')}">−</button>
                    <input type="number" min="1" max="999" value="${item.qty}" data-qty="${id}" aria-label="${T('Quantity')}">
                    <button type="button" data-step="1" data-for="${id}" aria-label="${T('Increase quantity')}">+</button>
                </div>
            </div>
            <button type="button" class="icon-btn" data-remove="${id}"
                aria-label="${T('Remove {name}', { name: esc(product.name) })}" title="${T('Remove')}">${TRASH_ICON}</button></li>`;
    }

    /** The inquiry list window when it has items: count, "Clear list" button, rows. */
    function inquiryListHtml(items) {
        const count = items.length === 1
            ? T('{n} product', { n: '<strong class="text-brand-ink">1</strong>' })
            : T('{n} products', { n: `<strong class="text-brand-ink">${items.length}</strong>` });
        return `<div class="flex items-center justify-between mb-2 px-1">
                <p class="text-sm">${count}</p>
                <button type="button" id="inquiry-clear" class="btn-clear">${TRASH_ICON}<span>${T('Clear list')}</span></button></div>
            <ul class="space-y-1">${items.map(inquiryRow).join('')}</ul>`;
    }

    /** The inquiry list window when it is empty. */
    const emptyInquiryHtml = () => `<div class="text-center py-14 px-4">
            <span class="mx-auto mb-4 w-14 h-14 rounded-full bg-brand-orange-soft text-brand-orange-dark grid place-items-center">
                <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">`
                + '<rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/></svg>'
            + `</span>
            <p class="font-semibold text-brand-ink mb-1">${T('Your inquiry list is empty')}</p>
            <p class="text-sm">${T('Add products from the product finder or the Applicator.')}</p></div>`;

    /** Re-renders everything that shows the inquiry list: header badge, list window, contact form, "Add" buttons. */
    function renderInquiry() {
        const items = listedItems();
        const count = $('#inquiry-count');
        count.textContent = items.length;
        count.classList.toggle('hidden', items.length === 0);

        $('#inquiry-body').innerHTML = items.length ? inquiryListHtml(items) : emptyInquiryHtml();
        $('#inquiry-submit').classList.toggle('hidden', items.length === 0);

        renderContactItems(items);

        // Keep "Add" buttons everywhere in sync.
        $$('[data-addwrap]').forEach((wrap) => { wrap.outerHTML = addButton(wrap.dataset.addwrap); });
    }

    /** One product in the contact form: name, quantity, tag number option and (for valves) the datasheet. */
    function contactItem(item, n) {
        const product = byId.get(item.id);
        const id = esc(item.id);
        const name = esc(product.name);
        const tagPlaceholder = item.qty > 1
            ? T('e.g. FT-101, FT-102 (optional, can follow later)')
            : T('e.g. FT-101 (optional, can follow later)');
        const tagLabel = T('Tag / reference number');
        return `<li class="px-3 py-2.5">
            <div class="flex justify-between items-center gap-3"><span class="text-brand-ink">${name}</span>
                <span class="qty qty-sm shrink-0" role="group" aria-label="${T('Quantity for {name}', { name })}">
                    <button type="button" data-cstep="-1" data-for="${id}" aria-label="${T('Decrease quantity')}">−</button>
                    <input type="number" min="1" max="999" value="${item.qty}" data-cqty="${id}" aria-label="${T('Quantity')}">
                    <button type="button" data-cstep="1" data-for="${id}" aria-label="${T('Increase quantity')}">+</button></span></div>
            <label class="check tag-check"><input type="checkbox" data-tag="${id}" ${item.tag ? 'checked' : ''}> ${tagLabel}</label>
            <input type="text" class="field tag-input ${item.tag ? '' : 'hidden'}" data-tagno="${id}"
                value="${esc(item.tagNo || '')}" maxlength="120"
                placeholder="${tagPlaceholder}" aria-label="${T('Tag / reference number for {name}', { name })}">
            ${product.datasheet ? datasheetBlock(item, n) : ''}
        </li>`;
    }

    /** Inquiry list inside the contact form, with the tag / reference number option per product. */
    function renderContactItems(items = listedItems()) {
        $('#contact-items').classList.toggle('hidden', items.length === 0);
        $('#contact-items-list').innerHTML = items.map(contactItem).join('');
        // Line-size suggestions (a <datalist>), shared by all datasheets.
        const suggestions = dsFields().find((field) => field.suggestions)?.suggestions || [];
        $('#ds-line-sizes').innerHTML = suggestions.map((s) => `<option value="${esc(s)}"></option>`).join('');
        syncTagAll(items);
    }

    /** "Tag number for all products" checkbox: checked if all items have it, indeterminate if only some. */
    function syncTagAll(items = listedItems()) {
        const all = $('#tag-all');
        const tagged = items.filter((item) => item.tag).length;
        all.checked = items.length > 0 && tagged === items.length;
        all.indeterminate = tagged > 0 && tagged < items.length;
    }

    // ---------- Product finder: filtering and sorting (Emerson + Endress+Hauser portfolios) ----------
    /** Does a portfolio item pass the filters? ignore = 'options': check the category only (to count filter options). */
    function matches(product, ignore = '') {
        if (filters.category && product.category !== filters.category) return false;
        if (ignore === 'options') return true;
        if (filters.tech && product.tech !== filters.tech) return false;
        if (filters.family && product.family !== filters.family) return false;
        if (filters.text) {
            const searchable = [
                product.name, product.type, product.typeEn, product.brand, product.family, product.order, product.description,
                ehCategory(product.category).name, product.tech && techById.get(product.tech)?.name,
            ].join(' ').toLowerCase();
            // Every word of the search must appear somewhere.
            const words = filters.text.toLowerCase().split(/\s+/);
            if (!words.every((word) => searchable.includes(word))) return false;
        }
        return true;
    }

    /** Older E+H generations end in a plain model number (e.g. "Promag 53H"); they are listed last. */
    const isLegacy = (product) => product.brand === 'Endress+Hauser' && /(^|\s)[A-Za-z][A-Za-z-]+ \d+[A-Z]*$/.test(product.name);

    /** Number of portfolio items per product line (filled at start-up): main lines (Promass, Micropilot …) go first. */
    const familySize = {};
    const lineSize = (product) => (product.family ? familySize[product.family] : 0);

    /** Featured family pages take turns by category (flow, level, pressure, … flow, level, …), so the first page is varied. */
    const featuredRank = new Map();
    function rankFeatured() {
        const featuredByCategory = {};
        catalog.eh.filter((product) => product.featured)
            .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
            .forEach((product) => (featuredByCategory[product.category] ||= []).push(product));
        // Rank = position within its category × 100 + category index: all 1st items, then all 2nd items, …
        catalog.ehCategories.forEach((cat, catIndex) => (featuredByCategory[cat.id] || [])
            .forEach((product, i) => featuredRank.set(product.id, i * 100 + catIndex)));
    }

    /** Sort order of the finder and of every product list; each rule only decides when the ones before are equal. */
    const finderOrder = (a, b) =>
        ((a.brand !== LEAD_BRAND) - (b.brand !== LEAD_BRAND)) // Emerson first
        || (Boolean(b.featured) - Boolean(a.featured)) // then featured family pages …
        || ((featuredRank.get(a.id) ?? 0) - (featuredRank.get(b.id) ?? 0)) // … taking turns by category
        || (Boolean(b.image) - Boolean(a.image)) // then products with a photo
        || (isLegacy(a) - isLegacy(b)) // current models before older generations
        || (lineSize(b) - lineSize(a)) // big product lines first
        || a.name.localeCompare(b.name, 'en', { numeric: true });

    /** Portfolio items of one technology (optionally of one brand), in finder order. */
    const portfolioFor = (techId, brand) => catalog.eh
        .filter((product) => product.tech === techId && (!brand || product.brand === brand))
        .sort(finderOrder);

    // ---------- Product finder: rendering ----------
    /** While re-rendering after a user action: 'filter' or 'more' (cards fade in), otherwise false. */
    let animateGrid = false;
    /** Fade-in delay is capped so long lists do not wait for ages. */
    const MAX_CARD_DELAY_STEP = 11;

    /** One product card in the finder grid. `delayStep` orders the fade-in animation. */
    function productCard(product, delayStep) {
        const id = esc(product.id);
        // The product-line tag is only useful for Emerson (E+H line names are already in the product name).
        const lineTag = product.family && product.brand === LEAD_BRAND && product.family !== product.brand
            ? `<span class="tag">${esc(product.family)}</span>` : '';
        const orderTag = product.order ? `<span class="tag">${T('Order code {code}', { code: esc(product.order) })}</span>` : '';
        return `<article class="card${animateGrid ? ' anim-in' : ''}" style="--i:${delayStep}">
            <button type="button" data-details="${id}" class="block" aria-label="${T('Details {name}', { name: esc(product.name) })}">`
                + `<img src="${esc(imageOf(product))}" alt="${esc(product.name)}" loading="lazy" class="${imageFit(product)}"></button>
            <div class="p-5 flex flex-col flex-1">
                <p class="text-xs font-semibold uppercase tracking-wider text-brand-orange-dark mb-1">${esc(ehCategory(product.category).name)}</p>
                <h3 class="mb-1">${esc(product.name)}</h3>
                <p class="text-sm mb-3">${esc(product.type)}</p>
                <div class="flex flex-wrap gap-1 mb-4"><span class="tag">${esc(product.brand)}</span>${lineTag}${orderTag}</div>
                <div class="mt-auto flex gap-2 flex-wrap">
                    <button type="button" class="btn-small" data-details="${id}">${T('Details')}</button>
                    ${addButton(product.id)}
                </div>
            </div></article>`;
    }

    /** Renders the finder grid (first `shown` matches), the "Show more" button, the summary and the category chips. */
    function renderProducts() {
        const list = catalog.eh.filter((product) => matches(product)).sort(finderOrder);
        const more = $('#product-more');
        more.classList.toggle('hidden', list.length <= shown);
        more.textContent = T('Show more ({n} remaining)', { n: fmt(Math.max(0, list.length - shown)) });

        // After "Show more", only the new cards animate, starting with no delay.
        const previousCount = $('#product-grid').children.length;
        const delayStep = (i) => {
            if (!animateGrid) return 0;
            const offset = animateGrid === 'more' ? previousCount : 0;
            return Math.max(0, Math.min(i - offset, MAX_CARD_DELAY_STEP));
        };
        $('#product-grid').innerHTML = list.slice(0, shown).map((product, i) => productCard(product, delayStep(i))).join('');

        $('#product-empty').classList.toggle('hidden', list.length > 0);
        $('#product-summary').textContent = T('{n} of {total} products', { n: fmt(list.length), total: fmt(catalog.eh.length) });
        $$('#filter-category .chip').forEach((chip) => {
            chip.setAttribute('aria-pressed', String(chip.dataset.category === filters.category));
        });
    }

    /** Category chips and the technology / product-line selects; the last two are counted within the chosen category. */
    function renderFilterOptions() {
        const countInCategory = (catId) => catalog.eh.filter((product) => product.category === catId).length;
        const chips = [{ id: '', name: T('All products') }, ...catalog.ehCategories]
            .filter((cat) => !cat.id || countInCategory(cat.id))
            .map((cat) => `<button type="button" class="chip" data-category="${esc(cat.id)}" aria-pressed="false">`
                + `${esc(cat.name)} <span>${cat.id ? countInCategory(cat.id) : catalog.eh.length}</span></button>`);
        $('#filter-category').innerHTML = chips.join('');

        const inCategory = catalog.eh.filter((product) => matches(product, 'options'));
        // Drop selections that do not exist in this category.
        if (filters.tech && !inCategory.some((product) => product.tech === filters.tech)) filters.tech = '';
        const familyCount = {};
        inCategory.forEach((product) => {
            if (product.family) familyCount[product.family] = (familyCount[product.family] || 0) + 1;
        });
        if (filters.family && !familyCount[filters.family]) filters.family = '';

        const techOptions = catalog.products
            .map((tech) => [tech, inCategory.filter((product) => product.tech === tech.id).length])
            .filter(([, count]) => count)
            .map(([tech, count]) => `<option value="${esc(tech.id)}">${esc(tech.name)} (${count})</option>`);
        $('#filter-tech').innerHTML = `<option value="">${T('All technologies')}</option>` + techOptions.join('');

        const familyOptions = Object.keys(familyCount).sort((a, b) => a.localeCompare(b))
            .map((family) => `<option value="${esc(family)}">${esc(family)} (${familyCount[family]})</option>`);
        $('#filter-family').innerHTML = `<option value="">${T('All product lines')}</option>` + familyOptions.join('');
    }

    /** Changes the filters (patch = the changed fields), re-renders the finder and optionally scrolls to it. */
    function setFilter(patch, scroll) {
        Object.assign(filters, patch);
        renderFilterOptions();
        shown = PAGE_SIZE;
        animateGrid = 'filter';
        $('#filter-text').value = filters.text;
        $('#filter-tech').value = filters.tech;
        $('#filter-family').value = filters.family;
        renderProducts();
        animateGrid = false;
        if (scroll) $('#products').scrollIntoView({ behavior: 'smooth' });
    }
    const resetFilters = () => setFilter({ ...EMPTY_FILTERS });

    // ---------- Product details window ----------
    const closeIcon = () => `<button type="button" class="absolute top-3 right-3 bg-white/90 p-2 hover:text-brand-orange" data-close
            aria-label="${T('Close')}">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">`
            + '<path d="M6 6l12 12M18 6 6 18"/></svg></button>';

    /** Big product image at the top of the details window, with the close button. */
    const dialogMedia = (product) => '<div class="relative border-b border-brand-line">'
        + `<img src="${esc(imageOf(product))}" alt="${esc(product.name)}" class="dialog-media">${closeIcon()}</div>`;

    /** Bullet list of technology highlights. */
    const highlightList = (highlights) => `<ul class="space-y-1 mb-5">${highlights
        .map((text) => `<li class="flex gap-2"><span class="text-brand-orange">■</span>${esc(text)}</li>`).join('')}</ul>`;

    /** Table rows from [label, value] pairs; `width` is the width of the label column. */
    const specRows = (specs, width = 'w-1/2') => specs
        .map(([label, value]) => `<tr><th class="!normal-case !tracking-normal !text-sm ${width}">${esc(label)}</th>`
            + `<td>${esc(value)}</td></tr>`)
        .join('');

    /** "Check in Applicator" button (variable = flow, level, pressure, temperature or analysis). */
    const applicatorButton = (variable) =>
        `<button type="button" class="btn-small" data-applicator="${esc(variable)}">${T('Check in Applicator')}</button>`;

    /** Fills the details window and opens it. */
    function showProductDialog(html) {
        $('#product-dialog-body').innerHTML = html;
        $('#product-dialog').showModal();
    }

    /** Names of the given industry ids, in catalog order. */
    const industryNames = (ids) => catalog.industries.filter((industry) => ids?.includes(industry.id)).map((industry) => industry.name);

    /** Lower-cases the first letter for use mid-sentence; keeps acronyms (BPCS, pH …) and names from the product name. */
    function lowerFirst(text, productName) {
        const firstWord = text.split(/[\s,(/]/)[0];
        // e.g. "Fluxus F401 …" in "Flexim Fluxus F401 …" stays as it is.
        const isAcronym = /^\p{Lu}{2}|^\p{L}\p{Lu}/u.test(text);
        if (isAcronym || (firstWord.length > 1 && productName.includes(firstWord))) return text;
        return text.charAt(0).toLowerCase() + text.slice(1);
    }

    /**
     * Written product information for the details window, built from product-info.json and the technology data.
     * Returns { tech, paragraphs, specs, industries }.
     */
    function productInfo(product) {
        const info = catalog.info;
        const tech = product.tech && techById.get(product.tech);
        const lineName = product.family || '';
        const typeEn = product.typeEn || product.type;
        // Text about the product type (first rule in product-info.json whose pattern matches type + name).
        const typeText = info.types.find((rule) => new RegExp(rule.match, 'i').test(`${typeEn} ${product.name}`.toLowerCase()))?.text;

        const vars = {
            name: product.name,
            a: /^[aeiou]/i.test(typeEn) ? 'an' : 'a',
            type: lowerFirst(product.type, product.name),
            brand: product.brand,
            line: lineName,
            category: lowerFirst(ehCategory(product.category).name, product.name),
        };
        const overview = lineName && lineName !== product.brand
            ? T('The {name} is {a} {type} from {brand} ({line} product line), in the {category} range that VIS supplies and services in Azerbaijan.', vars)
            : T('The {name} is {a} {type} from {brand}, in the {category} range that VIS supplies and services in Azerbaijan.', vars);
        // The category text is only a fallback when there is neither a type text nor a technology.
        const typeOrCategoryText = typeText || (!tech && info.categories[product.category]);
        const paragraphs = [overview, product.description, typeOrCategoryText, info.lines[lineName]].filter(Boolean);

        const specs = [
            [T('Manufacturer'), product.brand],
            [T('Product line'), lineName !== product.brand ? lineName : ''],
            [T('Model'), modelOf(product)],
            [T('Order code'), product.order],
            [T('Category'), ehCategory(product.category).name],
            [T('Technology'), tech?.name],
            [T('Media'), tech?.media.map(mediumLabel).join(', ')],
            [T('Max. process temperature'), tech?.tempMax != null ? T('up to {max} °C (typical)', { max: tech.tempMax }) : ''],
            [T('Max. process pressure'), tech?.pressureMax != null ? T('up to {max} bar (typical)', { max: tech.pressureMax }) : ''],
            [T('Typical accuracy'), tech ? accuracyText(tech) : ''],
            [T('Hazardous area (Ex)'), tech?.ex ? T('Versions available') : ''],
            [T('Hygienic design'), tech?.hygienic ? T('Versions available') : ''],
        ].filter(([, value]) => value);

        const industries = industryNames(tech?.industries);
        return { tech, paragraphs, specs, industries };
    }

    /** Applicator variable for a portfolio category (both analysis categories use "analysis"). */
    const APPLICATOR_VARIABLE = {
        flow: 'flow',
        level: 'level',
        pressure: 'pressure',
        temperature: 'temperature',
        'liquid-analysis': 'analysis',
        'gas-analysis': 'analysis',
    };

    /** Details window of a portfolio item (Emerson / E+H). */
    function openPortfolio(product) {
        const { tech, paragraphs, specs, industries } = productInfo(product);
        const variable = APPLICATOR_VARIABLE[product.category];

        const howItWorks = tech ? `<h3 class="info-title">${T('How it works')}</h3>
                <p class="mb-3">${esc(tech.principle)}</p>
                ${highlightList(tech.highlights)}` : '';
        const specsNote = tech
            ? `<p class="text-xs mb-5">${T('Technology values are typical for this product type; the exact limits depend on the version and are confirmed in our quotation.')}</p>`
            : '<div class="mb-5"></div>';
        const industryTags = industries.length ? `<h3 class="info-title">${T('Typical industries')}</h3>`
            + `<div class="flex flex-wrap gap-1 mb-5">${industries.map((name) => `<span class="tag">${esc(name)}</span>`).join('')}</div>`
            : '';
        const services = catalog.info.service
            .map((text) => `<li class="flex gap-2"><span class="text-brand-orange">✓</span>${esc(text)}</li>`).join('');

        showProductDialog(`
            ${dialogMedia(product)}
            <div class="p-6 overflow-y-auto">
                <p class="eyebrow">${esc(product.brand)} · ${esc(ehCategory(product.category).name)}</p>
                <h2 id="pd-title" class="text-2xl font-bold text-brand-ink mb-1">${esc(product.name)}</h2>
                <p class="mb-5">${esc(product.type)}</p>
                <h3 class="info-title">${T('Overview')}</h3>
                <div class="space-y-3 mb-5">${paragraphs.map((text) => `<p>${esc(text)}</p>`).join('')}</div>
                ${howItWorks}
                <h3 class="info-title">${T('Key data')}</h3>
                <table class="size-table mb-2"><tbody>${specRows(specs)}</tbody></table>
                ${specsNote}
                ${industryTags}
                ${datasheetInfo(product)}
                <h3 class="info-title">${T('Supplied by VIS')}</h3>
                <ul class="space-y-1 mb-6">${services}</ul>
                <div class="flex gap-3 flex-wrap">${addButton(product.id)}
                    ${variable ? applicatorButton(variable) : ''}</div>
            </div>`);
    }

    /** Links to the portfolio items of a technology, one line per brand (Emerson first), at most `limit` per brand. */
    function portfolioLinks(techId, limit = 6) {
        return PORTFOLIO_BRANDS.map((brand) => {
            const items = portfolioFor(techId, brand);
            if (!items.length) return '';
            // Lead with the main product line of this technology (e.g. Promass before Cubemass).
            const lineCount = {};
            items.forEach((product) => { lineCount[product.family] = (lineCount[product.family] || 0) + 1; });
            const countOf = (product) => (product.family ? lineCount[product.family] : 0);
            items.sort((a, b) => (countOf(b) - countOf(a)) || finderOrder(a, b));

            const links = items.slice(0, limit).map((product) => `<button type="button"
                class="underline decoration-brand-line hover:text-brand-orange-dark mr-2"
                data-details="${esc(product.id)}">${esc(product.name)}</button>`);
            const allLink = items.length > limit
                ? `<button type="button" class="font-semibold text-brand-orange-dark hover:underline"
                    data-tech="${esc(techId)}">${T('All {n} →', { n: items.length })}</button>`
                : '';
            return `<p class="text-xs mt-3"><strong class="text-brand-ink">${esc(brand)}:</strong>
                ${links.join('')}
                ${allLink}</p>`;
        }).join('');
    }

    /** Brand window for brands without a full portfolio: the technology families we supply from them. */
    function openBrand(brand) {
        const families = catalog.products.filter((product) => product.brands.includes(brand));
        const tiles = families.map((product) => `<button type="button"
                class="text-left border border-brand-line hover:border-brand-orange flex gap-3 items-center p-2"
                data-details="${esc(product.id)}">
                <img src="${esc(imageOf(product))}" alt="" class="w-20 h-12 object-cover border border-brand-line">`
                + `<span class="text-sm font-semibold text-brand-ink">${esc(product.name)}</span></button>`).join('');
        const intro = T('Product families we supply from {brand}. Send us the order code or your requirements for a quotation.', { brand: esc(brand) });
        showProductDialog(`<div class="relative p-6 pr-14 border-b border-brand-line">${closeIcon()}
                <p class="eyebrow">${T('Brand')}</p><h2 id="pd-title" class="text-2xl font-bold text-brand-ink mb-2">${esc(brand)}</h2>
                <p>${intro}</p></div>
            <div class="p-6"><div class="grid sm:grid-cols-2 gap-3">${tiles}</div></div>`);
    }

    /** Technology categories that the Applicator can check. */
    const APPLICATOR_CATEGORIES = ['flow', 'level', 'pressure', 'temperature', 'analysis'];

    /** Details window of any product; portfolio items get their own layout (openPortfolio). */
    function openProduct(id) {
        const product = byId.get(id);
        if (isPortfolio(product)) return openPortfolio(product);

        const industries = industryNames(product.industries);
        const specs = [
            [T('Media'), product.media.map(mediumLabel).join(', ')],
            [T('Max. process temperature'), product.tempMax != null ? `${product.tempMax} °C` : null],
            [T('Max. process pressure'), product.pressureMax != null ? `${product.pressureMax} bar` : null],
            [T('Typical accuracy'), accuracyText(product)],
            [T('Hazardous area (Ex)'), product.ex ? T('Available') : null],
            [T('Hygienic design'), product.hygienic ? T('Available') : null],
        ].filter(([, value]) => value);

        const specsTable = specs.length ? `<table class="size-table mb-5"><tbody>${specRows(specs)}</tbody></table>` : '';
        const brandTags = product.brands.map((brand) => `<span class="tag mr-1 mb-1">${esc(brand)}</span>`).join('');
        const industryLine = industries.length
            ? `<p class="text-sm mb-2"><strong class="text-brand-ink">${T('Industries:')}</strong> ${esc(industries.join(', '))}</p>`
            : '';

        showProductDialog(`
            ${dialogMedia(product)}
            <div class="p-6 overflow-y-auto">
                <p class="eyebrow">${esc(category(product.category).name)}</p>
                <h2 id="pd-title" class="text-2xl font-bold text-brand-ink mb-3">${esc(product.name)}</h2>
                <p class="mb-5"><strong class="text-brand-ink">${T('Measuring principle:')}</strong> ${esc(product.principle)}</p>
                ${highlightList(product.highlights)}
                ${specsTable}
                <p class="text-sm mb-2"><strong class="text-brand-ink">${T('Brands:')}</strong> ${brandTags}</p>
                ${industryLine}
                <div class="mb-6">${portfolioLinks(product.id, 8)}</div>
                ${datasheetInfo(product)}
                <div class="flex gap-3 flex-wrap">${addButton(product.id)}
                ${APPLICATOR_CATEGORIES.includes(product.category) ? applicatorButton(product.category) : ''}</div>
            </div>`);
    }

    // ---------- Applicator ----------
    /** List of "ⓘ note" items ('' when there are no notes). */
    const noteList = (notes, classes) => (notes.length
        ? `<ul class="${classes}">${notes.map((note) => `<li>ⓘ ${esc(note)}</li>`).join('')}</ul>`
        : '');

    /** One suitable technology in the Applicator result; the first one (rank 0) is the best match. */
    function suitableResult(result, rank) {
        const isBest = rank === 0;
        const bestTag = isBest ? `<span class="tag tag-orange ml-1">${T('Best match')}</span>` : '';
        return `
            <div class="result ${isBest ? 'border-brand-orange border-l-4' : ''}">
                <div class="flex flex-wrap justify-between gap-3 mb-2">
                    <div class="flex gap-4 items-start">`
                    + `<img src="${esc(imageOf(byId.get(result.id)))}" alt=""
                        class="hidden sm:block w-28 h-16 object-cover border border-brand-line shrink-0">
                    <div><h3 class="font-bold text-brand-ink">${esc(result.name)} ${bestTag}</h3>
                    <p class="text-sm">${esc(result.principle)}</p></div></div>
                    <div class="text-right shrink-0">`
                    + `<p class="text-2xl font-bold text-brand-ink">${result.score}<span class="text-sm font-normal">/100</span></p></div>
                </div>
                <div class="score-bar mb-3"><span style="width:${result.score}%"></span></div>
                ${noteList(result.notes, 'text-sm mb-3 space-y-1')}
                ${sizingBlock(result.sizing)}
                <div class="mb-3">${portfolioLinks(result.id, 4)}</div>
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <p class="text-xs"><strong class="text-brand-ink">${T('Brands:')}</strong> ${esc(result.brands.join(', '))}</p>
                    <div class="flex gap-2">${addButton(result.id)}`
                    + `<button type="button" class="btn-small" data-details="${esc(result.id)}">${T('Details')}</button></div>
                </div>
            </div>`;
    }

    /** Folded list of the technologies that do not fit, with the reasons ('' if none). */
    function unsuitableList(unsuitable) {
        if (!unsuitable.length) return '';
        const rows = unsuitable.map((result) => `<li class="bg-white border border-brand-line p-3">`
            + `<strong class="text-brand-ink">${esc(result.name)}</strong> — ${esc(result.reasons.join(' '))}</li>`).join('');
        return `
            <details class="mt-6">`
            + `<summary class="cursor-pointer text-sm font-semibold text-brand-ink">${T('Not suitable ({n})', { n: unsuitable.length })}</summary>
                <ul class="mt-3 space-y-2 text-sm">${rows}</ul></details>`;
    }

    /** Message when no technology fits, with a link to the contact form. */
    const noResult = () => '<div class="result border-l-4 border-red-500">'
        + `<p class="font-semibold text-brand-ink">${T('No standard technology fits these conditions.')}</p>`
        + `<p class="text-sm mt-1">${T('Send us your requirements, our engineers can propose a special solution.')}</p>`
        + `<a href="#contact" class="btn-small inline-block mt-3">${T('Contact an engineer')}</a></div>`;

    /** Renders the answer of /api/applicator/select: { suitable: [...], unsuitable: [...] }. */
    function renderSelection(answer) {
        const { suitable, unsuitable } = answer;
        let html;
        if (suitable.length) {
            const count = suitable.length === 1
                ? T('{n} suitable technology for your conditions:', { n: '<strong class="text-brand-ink">1</strong>' })
                : T('{n} suitable technologies for your conditions:', { n: `<strong class="text-brand-ink">${suitable.length}</strong>` });
            html = `<p class="text-sm mb-4">${count}</p>${suitable.map(suitableResult).join('')}`;
        } else {
            html = noResult();
        }
        const target = $('#select-result');
        stagger(target, '.result', () => { target.innerHTML = html + unsuitableList(unsuitable); });
    }

    /** Pipe sizes that are out of range are only listed if they are your pipe or near the recommendation (± this DN). */
    const NEAR_RECOMMENDED_DN = 100;

    /** Flow sizing: one table row per nominal diameter with velocity and assessment. */
    function flowSizingTable(sizing) {
        const label = { optimal: T('Optimal'), ok: T('Possible'), out: T('Out of range') };
        const isYourPipe = (row) => row.dn === sizing.pipe?.dn;
        const rows = sizing.rows
            .filter((row) => row.status !== 'out' || isYourPipe(row)
                || Math.abs(row.dn - (sizing.recommended || 0)) < NEAR_RECOMMENDED_DN)
            .map((row) => `
                <tr class="${row.dn === sizing.recommended ? 'recommended' : ''}">`
                + `<td>DN ${row.dn}${isYourPipe(row) ? ` <span class="tag ml-1">${T('your pipe')}</span>` : ''}</td>`
                + `<td>${row.velocity} m/s</td>
                <td><span class="dot dot-${row.status}"></span>${label[row.status]}</td></tr>`).join('');
        return '<table class="size-table">'
            + `<thead><tr><th>${T('Nominal diameter')}</th><th>${T('Velocity')}</th><th>${T('Assessment')}</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
    }

    /** Sizing of one recommended technology: key result on top, the details (table, notes) folded away. */
    function sizingBlock(sizing) {
        if (!sizing) return '';
        const isFlow = sizing.variable === 'flow';
        let headline;
        let sub = '';
        let table;
        if (isFlow) {
            headline = sizing.recommended
                ? T('Recommended size: DN {dn}', { dn: sizing.recommended })
                : T('No standard pipe size fits this flow rate');
            if (sizing.recommended) {
                sub = T('{flow} m³/h · optimal velocity {min}–{max} m/s', {
                    flow: sizing.flow, min: sizing.window.optMin, max: sizing.window.optMax,
                });
            }
            table = flowSizingTable(sizing);
        } else {
            headline = sizing.fail ? T('Not possible: {reason}', { reason: sizing.fail }) : sizing.headline;
            table = `<table class="size-table"><tbody>${specRows(sizing.summary, 'w-2/5')}</tbody></table>`;
        }
        // With a given pipe, the first note compares it with the recommendation: shown right away.
        const pipeNote = isFlow && sizing.pipe ? `<p class="text-sm mt-1">${esc(sizing.notes[0])}</p>` : '';
        const failed = sizing.fail || (isFlow && !sizing.recommended);
        return `<div class="sizing ${failed ? 'sizing-fail' : ''}">
            <p class="text-xs font-semibold uppercase tracking-wider text-brand-orange-dark">${T('Sizing')}</p>
            <p class="font-bold text-brand-ink">${esc(headline)}</p>${sub ? `<p class="text-sm">${esc(sub)}</p>` : ''}${pipeNote}
            <details class="mt-2"><summary class="cursor-pointer text-sm font-semibold text-brand-ink">${T('Sizing details')}</summary>
                <div class="overflow-x-auto mt-2">${table}</div>
                ${noteList(sizing.notes, 'text-sm mt-3 space-y-1')}
                <p class="text-xs mt-2">${T('Guidance only; final sizing is confirmed by our engineers.')}</p></details></div>`;
    }

    /** Sends a form as JSON to `url` and passes the answer to `render`; errors are shown in `target`. */
    async function submitTo(form, url, render, target) {
        const button = $('button', form);
        const data = Object.fromEntries(new FormData(form).entries());
        // FormData leaves out unchecked boxes: send every checkbox as true / false.
        $$('input[type="checkbox"]', form).forEach((box) => { data[box.name] = box.checked; });
        data.lang = LANG; // results and messages in the visitor's language
        button.disabled = true;
        try {
            render(await postJson(url, data));
        } catch (err) {
            const message = err.message === 'Failed to fetch' ? T('Could not reach the server.') : err.message;
            $(target).innerHTML = `<div class="result border-l-4 border-red-500 text-sm">${esc(message)}</div>`;
        } finally {
            button.disabled = false;
        }
    }

    /** Applicator: show only the sizing fields of the chosen variable (hidden fields are disabled, so they are not sent). */
    function updateSizingForm() {
        const variable = $('#s-variable').value;
        $$('[data-for-var]').forEach((group) => {
            const on = group.dataset.forVar === variable;
            group.classList.toggle('hidden', !on);
            $$('input, select', group).forEach((el) => { el.disabled = !on; });
        });
    }

    /** Conductivity only matters for flow of liquids / slurries (magnetic flowmeters); otherwise hide and clear it. */
    function updateConductivity() {
        const show = $('#s-variable').value === 'flow' && ['liquid', 'slurry'].includes($('#s-medium').value);
        $('#s-conductivity-wrap').classList.toggle('hidden', !show);
        if (!show) $('#s-conductivity').value = '';
    }

    /** Opens the Applicator with a variable preselected and runs the check right away. */
    function openApplicator(variable) {
        $('#product-dialog').close();
        $('#s-variable').value = variable;
        updateConductivity();
        updateSizingForm();
        $('#select-form').requestSubmit();
        $('#applicator').scrollIntoView({ behavior: 'smooth' });
    }

    // ---------- Industries, brands, FAQ, ICSS, menus ----------
    /** Shows the panel of one industry tab with its recommended products. */
    function renderIndustry(id) {
        const industry = catalog.industries.find((ind) => ind.id === id);
        $$('.industry-tab').forEach((tab) => {
            const on = tab.dataset.industry === id;
            tab.setAttribute('aria-selected', String(on));
            tab.tabIndex = on ? 0 : -1;
        });
        const panel = $('#industry-panel');
        panel.setAttribute('aria-labelledby', `ind-${id}`);
        replay(panel, 'anim-fade');

        const tiles = industry.products.filter((pid) => byId.has(pid)).map((pid) => {
            const product = byId.get(pid);
            return `<button type="button" class="text-left border border-brand-line hover:border-brand-orange transition-colors"
                data-details="${esc(pid)}">
                <img src="${esc(imageOf(product))}" alt="" loading="lazy" class="w-full h-24 object-cover border-b border-brand-line">`
                + `<span class="block p-4">
                    <span class="block text-xs font-semibold uppercase tracking-wider text-brand-orange-dark">${esc(category(product.category).name)}</span>
                    <span class="block font-semibold text-brand-ink text-sm mt-1">${esc(product.name)}</span></span></button>`;
        }).join('');
        panel.innerHTML = `
            <h3 class="text-2xl font-bold text-brand-ink mb-3">${esc(industry.name)}</h3>
            <p class="mb-6 max-w-3xl">${esc(industry.text)}</p>
            <p class="filter-label mb-3">${T('Recommended products')}</p>
            <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">${tiles}</div>`;
    }

    /** Mega menu: one entry per category with the product count per brand (e.g. "120 Emerson · 85 E+H"). */
    function renderMegaMenu() {
        const count = (catId, brand) => catalog.eh.filter((product) => product.category === catId && product.brand === brand).length;
        const shortBrand = (brand) => (brand === 'Endress+Hauser' ? 'E+H' : brand);
        $('#mega-menu').innerHTML = catalog.ehCategories.map((cat) => {
            const counts = PORTFOLIO_BRANDS.filter((brand) => count(cat.id, brand))
                .map((brand) => `${count(cat.id, brand)} ${shortBrand(brand)}`).join(' · ');
            return `
            <a href="#products" class="mega-item" data-category="${esc(cat.id)}"><img src="${esc(cat.image)}" alt="">
                <span><strong>${esc(cat.name)}</strong><small>${counts}</small></span></a>`;
        }).join('');
    }

    /** Brand buttons: portfolio brands open the finder, the others a brand window. */
    function renderBrands() {
        $('#brand-list').innerHTML = catalog.brands.map((brand) => {
            const isFull = PORTFOLIO_BRANDS.includes(brand);
            let label;
            if (isFull) {
                label = T('{n} products', { n: fmt(catalog.eh.filter((product) => product.brand === brand).length) });
            } else {
                const n = catalog.products.filter((product) => product.brands.includes(brand)).length;
                label = n === 1 ? T('1 product family') : T('{n} product families', { n });
            }
            return `<button type="button" class="brand-btn ${isFull ? '!border-brand-orange' : ''}" data-brand="${esc(brand)}">`
                + `${esc(brand)}<small>${label}</small></button>`;
        }).join('');
    }

    /** Builds the parts of the page that only depend on the catalog (rendered once at start-up). */
    function buildStatic() {
        renderMegaMenu();
        renderFilterOptions();
        $('#footer-products').innerHTML = catalog.ehCategories.map((cat) =>
            `<li><a href="#products" class="hover:text-white" data-category="${esc(cat.id)}">${esc(cat.name)}</a></li>`).join('');

        renderBrands();

        $('#industry-list').innerHTML = catalog.industries.map((industry) => `<button type="button" role="tab" id="ind-${esc(industry.id)}"
            class="industry-tab" data-industry="${esc(industry.id)}" aria-controls="industry-panel">${esc(industry.name)}</button>`).join('');
        renderIndustry(catalog.industries[0].id);

        $('#faq-list').innerHTML = catalog.faq
            .map((entry) => `<details class="faq"><summary>${esc(entry.q)}</summary><p>${esc(entry.a)}</p></details>`).join('');
        renderIcss();
    }

    /** ICSS specification: each requirement with the products that meet it (catalog.json → icss). */
    function renderIcss() {
        const { intro, requirements } = catalog.icss;
        $('#icss-intro').textContent = intro;
        $('#icss-list').innerHTML = requirements.map((req) => {
            const products = req.products.filter((id) => byId.has(id)).map((id) => `<li>
                <button type="button" class="icss-product" data-details="${esc(id)}">`
                + `${esc(byId.get(id).name)}<span aria-hidden="true">→</span></button></li>`).join('');
            const serviceLink = req.services
                ? `<a href="#services" class="icss-product mt-auto">${T('VIS service & support')}<span aria-hidden="true">→</span></a>`
                : '';
            const datasheetNote = req.datasheet
                ? `<p class="icss-note">${T('Shutdown valves themselves are quoted with a valve datasheet: add the valve to your inquiry list.')}</p>`
                : '';
            return `<article class="icss-card">
                <p class="icss-ref">${T('Spec {ref}', { ref: esc(req.ref) })}</p>
                <h3>${esc(req.title)}</h3>
                <p class="text-sm mb-4">${esc(req.text)}</p>
                <ul class="mt-auto space-y-1.5">${products}</ul>
                ${serviceLink}
                ${datasheetNote}
            </article>`;
        }).join('');
    }

    /** "Quote against your ICSS specification": start the contact form with a short template (if it is still empty). */
    function startIcssInquiry() {
        const message = $('#f-message');
        if (!message.value.trim()) {
            message.value = T('We would like a quotation against our ICSS specification (the document follows by email).\n\nProject / site:\nScope (BPCS, SIS, F&G, asset management, …):\nApprox. number of I/O:\nRequired SIL:\nSchedule:');
        }
        $('#contact').scrollIntoView({ behavior: 'smooth' });
        // Focus after the smooth scroll, otherwise the browser jumps.
        setTimeout(() => message.focus({ preventScroll: true }), 400);
    }

    // ---------- Events: click actions ----------
    /** Removes an inquiry row, after its leave animation unless the visitor prefers reduced motion. */
    function removeInquiryRow(button) {
        const id = button.dataset.remove;
        const row = button.closest('.inq-item');
        if (row && !prefersReducedMotion()) {
            row.classList.add('leaving');
            row.addEventListener('animationend', () => inquiry.remove(id), { once: true });
        } else {
            inquiry.remove(id);
        }
    }

    /** "Clear list" needs a second click within a few seconds. */
    function confirmClearList(button) {
        if (button.classList.contains('confirm')) {
            inquiry.clear();
            return;
        }
        const label = button.querySelector('span');
        button.classList.add('confirm');
        label.textContent = T('Click again to clear');
        clearTimeout(button.timer);
        button.timer = setTimeout(() => {
            button.classList.remove('confirm');
            label.textContent = T('Clear list');
        }, CLEAR_CONFIRM_MS);
    }

    /**
     * Category link: a chip in the finder only changes the category; links elsewhere (menu, footer)
     * start a fresh search in that category and scroll to the finder.
     */
    function chooseCategory(link) {
        const inFinder = Boolean(link.closest('#filter-category'));
        const patch = inFinder ? { category: link.dataset.category } : { ...EMPTY_FILTERS, category: link.dataset.category };
        setFilter(patch, !inFinder);
    }

    /** Portfolio brands are searched in the finder; other brands open their brand window. */
    function chooseBrand(brand) {
        if (PORTFOLIO_BRANDS.includes(brand)) setFilter({ ...EMPTY_FILTERS, text: brand }, true);
        else openBrand(brand);
    }

    /** Elements handled by the global click listener (by data-* attribute). */
    const ACTION_SELECTOR = '[data-add],[data-remove],[data-details],[data-category],[data-brand],[data-tech],'
        + '[data-industry],[data-close],[data-reset],[data-applicator],#inquiry-clear';

    /** Global click delegation for all buttons that are rendered dynamically. */
    function onDocumentClick(e) {
        // +/− next to an "Add to inquiry" button.
        const step = e.target.closest('[data-addstep]');
        if (step) {
            const input = $('[data-addqty]', step.parentElement);
            input.value = clampQty((parseInt(input.value, 10) || 1) + Number(step.dataset.addstep));
            return;
        }
        if (e.target.closest('[data-inquiry-open]')) {
            $('#product-dialog').close();
            $('#inquiry-dialog').showModal();
            return;
        }
        if (e.target.closest('[data-icss-quote]')) {
            e.preventDefault();
            startIcssInquiry();
            return;
        }

        const target = e.target.closest(ACTION_SELECTOR);
        if (!target) return;
        const data = target.dataset;
        if (data.add) {
            inquiry.add(data.add, parseInt($('[data-addqty]', target.parentElement)?.value, 10));
        } else if (data.remove) {
            removeInquiryRow(target);
        } else if (data.details) {
            openProduct(data.details);
        } else if (data.category !== undefined) {
            e.preventDefault();
            chooseCategory(target);
        } else if (data.brand) {
            chooseBrand(data.brand);
        } else if (data.tech) {
            $('#product-dialog').close();
            setFilter({ ...EMPTY_FILTERS, tech: data.tech }, true);
        } else if (data.industry) {
            renderIndustry(data.industry);
        } else if (data.reset !== undefined) {
            resetFilters();
        } else if (data.applicator) {
            openApplicator(data.applicator);
        } else if (target.id === 'inquiry-clear') {
            confirmClearList(target);
            return;
        }
        if (data.close !== undefined) target.closest('dialog').close();
    }

    /**
     * +/− buttons of the quantity fields in a list (inquiry window: data-step, contact form: data-cstep).
     * The list is re-rendered, so the focus is put back on the same button afterwards.
     */
    function bindQtyStepper(container, attr) {
        container.addEventListener('click', (e) => {
            const button = e.target.closest(`[data-${attr}]`);
            if (!button) return;
            const item = inquiry.find(button.dataset.for);
            if (!item) return;
            inquiry.setQty(item.id, item.qty + Number(button.dataset[attr]));
            $(`[data-for="${CSS.escape(item.id)}"][data-${attr}="${button.dataset[attr]}"]`)?.focus();
        });
    }

    // ---------- Events: binding ----------
    /** Industry tabs: arrow keys move to the previous / next tab (wrapping around). */
    function onIndustryKey(e) {
        if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
        e.preventDefault();
        const tabs = $$('.industry-tab');
        const current = tabs.indexOf(document.activeElement);
        const forward = ['ArrowDown', 'ArrowRight'].includes(e.key);
        const next = tabs[(current + (forward ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        renderIndustry(next.dataset.industry);
    }

    /** Dialogs: close on backdrop click; lock page scrolling while one is open; start at the top when opened. */
    function setupDialogs() {
        const syncLock = () => document.documentElement.classList.toggle('modal-open', $$('dialog').some((d) => d.open));
        $$('dialog').forEach((dialog) => {
            dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
            dialog.addEventListener('close', syncLock);
            // Wrap showModal: safe to call when already open, and the details window scrolls back to the top.
            const show = dialog.showModal.bind(dialog);
            dialog.showModal = () => {
                if (!dialog.open) show();
                syncLock();
                const scroller = $('#product-dialog-body > :last-child', dialog);
                if (scroller) scroller.scrollTop = 0;
            };
        });
    }

    /** Mobile menu toggle; returns the function that closes the menu. */
    function setupMobileMenu() {
        const toggle = $('#menu-toggle');
        const menu = $('#mobile-menu');
        const close = () => {
            menu.classList.remove('open');
            menu.setAttribute('aria-hidden', 'true');
            toggle.setAttribute('aria-expanded', 'false');
        };
        toggle.addEventListener('click', () => {
            const open = menu.classList.toggle('open');
            menu.setAttribute('aria-hidden', String(!open));
            toggle.setAttribute('aria-expanded', String(open));
        });
        $$('a', menu).forEach((link) => link.addEventListener('click', close));
        return close;
    }

    /** Binds all page events except the contact form (bindContact). Called once the catalog is loaded. */
    function bindEvents() {
        document.addEventListener('click', onDocumentClick);
        $('#industry-list').addEventListener('keydown', onIndustryKey);

        // Enter in an "Add" quantity field adds the product.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('[data-addqty]')) {
                e.preventDefault();
                $('[data-add]', e.target.closest('.add-group')).click();
            }
        });

        // Inquiry list window
        $('#inquiry-body').addEventListener('change', (e) => {
            if (e.target.dataset.qty) inquiry.setQty(e.target.dataset.qty, parseInt(e.target.value, 10));
        });
        bindQtyStepper($('#inquiry-body'), 'step');
        $('#inquiry-open').addEventListener('click', () => $('#inquiry-dialog').showModal());
        $('#inquiry-submit').addEventListener('click', () => $('#inquiry-dialog').close());
        setupDialogs();

        // Filters
        $('#filter-text').addEventListener('input', (e) => setFilter({ text: e.target.value.trim() }));
        $('#filter-tech').addEventListener('change', (e) => setFilter({ tech: e.target.value }));
        $('#filter-family').addEventListener('change', (e) => setFilter({ family: e.target.value }));
        $('#filter-reset').addEventListener('click', resetFilters);
        $('#product-more').addEventListener('click', () => {
            shown += PAGE_SIZE * 2;
            animateGrid = 'more';
            renderProducts();
            animateGrid = false;
        });
        const closeMobileMenu = setupMobileMenu();
        // Header search (desktop and mobile): a fresh search in the finder.
        ['#search-form', '#search-form-mobile'].forEach((sel) => $(sel).addEventListener('submit', (e) => {
            e.preventDefault();
            setFilter({ ...EMPTY_FILTERS, text: $('input', e.target).value.trim() }, true);
            closeMobileMenu();
        }));

        // Applicator
        $('#select-form').addEventListener('submit', (e) => {
            e.preventDefault();
            submitTo(e.target, '/api/applicator/select', renderSelection, '#select-result');
        });
        $('#s-medium').addEventListener('change', updateConductivity);
        $('#s-variable').addEventListener('change', () => {
            updateConductivity();
            updateSizingForm();
        });
    }

    // ---------- Scroll reveal ----------
    /** Sections and cards below the fold fade in when they are scrolled into view. */
    function setupReveal() {
        if (!('IntersectionObserver' in window) || prefersReducedMotion()) return;
        const targets = $$('main > section > div, #products .card');
        const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('revealed');
            observer.unobserve(entry.target);
        }), { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
        targets.forEach((el) => {
            if (el.getBoundingClientRect().top < innerHeight) return; // already visible: no animation
            el.classList.add('reveal');
            observer.observe(el);
        });
    }

    // ---------- Contact form ----------
    /**
     * Valve datasheet input: keep the value (no re-render, so the focus stays),
     * then update progress text, hint and the status line in the inquiry window.
     */
    function onDatasheetInput(e) {
        const { dsItem: id, dsField: field } = e.target.dataset;
        if (!id) return;
        inquiry.setDs(id, field, e.target.value);
        const item = inquiry.find(id);
        const sel = CSS.escape(id);
        const complete = dsComplete(item);
        const showStatus = (el) => {
            el.textContent = dsStatus(item);
            el.classList.toggle('ds-ok', complete);
        };

        showStatus($(`[data-ds-progress="${sel}"]`));
        const hint = $(`[data-ds-hint="${sel}"]`);
        hint.textContent = `ⓘ ${dsHint(item)}`;
        hint.classList.toggle('hidden', !dsHint(item));
        const inquiryStatus = $(`[data-ds-status="${sel}"]`);
        if (inquiryStatus) showStatus(inquiryStatus);
    }

    /** Quantity and tag-number changes of the products in the contact form. */
    function onContactItemChange(e) {
        if (e.target.dataset.cqty) {
            inquiry.setQty(e.target.dataset.cqty, parseInt(e.target.value, 10));
            return;
        }
        const id = e.target.dataset.tag;
        if (!id) return;
        inquiry.setTag(id, e.target.checked);
        const input = $(`[data-tagno="${CSS.escape(id)}"]`);
        input.classList.toggle('hidden', !e.target.checked);
        if (e.target.checked) input.focus();
        syncTagAll();
    }

    /** Form data for /api/contact: the form fields plus the inquiry items (with tag numbers and datasheets). */
    function contactPayload(form) {
        const payload = Object.fromEntries(new FormData(form).entries());
        delete payload['tag-all'];
        // Datasheet radios (ds<n>-<field>): their values are sent per item below.
        Object.keys(payload).filter((key) => /^ds\d+-/.test(key)).forEach((key) => delete payload[key]);
        payload.lang = LANG;
        payload.items = listedItems().map(({ id, qty, tag, tagNo, ds }) => ({
            id,
            qty,
            tag: !!tag,
            tagNo: tag ? (tagNo || '').trim() : '',
            ...(byId.get(id).datasheet && { datasheet: ds || {} }),
        }));
        return payload;
    }

    /** Binds the contact form and the inquiry items inside it. Called first at start-up (works without the catalog). */
    function bindContact() {
        const form = $('#contact-form');
        const status = $('#form-status');
        const list = $('#contact-items-list');

        $('#tag-all').addEventListener('change', (e) => inquiry.setTagAll(e.target.checked));
        bindQtyStepper(list, 'cstep');
        list.addEventListener('change', onContactItemChange);
        list.addEventListener('input', (e) => {
            if (e.target.dataset.tagno) inquiry.setTagNo(e.target.dataset.tagno, e.target.value);
        });
        list.addEventListener('input', onDatasheetInput);
        list.addEventListener('change', onDatasheetInput);

        /** Success (green) or error (red) message under the form. */
        const showResult = (msg, ok) => {
            status.textContent = msg;
            status.classList.remove('hidden', 'text-red-600', 'text-green-700');
            status.classList.add(ok ? 'text-green-700' : 'text-red-600');
        };

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const button = $('button[type="submit"]', form);
            const payload = contactPayload(form);
            button.disabled = true;
            try {
                await postJson('/api/contact', payload);
                showResult(T('Thank you for your inquiry. An engineer in Azerbaijan will contact you shortly.'), true);
                form.reset();
                inquiry.clear();
            } catch (err) {
                const offline = err.message === 'Failed to fetch';
                showResult(offline ? T('Could not reach the server. Please try again later.') : err.message, false);
            } finally {
                button.disabled = false;
            }
        });
    }

    // ---------- Start ----------
    /** Fills the lookup maps and the product-line sizes used for sorting. */
    function indexCatalog() {
        catalog.products.forEach((tech) => {
            byId.set(tech.id, tech);
            techById.set(tech.id, tech);
        });
        catalog.eh.forEach((product) => {
            byId.set(product.id, product);
            if (product.family) familySize[product.family] = (familySize[product.family] || 0) + 1;
        });
        rankFeatured();
    }

    document.addEventListener('DOMContentLoaded', async () => {
        bindContact();
        try {
            // Catalog and translations load in parallel; both are needed before rendering.
            const [res] = await Promise.all([fetch(`/api/catalog?lang=${LANG}`), window.I18N.ready]);
            if (!res.ok) throw new Error();
            catalog = await res.json();
        } catch {
            $('#catalog-error').classList.remove('hidden');
            return;
        }
        $('#year').textContent = new Date().getFullYear(); // after I18N.ready: the footer sentence is translated as one unit
        indexCatalog();
        buildStatic();
        setupReveal();
        bindEvents();
        updateConductivity();
        updateSizingForm();
        renderProducts();
        renderInquiry();
    });
})();
