/** main.js — VIS website: catalog, filters, Applicator, inquiry list, contact form. */
(() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Translation (js/i18n.js): T('English text with {placeholders}', vars). Keys must be literal strings (tools/i18n-check.mjs).
    const { t: T, lang: LANG, locale: LOCALE } = window.I18N;
    const fmt = (n) => n.toLocaleString(LOCALE);
    const mediumLabel = (m) => ({ liquid: T('Liquid'), gas: T('Gas'), steam: T('Steam'), slurry: T('Slurry'), solid: T('Bulk solid') }[m]);

    let catalog = null;
    const byId = new Map();
    const techById = new Map();
    // Emerson is the lead brand: its products come first in the finder and in every product list.
    const LEAD_BRAND = 'Emerson';
    const PORTFOLIO_BRANDS = ['Emerson', 'Endress+Hauser'];
    const EMPTY = { text: '', category: '', tech: '', family: '' };
    const state = { ...EMPTY };
    const PAGE = 24;
    let shown = PAGE;

    // ---------- Small helpers ----------
    // Restart a CSS animation on an element.
    const replay = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
    // Render, then fade the matching children in one after another.
    const stagger = (root, sel, render) => { render(); $$(sel, root).forEach((el, i) => { el.style.setProperty('--i', Math.min(i, 8)); el.classList.add('anim-in'); }); };
    const toast = (msg) => {
        const t = $('#toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
    };
    async function postJson(url, body) {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || T('Request failed'));
        return data;
    }
    const category = (id) => catalog.categories.find((c) => c.id === id);
    const ehCategory = (id) => catalog.ehCategories.find((c) => c.id === id);
    const isPortfolio = (p) => Boolean(p.url); // manufacturer portfolio item (Emerson / E+H), not a technology family
    const catName = (p) => (isPortfolio(p) ? ehCategory(p.category) : category(p.category)).name;
    // Real photos are shown whole on white; illustrations fill the frame.
    const hasPhoto = (p) => isPortfolio(p) && Boolean(p.image);
    const imageOf = (p) => {
        if (!isPortfolio(p)) return p.image || category(p.category).image;
        if (p.image) return p.image;
        return p.tech && techById.has(p.tech) ? techById.get(p.tech).image : ehCategory(p.category).image;
    };
    // Model number from the product name, e.g. "Rosemount 3051S Pressure Transmitter Family" -> "3051S".
    const modelOf = (p) => (p.family ? p.name.slice(p.name.toLowerCase().startsWith(p.family.toLowerCase()) ? p.family.length : 0) : p.name)
        .split(' ').filter((w) => /\d/.test(w)).join(' ');
    const imgFit = (p) => (hasPhoto(p) ? 'object-contain bg-white p-2' : 'object-cover');
    const ehFor = (techId, brand) => catalog.eh.filter((p) => p.tech === techId && (!brand || p.brand === brand)).sort(finderOrder);
    const accuracyText = (p) => (p.accuracy == null ? null : `±${p.accuracy} ${p.accuracyUnit || '%'}`);

    // ---------- Inquiry list (kept in the browser) ----------
    const inquiry = {
        items: (() => { try { return JSON.parse(localStorage.getItem('vis-inquiry')) || []; } catch { return []; } })(),
        persist() { try { localStorage.setItem('vis-inquiry', JSON.stringify(this.items)); } catch { /* private mode */ } },
        save() { this.persist(); renderInquiry(); },
        has(id) { return this.items.some((i) => i.id === id); },
        add(id, qty = 1) {
            qty = Math.min(999, Math.max(1, qty || 1));
            if (!this.has(id)) this.items.push({ id, qty });
            this.save();
            replay($('#inquiry-count'), 'anim-pop');
            const name = `${qty > 1 ? `${qty} × ` : ''}${byId.get(id)?.name || T('Product')}`;
            toast(byId.get(id)?.datasheet
                ? T('{name} added to inquiry list, please fill in the valve datasheet in the contact form', { name })
                : T('{name} added to inquiry list', { name }));
        },
        remove(id) { this.items = this.items.filter((i) => i.id !== id); this.save(); },
        setQty(id, qty) { const i = this.items.find((x) => x.id === id); if (i) { i.qty = Math.min(999, Math.max(1, qty || 1)); this.save(); } },
        clear() { this.items = []; this.save(); },
        // Tag / reference number per product: `tag` = wanted, `tagNo` = the number(s), if the customer already has them.
        setTag(id, on) { const i = this.items.find((x) => x.id === id); if (i) { i.tag = on; this.persist(); } },
        setTagNo(id, value) { const i = this.items.find((x) => x.id === id); if (i) { i.tagNo = value.slice(0, 120); this.persist(); } },
        setTagAll(on) { this.items.forEach((i) => { i.tag = on; }); this.save(); },
        // Valve datasheet values per product (`ds`), entered in the contact form.
        setDs(id, field, value) { const i = this.items.find((x) => x.id === id); if (i) { i.ds = { ...i.ds, [field]: String(value).slice(0, 120) }; this.persist(); } },
    };

    // ---------- Valve datasheet (fields defined in catalog.json → valveDatasheet) ----------
    const dsFields = () => catalog.valveDatasheet.fields;
    const dsRequired = () => dsFields().filter((f) => f.required);
    const dsFilled = (i) => dsRequired().filter((f) => String(i.ds?.[f.id] ?? '').trim() !== '').length;
    const dsLabel = (f) => `${f.label}${f.unit ? ` (${f.unit})` : ''}`;
    const dsStatus = (i) => (dsFilled(i) === dsRequired().length
        ? T('✓ Valve datasheet complete')
        : T('Valve datasheet: {filled} of {total} filled (in the contact form)', { filled: dsFilled(i), total: dsRequired().length }));
    const dsHint = (i) => dsFields().map((f) => f.hints?.[i.ds?.[f.id]]).filter(Boolean).join(' ');

    // Datasheet inputs for one inquiry item in the contact form. `n` keeps the input ids / radio groups unique.
    function datasheetBlock(i, n) {
        const ds = i.ds || {};
        const data = (f) => `data-ds-item="${esc(i.id)}" data-ds-field="${esc(f.id)}"`;
        const field = (f) => {
            const id = `ds${n}-${f.id}`;
            const req = f.required ? ' required' : '';
            const label = `${esc(dsLabel(f))}${f.required ? '' : ` <span class="normal-case font-normal tracking-normal">${T('optional')}</span>`}`;
            if (f.type === 'choice' && f.required) {
                return `<fieldset class="ds-field"><legend class="filter-label">${label}</legend><div class="ds-seg">${f.options.map(([value, text]) => `
                    <label><input type="radio" name="${id}" value="${esc(value)}" ${data(f)}${req}${ds[f.id] === value ? ' checked' : ''}><span>${esc(text)}</span></label>`).join('')}</div></fieldset>`;
            }
            if (f.type === 'choice') {
                return `<div class="ds-field"><label for="${id}" class="filter-label">${label}</label><select id="${id}" class="field" ${data(f)}>
                    <option value="">${T('Not specified')}</option>${f.options.map(([value, text]) => `<option value="${esc(value)}"${ds[f.id] === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
            }
            const attrs = f.type === 'number' ? `type="number" step="any" min="${f.min}" max="${f.max}" inputmode="decimal"` : `type="text" maxlength="${f.max}"${f.suggestions ? ' list="ds-line-sizes"' : ''}`;
            return `<div class="ds-field"><label for="${id}" class="filter-label">${label}</label>
                <input id="${id}" class="field" ${attrs} ${data(f)} value="${esc(ds[f.id] ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${req}></div>`;
        };
        return `<div class="ds-block">
            <div class="flex flex-wrap justify-between gap-x-3 gap-y-1 mb-2"><p class="info-title !mb-0">${T('Valve datasheet')}</p>
                <p class="text-xs ds-progress ${dsFilled(i) === dsRequired().length ? 'ds-ok' : ''}" data-ds-progress="${esc(i.id)}">${esc(dsStatus(i))}</p></div>
            <p class="text-xs mb-3">${esc(catalog.valveDatasheet.intro)}</p>
            <div class="ds-grid">${dsFields().map(field).join('')}</div>
            <p class="text-xs ds-hint mt-2 ${dsHint(i) ? '' : 'hidden'}" data-ds-hint="${esc(i.id)}">ⓘ ${esc(dsHint(i))}</p></div>`;
    }

    // What the datasheet asks for, shown in the product details window of valves and actuators.
    const datasheetInfo = (p) => (p.datasheet ? `<div class="ds-info mb-5"><h3 class="info-title">${T('Valve datasheet for your quotation')}</h3>
        <p class="text-sm mb-2">${T('To quote this product we need at least:')}</p>
        <ol class="ds-info-list">${dsFields().map((f) => `<li>${esc(dsLabel(f))}${f.required ? '' : ` <span class="text-xs">(${T('optional')})</span>`}</li>`).join('')}</ol>
        <p class="text-xs mt-2">${T('Add it to your inquiry list; the contact form asks for these values.')}</p></div>` : '');

    function addButton(id) {
        const added = inquiry.has(id);
        const qty = added ? inquiry.items.find((i) => i.id === id).qty : 1;
        // Not in the list yet: choose the quantity, then add. Already added: show the quantity, click to edit it in the list.
        return `<span class="add-group" data-addwrap="${esc(id)}">${added
            ? `<button type="button" class="btn-small added" data-inquiry-open>${T('✓ In inquiry list · {qty}', { qty })}</button>`
            : `<span class="qty qty-sm" role="group" aria-label="${T('Quantity')}">
                    <button type="button" data-addstep="-1" aria-label="${T('Decrease quantity')}">−</button>
                    <input type="number" min="1" max="999" value="1" data-addqty aria-label="${T('Quantity to add')}">
                    <button type="button" data-addstep="1" aria-label="${T('Increase quantity')}">+</button></span>
               <button type="button" class="btn-small" data-add="${esc(id)}">${T('+ Add to inquiry')}</button>`}</span>`;
    }

    // Items in the inquiry list that are (still) in the catalog.
    const listed = () => inquiry.items.filter((i) => byId.has(i.id));

    function renderInquiry() {
        const items = listed();
        const count = $('#inquiry-count');
        count.textContent = items.length;
        count.classList.toggle('hidden', items.length === 0);

        const trash = '<svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
        $('#inquiry-body').innerHTML = items.length
            ? `<div class="flex items-center justify-between mb-2 px-1">
                <p class="text-sm">${items.length === 1 ? T('{n} product', { n: '<strong class="text-brand-ink">1</strong>' }) : T('{n} products', { n: `<strong class="text-brand-ink">${items.length}</strong>` })}</p>
                <button type="button" id="inquiry-clear" class="btn-clear">${trash}<span>${T('Clear list')}</span></button></div>
            <ul class="space-y-1">${items.map((i) => {
                const p = byId.get(i.id);
                return `<li class="inq-item" data-item="${esc(i.id)}">
                    <img src="${esc(imageOf(p))}" alt="" class="inq-thumb ${imgFit(p)}">
                    <div class="flex-1 min-w-0">
                        <p class="font-semibold text-brand-ink text-sm leading-snug truncate" title="${esc(p.name)}">${esc(p.name)}</p>
                        <p class="text-xs truncate mb-2">${esc(isPortfolio(p) ? `${p.brand} · ${p.type}` : catName(p))}</p>
                        ${p.datasheet ? `<p class="ds-status ${dsFilled(i) === dsRequired().length ? 'ds-ok' : ''}" data-ds-status="${esc(i.id)}">${esc(dsStatus(i))}</p>` : ''}
                        <div class="qty" role="group" aria-label="${T('Quantity for {name}', { name: esc(p.name) })}">
                            <button type="button" data-step="-1" data-for="${esc(i.id)}" aria-label="${T('Decrease quantity')}">−</button>
                            <input type="number" min="1" max="999" value="${i.qty}" data-qty="${esc(i.id)}" aria-label="${T('Quantity')}">
                            <button type="button" data-step="1" data-for="${esc(i.id)}" aria-label="${T('Increase quantity')}">+</button>
                        </div>
                    </div>
                    <button type="button" class="icon-btn" data-remove="${esc(i.id)}" aria-label="${T('Remove {name}', { name: esc(p.name) })}" title="${T('Remove')}">${trash}</button></li>`;
            }).join('')}</ul>`
            : `<div class="text-center py-14 px-4">
                <span class="mx-auto mb-4 w-14 h-14 rounded-full bg-brand-orange-soft text-brand-orange-dark grid place-items-center">
                    <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/></svg></span>
                <p class="font-semibold text-brand-ink mb-1">${T('Your inquiry list is empty')}</p>
                <p class="text-sm">${T('Add products from the product finder or the Applicator.')}</p></div>`;
        $('#inquiry-submit').classList.toggle('hidden', items.length === 0);

        renderContactItems(items);

        // Keep "Add" buttons everywhere in sync.
        $$('[data-addwrap]').forEach((b) => { b.outerHTML = addButton(b.dataset.addwrap); });
    }

    // Inquiry list inside the contact form, with the tag / reference number option per product.
    function renderContactItems(items = listed()) {
        $('#contact-items').classList.toggle('hidden', items.length === 0);
        $('#contact-items-list').innerHTML = items.map((i, n) => {
            const p = byId.get(i.id);
            return `<li class="px-3 py-2.5">
                <div class="flex justify-between items-center gap-3"><span class="text-brand-ink">${esc(p.name)}</span>
                    <span class="qty qty-sm shrink-0" role="group" aria-label="${T('Quantity for {name}', { name: esc(p.name) })}">
                        <button type="button" data-cstep="-1" data-for="${esc(i.id)}" aria-label="${T('Decrease quantity')}">−</button>
                        <input type="number" min="1" max="999" value="${i.qty}" data-cqty="${esc(i.id)}" aria-label="${T('Quantity')}">
                        <button type="button" data-cstep="1" data-for="${esc(i.id)}" aria-label="${T('Increase quantity')}">+</button></span></div>
                <label class="check tag-check"><input type="checkbox" data-tag="${esc(i.id)}" ${i.tag ? 'checked' : ''}> ${T('Tag / reference number')}</label>
                <input type="text" class="field tag-input ${i.tag ? '' : 'hidden'}" data-tagno="${esc(i.id)}" value="${esc(i.tagNo || '')}" maxlength="120"
                    placeholder="${i.qty > 1 ? T('e.g. FT-101, FT-102 (optional, can follow later)') : T('e.g. FT-101 (optional, can follow later)')}" aria-label="${T('Tag / reference number for {name}', { name: esc(p.name) })}">
                ${p.datasheet ? datasheetBlock(i, n) : ''}
            </li>`;
        }).join('');
        // Line-size suggestions, shared by all datasheets.
        $('#ds-line-sizes').innerHTML = (dsFields().find((f) => f.suggestions)?.suggestions || []).map((s) => `<option value="${esc(s)}"></option>`).join('');
        syncTagAll(items);
    }

    function syncTagAll(items = listed()) {
        const all = $('#tag-all');
        const n = items.filter((i) => i.tag).length;
        all.checked = items.length > 0 && n === items.length;
        all.indeterminate = n > 0 && n < items.length;
    }

    // ---------- Product finder (Emerson + Endress+Hauser portfolios) ----------
    // ignore = 'options': check the category only (used to count the technology / product-line options).
    function matches(p, ignore = '') {
        if (state.category && p.category !== state.category) return false;
        if (ignore === 'options') return true;
        if (state.tech && p.tech !== state.tech) return false;
        if (state.family && p.family !== state.family) return false;
        if (state.text) {
            const hay = [p.name, p.type, p.typeEn, p.brand, p.family, p.order, p.description, ehCategory(p.category).name, p.tech && techById.get(p.tech)?.name].join(' ').toLowerCase();
            if (!state.text.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
        }
        return true;
    }

    // Emerson first, then photos, then current models; older E+H generations (e.g. "Promag 53H") last.
    const legacy = (p) => p.brand === 'Endress+Hauser' && /(^|\s)[A-Za-z][A-Za-z-]+ \d+[A-Z]*$/.test(p.name);
    // Main product lines (Promass, Micropilot, Memosens …) before one-off items.
    const familySize = {};
    const lineSize = (p) => (p.family ? familySize[p.family] : 0);
    // Featured family pages take turns by category (flow, level, pressure, … flow, level, …), so the first page is varied.
    const featuredRank = new Map();
    function rankFeatured() {
        const byCat = {};
        catalog.eh.filter((p) => p.featured).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
            .forEach((p) => (byCat[p.category] ||= []).push(p));
        catalog.ehCategories.forEach((c, ci) => (byCat[c.id] || []).forEach((p, i) => featuredRank.set(p.id, i * 100 + ci)));
    }
    const finderOrder = (a, b) => ((a.brand !== LEAD_BRAND) - (b.brand !== LEAD_BRAND))
        || (Boolean(b.featured) - Boolean(a.featured)) || ((featuredRank.get(a.id) ?? 0) - (featuredRank.get(b.id) ?? 0)) || (Boolean(b.image) - Boolean(a.image)) || (legacy(a) - legacy(b))
        || (lineSize(b) - lineSize(a)) || a.name.localeCompare(b.name, 'en', { numeric: true });

    let animateGrid = false; // 'filter' | 'more' while re-rendering after a user action
    function renderProducts() {
        const list = catalog.eh.filter((p) => matches(p)).sort(finderOrder);
        const more = $('#product-more');
        more.classList.toggle('hidden', list.length <= shown);
        more.textContent = T('Show more ({n} remaining)', { n: fmt(Math.max(0, list.length - shown)) });
        const prev = $('#product-grid').children.length;
        $('#product-grid').innerHTML = list.slice(0, shown).map((p, i) => `<article class="card${animateGrid ? ' anim-in' : ''}" style="--i:${animateGrid ? Math.max(0, Math.min(i - (animateGrid === 'more' ? prev : 0), 11)) : 0}">
                <button type="button" data-details="${esc(p.id)}" class="block" aria-label="${T('Details {name}', { name: esc(p.name) })}"><img src="${esc(imageOf(p))}" alt="${esc(p.name)}" loading="lazy" class="${imgFit(p)}"></button>
                <div class="p-5 flex flex-col flex-1">
                    <p class="text-xs font-semibold uppercase tracking-wider text-brand-orange-dark mb-1">${esc(ehCategory(p.category).name)}</p>
                    <h3 class="mb-1">${esc(p.name)}</h3>
                    <p class="text-sm mb-3">${esc(p.type)}</p>
                    <div class="flex flex-wrap gap-1 mb-4"><span class="tag ${p.brand === LEAD_BRAND ? 'tag-lead' : ''}">${esc(p.brand)}</span>${p.family && p.brand === LEAD_BRAND && p.family !== p.brand ? `<span class="tag">${esc(p.family)}</span>` : ''}${p.order ? `<span class="tag">${T('Order code {code}', { code: esc(p.order) })}</span>` : ''}</div>
                    <div class="mt-auto flex gap-2 flex-wrap">
                        <button type="button" class="btn-small" data-details="${esc(p.id)}">${T('Details')}</button>
                        ${addButton(p.id)}
                    </div>
                </div></article>`).join('');
        $('#product-empty').classList.toggle('hidden', list.length > 0);
        $('#product-summary').textContent = T('{n} of {total} products', { n: fmt(list.length), total: fmt(catalog.eh.length) });
        $$('#filter-category .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.category === state.category)));
    }

    // Category, technology and product-line options; technology and product line are counted within the chosen category.
    function renderFilterOptions() {
        const n = (cat) => catalog.eh.filter((p) => p.category === cat).length;
        $('#filter-category').innerHTML = [{ id: '', name: T('All products') }, ...catalog.ehCategories].filter((c) => !c.id || n(c.id))
            .map((c) => `<button type="button" class="chip" data-category="${esc(c.id)}" aria-pressed="false">${esc(c.name)} <span>${c.id ? n(c.id) : catalog.eh.length}</span></button>`).join('');
        const scoped = catalog.eh.filter((p) => matches(p, 'options'));
        // Drop selections that do not exist in this category.
        if (state.tech && !scoped.some((p) => p.tech === state.tech)) state.tech = '';
        const families = {};
        scoped.forEach((p) => { if (p.family) families[p.family] = (families[p.family] || 0) + 1; });
        if (state.family && !families[state.family]) state.family = '';
        $('#filter-tech').innerHTML = `<option value="">${T('All technologies')}</option>` + catalog.products.map((t) => [t, scoped.filter((p) => p.tech === t.id).length])
            .filter(([, k]) => k).map(([t, k]) => `<option value="${esc(t.id)}">${esc(t.name)} (${k})</option>`).join('');
        $('#filter-family').innerHTML = `<option value="">${T('All product lines')}</option>` + Object.keys(families).sort((a, b) => a.localeCompare(b))
            .map((f) => `<option value="${esc(f)}">${esc(f)} (${families[f]})</option>`).join('');
    }

    function setFilter(patch, scroll) {
        Object.assign(state, patch);
        renderFilterOptions();
        shown = PAGE;
        animateGrid = 'filter';
        $('#filter-text').value = state.text;
        $('#filter-tech').value = state.tech;
        $('#filter-family').value = state.family;
        renderProducts();
        animateGrid = false;
        if (scroll) $('#products').scrollIntoView({ behavior: 'smooth' });
    }
    const resetFilters = () => setFilter({ ...EMPTY });

    const closeIcon = () => `<button type="button" class="absolute top-3 right-3 bg-white/90 p-2 hover:text-brand-orange" data-close aria-label="${T('Close')}">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;

    // Written product information for the details window, built from product-info.json and the technology data.
    function productInfo(p) {
        const info = catalog.info;
        const t = p.tech && techById.get(p.tech);
        const lineName = p.family || '';
        const model = modelOf(p);
        const typeText = info.types.find((x) => new RegExp(x.match, 'i').test(`${p.typeEn || p.type} ${p.name}`.toLowerCase()))?.text;
        // Mid-sentence: lower-case the first letter only. Kept as is: acronyms (BPCS, pH …) and names that
        // are part of the product name (e.g. "Fluxus F401 …" of "Flexim Fluxus F401 …").
        const lower = (s) => {
            const first = s.split(/[\s,(/]/)[0];
            if (/^\p{Lu}{2}|^\p{L}\p{Lu}/u.test(s) || (first.length > 1 && p.name.includes(first))) return s;
            return s.charAt(0).toLowerCase() + s.slice(1);
        };
        const vars = { name: p.name, a: /^[aeiou]/i.test(p.typeEn || p.type) ? 'an' : 'a', type: lower(p.type), brand: p.brand, line: lineName, category: lower(ehCategory(p.category).name) };
        const overview = lineName && lineName !== p.brand
            ? T('The {name} is {a} {type} from {brand} ({line} product line), in the {category} range that VIS supplies and services in Azerbaijan.', vars)
            : T('The {name} is {a} {type} from {brand}, in the {category} range that VIS supplies and services in Azerbaijan.', vars);
        const paragraphs = [overview, p.description, typeText || (!t && info.categories[p.category]), info.lines[lineName]].filter(Boolean);
        const specs = [
            [T('Manufacturer'), p.brand], [T('Product line'), lineName !== p.brand ? lineName : ''], [T('Model'), model], [T('Order code'), p.order],
            [T('Category'), ehCategory(p.category).name], [T('Technology'), t?.name],
            [T('Media'), t?.media.map(mediumLabel).join(', ')],
            [T('Max. process temperature'), t?.tempMax != null ? T('up to {max} °C (typical)', { max: t.tempMax }) : ''],
            [T('Max. process pressure'), t?.pressureMax != null ? T('up to {max} bar (typical)', { max: t.pressureMax }) : ''],
            [T('Typical accuracy'), t ? accuracyText(t) : ''], [T('Hazardous area (Ex)'), t?.ex ? T('Versions available') : ''],
            [T('Hygienic design'), t?.hygienic ? T('Versions available') : ''],
        ].filter(([, v]) => v);
        const industries = catalog.industries.filter((i) => t?.industries?.includes(i.id)).map((i) => i.name);
        return { t, paragraphs, specs, industries };
    }

    function openPortfolio(p) {
        const { t, paragraphs, specs, industries } = productInfo(p);
        const variable = { flow: 'flow', level: 'level', pressure: 'pressure', temperature: 'temperature', 'liquid-analysis': 'analysis', 'gas-analysis': 'analysis' }[p.category];
        $('#product-dialog-body').innerHTML = `
            <div class="relative border-b border-brand-line"><img src="${esc(imageOf(p))}" alt="${esc(p.name)}" class="dialog-media">${closeIcon()}</div>
            <div class="p-6 overflow-y-auto">
                <p class="eyebrow">${esc(p.brand)} · ${esc(ehCategory(p.category).name)}</p>
                <h2 id="pd-title" class="text-2xl font-bold text-brand-ink mb-1">${esc(p.name)}</h2>
                <p class="mb-5">${esc(p.type)}</p>
                <h3 class="info-title">${T('Overview')}</h3>
                <div class="space-y-3 mb-5">${paragraphs.map((x) => `<p>${esc(x)}</p>`).join('')}</div>
                ${t ? `<h3 class="info-title">${T('How it works')}</h3>
                <p class="mb-3">${esc(t.principle)}</p>
                <ul class="space-y-1 mb-5">${t.highlights.map((h) => `<li class="flex gap-2"><span class="text-brand-orange">■</span>${esc(h)}</li>`).join('')}</ul>` : ''}
                <h3 class="info-title">${T('Key data')}</h3>
                <table class="size-table mb-2"><tbody>${specs.map(([k, v]) => `<tr><th class="!normal-case !tracking-normal !text-sm w-1/2">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
                ${t ? `<p class="text-xs mb-5">${T('Technology values are typical for this product type; the exact limits depend on the version and are confirmed in our quotation.')}</p>` : '<div class="mb-5"></div>'}
                ${industries.length ? `<h3 class="info-title">${T('Typical industries')}</h3><div class="flex flex-wrap gap-1 mb-5">${industries.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</div>` : ''}
                ${datasheetInfo(p)}
                <h3 class="info-title">${T('Supplied by VIS')}</h3>
                <ul class="space-y-1 mb-6">${catalog.info.service.map((x) => `<li class="flex gap-2"><span class="text-brand-orange">✓</span>${esc(x)}</li>`).join('')}</ul>
                <div class="flex gap-3 flex-wrap">${addButton(p.id)}
                    ${variable ? `<button type="button" class="btn-small" data-applicator="${variable}">${T('Check in Applicator')}</button>` : ''}</div>
            </div>`;
        $('#product-dialog').showModal();
    }

    // Matching portfolio products for a technology, one line per brand (Emerson first).
    function ehLinks(techId, limit = 6) {
        return PORTFOLIO_BRANDS.map((brand) => {
            // Lead with the main product line of this technology (e.g. Promass before Cubemass).
            const size = {};
            ehFor(techId, brand).forEach((p) => { size[p.family] = (size[p.family] || 0) + 1; });
            const list = ehFor(techId, brand).sort((a, b) => ((size[b.family] || 0) * !!b.family - (size[a.family] || 0) * !!a.family) || finderOrder(a, b));
            if (!list.length) return '';
            return `<p class="text-xs mt-3"><strong class="text-brand-ink">${esc(brand)}:</strong>
                ${list.slice(0, limit).map((e) => `<button type="button" class="underline decoration-brand-line hover:text-brand-orange-dark mr-2" data-details="${esc(e.id)}">${esc(e.name)}</button>`).join('')}
                ${list.length > limit ? `<button type="button" class="font-semibold text-brand-orange-dark hover:underline" data-tech="${esc(techId)}">${T('All {n} →', { n: list.length })}</button>` : ''}</p>`;
        }).join('');
    }

    function openBrand(brand) {
        const list = catalog.products.filter((p) => p.brands.includes(brand));
        $('#product-dialog-body').innerHTML = `<div class="relative p-6 pr-14 border-b border-brand-line">${closeIcon()}
            <p class="eyebrow">${T('Brand')}</p><h2 id="pd-title" class="text-2xl font-bold text-brand-ink mb-2">${esc(brand)}</h2>
            <p>${T('Product families we supply from {brand}. Send us the order code or your requirements for a quotation.', { brand: esc(brand) })}</p></div>
            <div class="p-6"><div class="grid sm:grid-cols-2 gap-3">${list.map((p) => `<button type="button" class="text-left border border-brand-line hover:border-brand-orange flex gap-3 items-center p-2" data-details="${esc(p.id)}">
                <img src="${esc(imageOf(p))}" alt="" class="w-20 h-12 object-cover border border-brand-line"><span class="text-sm font-semibold text-brand-ink">${esc(p.name)}</span></button>`).join('')}</div></div>`;
        $('#product-dialog').showModal();
    }

    function openProduct(id) {
        const p = byId.get(id);
        if (isPortfolio(p)) return openPortfolio(p);
        const c = category(p.category);
        const industries = catalog.industries.filter((i) => p.industries?.includes(i.id)).map((i) => i.name);
        const specs = [
            [T('Media'), p.media.map(mediumLabel).join(', ')],
            [T('Max. process temperature'), p.tempMax != null ? `${p.tempMax} °C` : null],
            [T('Max. process pressure'), p.pressureMax != null ? `${p.pressureMax} bar` : null],
            [T('Typical accuracy'), accuracyText(p)],
            [T('Hazardous area (Ex)'), p.ex ? T('Available') : null],
            [T('Hygienic design'), p.hygienic ? T('Available') : null],
        ].filter(([, v]) => v);
        $('#product-dialog-body').innerHTML = `
            <div class="relative border-b border-brand-line"><img src="${esc(imageOf(p))}" alt="${esc(p.name)}" class="dialog-media">${closeIcon()}</div>
            <div class="p-6 overflow-y-auto">
                <p class="eyebrow">${esc(c.name)}</p>
                <h2 id="pd-title" class="text-2xl font-bold text-brand-ink mb-3">${esc(p.name)}</h2>
                <p class="mb-5"><strong class="text-brand-ink">${T('Measuring principle:')}</strong> ${esc(p.principle)}</p>
                <ul class="space-y-1 mb-5">${p.highlights.map((h) => `<li class="flex gap-2"><span class="text-brand-orange">■</span>${esc(h)}</li>`).join('')}</ul>
                ${specs.length ? `<table class="size-table mb-5"><tbody>${specs.map(([k, v]) => `<tr><th class="!normal-case !tracking-normal !text-sm w-1/2">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
                <p class="text-sm mb-2"><strong class="text-brand-ink">${T('Brands:')}</strong> ${p.brands.map((b) => `<span class="tag mr-1 mb-1">${esc(b)}</span>`).join('')}</p>
                ${industries.length ? `<p class="text-sm mb-2"><strong class="text-brand-ink">${T('Industries:')}</strong> ${esc(industries.join(', '))}</p>` : ''}
                <div class="mb-6">${ehLinks(p.id, 8)}</div>
                ${datasheetInfo(p)}
                <div class="flex gap-3 flex-wrap">${addButton(p.id)}
                ${['flow', 'level', 'pressure', 'temperature', 'analysis'].includes(p.category) ? `<button type="button" class="btn-small" data-applicator="${esc(p.category)}">${T('Check in Applicator')}</button>` : ''}</div>
            </div>`;
        $('#product-dialog').showModal();
    }

    // ---------- Applicator ----------
    function renderSelection(r) {
        const ok = r.suitable.map((p, idx) => `
            <div class="result ${idx === 0 ? 'border-brand-orange border-l-4' : ''}">
                <div class="flex flex-wrap justify-between gap-3 mb-2">
                    <div class="flex gap-4 items-start"><img src="${esc(imageOf(byId.get(p.id)))}" alt="" class="hidden sm:block w-28 h-16 object-cover border border-brand-line shrink-0">
                    <div><h3 class="font-bold text-brand-ink">${esc(p.name)} ${idx === 0 ? `<span class="tag tag-orange ml-1">${T('Best match')}</span>` : ''}</h3>
                    <p class="text-sm">${esc(p.principle)}</p></div></div>
                    <div class="text-right shrink-0"><p class="text-2xl font-bold text-brand-ink">${p.score}<span class="text-sm font-normal">/100</span></p></div>
                </div>
                <div class="score-bar mb-3"><span style="width:${p.score}%"></span></div>
                ${p.notes.length ? `<ul class="text-sm mb-3 space-y-1">${p.notes.map((n) => `<li>ⓘ ${esc(n)}</li>`).join('')}</ul>` : ''}
                ${sizingBlock(p.sizing)}
                <div class="mb-3">${ehLinks(p.id, 4)}</div>
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <p class="text-xs"><strong class="text-brand-ink">${T('Brands:')}</strong> ${esc(p.brands.join(', '))}</p>
                    <div class="flex gap-2">${addButton(p.id)}<button type="button" class="btn-small" data-details="${esc(p.id)}">${T('Details')}</button></div>
                </div>
            </div>`).join('');
        const no = r.unsuitable.length ? `
            <details class="mt-6"><summary class="cursor-pointer text-sm font-semibold text-brand-ink">${T('Not suitable ({n})', { n: r.unsuitable.length })}</summary>
            <ul class="mt-3 space-y-2 text-sm">${r.unsuitable.map((p) => `<li class="bg-white border border-brand-line p-3"><strong class="text-brand-ink">${esc(p.name)}</strong> — ${esc(p.reasons.join(' '))}</li>`).join('')}</ul></details>` : '';
        stagger($('#select-result'), '.result', () => { $('#select-result').innerHTML = (r.suitable.length
            ? `<p class="text-sm mb-4">${r.suitable.length === 1
                ? T('{n} suitable technology for your conditions:', { n: '<strong class="text-brand-ink">1</strong>' })
                : T('{n} suitable technologies for your conditions:', { n: `<strong class="text-brand-ink">${r.suitable.length}</strong>` })}</p>${ok}`
            : `<div class="result border-l-4 border-red-500"><p class="font-semibold text-brand-ink">${T('No standard technology fits these conditions.')}</p><p class="text-sm mt-1">${T('Send us your requirements, our engineers can propose a special solution.')}</p><a href="#contact" class="btn-small inline-block mt-3">${T('Contact an engineer')}</a></div>`) + no; });
    }

    // Sizing of one recommended technology: key result on top, the details (table, notes) folded away.
    function sizingBlock(r) {
        if (!r) return '';
        const label = { optimal: T('Optimal'), ok: T('Possible'), out: T('Out of range') };
        let headline; let sub = ''; let body;
        if (r.variable === 'flow') {
            headline = r.recommended ? T('Recommended size: DN {dn}', { dn: r.recommended }) : T('No standard pipe size fits this flow rate');
            sub = r.recommended ? T('{flow} m³/h · optimal velocity {min}–{max} m/s', { flow: r.flow, min: r.window.optMin, max: r.window.optMax }) : '';
            body = `<table class="size-table"><thead><tr><th>${T('Nominal diameter')}</th><th>${T('Velocity')}</th><th>${T('Assessment')}</th></tr></thead>
                <tbody>${r.rows.filter((row) => row.status !== 'out' || row.dn === r.pipe?.dn || Math.abs(row.dn - (r.recommended || 0)) < 100).map((row) => `
                <tr class="${row.dn === r.recommended ? 'recommended' : ''}"><td>DN ${row.dn}${row.dn === r.pipe?.dn ? ` <span class="tag ml-1">${T('your pipe')}</span>` : ''}</td><td>${row.velocity} m/s</td>
                <td><span class="dot dot-${row.status}"></span>${label[row.status]}</td></tr>`).join('')}</tbody></table>`;
        } else {
            headline = r.fail ? T('Not possible: {reason}', { reason: r.fail }) : r.headline;
            body = `<table class="size-table"><tbody>${r.summary.map(([k, v]) => `<tr><th class="!normal-case !tracking-normal !text-sm w-2/5">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
        }
        const pipeNote = r.variable === 'flow' && r.pipe ? `<p class="text-sm mt-1">${esc(r.notes[0])}</p>` : '';
        return `<div class="sizing ${r.fail || (r.variable === 'flow' && !r.recommended) ? 'sizing-fail' : ''}">
            <p class="text-xs font-semibold uppercase tracking-wider text-brand-orange-dark">${T('Sizing')}</p>
            <p class="font-bold text-brand-ink">${esc(headline)}</p>${sub ? `<p class="text-sm">${esc(sub)}</p>` : ''}${pipeNote}
            <details class="mt-2"><summary class="cursor-pointer text-sm font-semibold text-brand-ink">${T('Sizing details')}</summary>
                <div class="overflow-x-auto mt-2">${body}</div>
                ${r.notes.length ? `<ul class="text-sm mt-3 space-y-1">${r.notes.map((n) => `<li>ⓘ ${esc(n)}</li>`).join('')}</ul>` : ''}
                <p class="text-xs mt-2">${T('Guidance only; final sizing is confirmed by our engineers.')}</p></details></div>`;
    }

    async function submitTo(form, url, render, target) {
        const button = $('button', form);
        const data = Object.fromEntries(new FormData(form).entries());
        $$('input[type="checkbox"]', form).forEach((c) => { data[c.name] = c.checked; });
        data.lang = LANG; // results and messages in the visitor's language
        button.disabled = true;
        try { render(await postJson(url, data)); }
        catch (err) {
            $(target).innerHTML = `<div class="result border-l-4 border-red-500 text-sm">${esc(err.message === 'Failed to fetch' ? T('Could not reach the server.') : err.message)}</div>`;
        } finally { button.disabled = false; }
    }

    // ---------- Industries, brands, FAQ, menus ----------
    function renderIndustry(id) {
        const ind = catalog.industries.find((i) => i.id === id);
        $$('.industry-tab').forEach((b) => { const on = b.dataset.industry === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
        $('#industry-panel').setAttribute('aria-labelledby', `ind-${id}`);
        replay($('#industry-panel'), 'anim-fade');
        $('#industry-panel').innerHTML = `
            <h3 class="text-2xl font-bold text-brand-ink mb-3">${esc(ind.name)}</h3>
            <p class="mb-6 max-w-3xl">${esc(ind.text)}</p>
            <p class="filter-label mb-3">${T('Recommended products')}</p>
            <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">${ind.products.filter((pid) => byId.has(pid)).map((pid) => {
                const p = byId.get(pid);
                return `<button type="button" class="text-left border border-brand-line hover:border-brand-orange transition-colors" data-details="${esc(pid)}">
                    <img src="${esc(imageOf(p))}" alt="" loading="lazy" class="w-full h-24 object-cover border-b border-brand-line"><span class="block p-4">
                    <span class="block text-xs font-semibold uppercase tracking-wider text-brand-orange-dark">${esc(category(p.category).name)}</span>
                    <span class="block font-semibold text-brand-ink text-sm mt-1">${esc(p.name)}</span></span></button>`;
            }).join('')}</div>`;
    }

    function buildStatic() {
        const count = (cat, brand) => catalog.eh.filter((p) => p.category === cat && p.brand === brand).length;
        $('#mega-menu').innerHTML = catalog.ehCategories.map((c) => `
            <a href="#products" class="mega-item" data-category="${esc(c.id)}"><img src="${esc(c.image)}" alt="">
            <span><strong>${esc(c.name)}</strong><small>${PORTFOLIO_BRANDS.filter((b) => count(c.id, b)).map((b) => `${count(c.id, b)} ${b === 'Endress+Hauser' ? 'E+H' : b}`).join(' · ')}</small></span></a>`).join('');
        renderFilterOptions();
        $('#footer-products').innerHTML = catalog.ehCategories.map((c) =>
            `<li><a href="#products" class="hover:text-white" data-category="${esc(c.id)}">${esc(c.name)}</a></li>`).join('');

        $('#brand-list').innerHTML = catalog.brands.map((b) => {
            const full = PORTFOLIO_BRANDS.includes(b);
            const n = full ? catalog.eh.filter((p) => p.brand === b).length : catalog.products.filter((p) => p.brands.includes(b)).length;
            const label = b === LEAD_BRAND ? T('Lead partner · {n} products', { n: fmt(n) }) : full ? T('Specialist range · {n} products', { n: fmt(n) })
                : n === 1 ? T('1 product family') : T('{n} product families', { n });
            return `<button type="button" class="brand-btn ${b === LEAD_BRAND ? 'brand-lead' : full ? '!border-brand-orange' : ''}" data-brand="${esc(b)}">${esc(b)}<small>${label}</small></button>`;
        }).join('');

        $('#industry-list').innerHTML = catalog.industries.map((i) =>
            `<button type="button" role="tab" id="ind-${esc(i.id)}" class="industry-tab" data-industry="${esc(i.id)}" aria-controls="industry-panel">${esc(i.name)}</button>`).join('');
        renderIndustry(catalog.industries[0].id);

        $('#faq-list').innerHTML = catalog.faq.map((f) => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('');
        renderIcss();
    }

    // ICSS specification: each requirement with the products that meet it (catalog.json → icss).
    function renderIcss() {
        const { intro, requirements } = catalog.icss;
        $('#icss-intro').textContent = intro;
        $('#icss-list').innerHTML = requirements.map((r) => `<article class="icss-card">
            <p class="icss-ref">${T('Spec {ref}', { ref: esc(r.ref) })}</p>
            <h3>${esc(r.title)}</h3>
            <p class="text-sm mb-4">${esc(r.text)}</p>
            <ul class="mt-auto space-y-1.5">${r.products.filter((id) => byId.has(id)).map((id) => `<li>
                <button type="button" class="icss-product" data-details="${esc(id)}">${esc(byId.get(id).name)}<span aria-hidden="true">→</span></button></li>`).join('')}</ul>
            ${r.services ? `<a href="#services" class="icss-product mt-auto">${T('VIS service & support')}<span aria-hidden="true">→</span></a>` : ''}
            ${r.datasheet ? `<p class="icss-note">${T('Shutdown valves themselves are quoted with a valve datasheet: add the valve to your inquiry list.')}</p>` : ''}
        </article>`).join('');
    }

    // "Quote against your ICSS specification": start the contact form with a short template.
    function startIcssInquiry() {
        const msg = $('#f-message');
        if (!msg.value.trim()) {
            msg.value = T('We would like a quotation against our ICSS specification (the document follows by email).\n\nProject / site:\nScope (BPCS, SIS, F&G, asset management, …):\nApprox. number of I/O:\nRequired SIL:\nSchedule:');
        }
        $('#contact').scrollIntoView({ behavior: 'smooth' });
        setTimeout(() => msg.focus({ preventScroll: true }), 400);
    }

    // ---------- Events ----------
    function bindEvents() {
        // Global click delegation for dynamic buttons.
        document.addEventListener('click', (e) => {
            const step = e.target.closest('[data-addstep]');
            if (step) {
                const input = $('[data-addqty]', step.parentElement);
                input.value = Math.min(999, Math.max(1, (parseInt(input.value, 10) || 1) + Number(step.dataset.addstep)));
                return;
            }
            if (e.target.closest('[data-inquiry-open]')) { $('#product-dialog').close(); $('#inquiry-dialog').showModal(); return; }
            if (e.target.closest('[data-icss-quote]')) { e.preventDefault(); startIcssInquiry(); return; }
            const t = e.target.closest('[data-add],[data-remove],[data-details],[data-category],[data-brand],[data-tech],[data-industry],[data-close],[data-reset],[data-applicator],#inquiry-clear');
            if (!t) return;
            if (t.dataset.add) inquiry.add(t.dataset.add, parseInt($('[data-addqty]', t.parentElement)?.value, 10));
            else if (t.dataset.remove) {
                const row = t.closest('.inq-item');
                if (row && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    row.classList.add('leaving');
                    row.addEventListener('animationend', () => inquiry.remove(t.dataset.remove), { once: true });
                } else inquiry.remove(t.dataset.remove);
            }
            else if (t.dataset.details) openProduct(t.dataset.details);
            else if (t.dataset.category !== undefined) { e.preventDefault(); setFilter(t.closest('#filter-category') ? { category: t.dataset.category } : { ...EMPTY, category: t.dataset.category }, !t.closest('#filter-category')); }
            else if (t.dataset.brand) { if (PORTFOLIO_BRANDS.includes(t.dataset.brand)) setFilter({ ...EMPTY, text: t.dataset.brand }, true); else openBrand(t.dataset.brand); }
            else if (t.dataset.tech) { $('#product-dialog').close(); setFilter({ ...EMPTY, tech: t.dataset.tech }, true); }
            else if (t.dataset.industry) renderIndustry(t.dataset.industry);
            else if (t.dataset.reset !== undefined) resetFilters();
            else if (t.dataset.applicator) {
                $('#product-dialog').close();
                $('#s-variable').value = t.dataset.applicator;
                updateConductivity();
                updateSizingForm();
                $('#select-form').requestSubmit();
                $('#applicator').scrollIntoView({ behavior: 'smooth' });
            } else if (t.id === 'inquiry-clear') {
                if (t.classList.contains('confirm')) { inquiry.clear(); return; }
                t.classList.add('confirm');
                t.querySelector('span').textContent = T('Click again to clear');
                clearTimeout(t.timer);
                t.timer = setTimeout(() => { t.classList.remove('confirm'); t.querySelector('span').textContent = T('Clear list'); }, 3000);
            }
            if (t.dataset.close !== undefined) t.closest('dialog').close();
        });

        // Industry tabs: arrow-key navigation.
        $('#industry-list').addEventListener('keydown', (e) => {
            if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
            e.preventDefault();
            const tabs = $$('.industry-tab');
            const i = tabs.indexOf(document.activeElement);
            const next = tabs[(i + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : tabs.length - 1)) % tabs.length];
            next.focus(); renderIndustry(next.dataset.industry);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('[data-addqty]')) { e.preventDefault(); $('[data-add]', e.target.closest('.add-group')).click(); }
        });
        $('#inquiry-body').addEventListener('change', (e) => { if (e.target.dataset.qty) inquiry.setQty(e.target.dataset.qty, parseInt(e.target.value, 10)); });
        $('#inquiry-body').addEventListener('click', (e) => {
            const b = e.target.closest('[data-step]');
            if (!b) return;
            const item = inquiry.items.find((x) => x.id === b.dataset.for);
            if (item) { inquiry.setQty(item.id, item.qty + Number(b.dataset.step)); $(`[data-for="${CSS.escape(item.id)}"][data-step="${b.dataset.step}"]`)?.focus(); }
        });
        $('#inquiry-open').addEventListener('click', () => $('#inquiry-dialog').showModal());
        $('#inquiry-submit').addEventListener('click', () => $('#inquiry-dialog').close());
        // Close dialogs on backdrop click; lock page scrolling while one is open.
        const syncLock = () => document.documentElement.classList.toggle('modal-open', $$('dialog').some((d) => d.open));
        $$('dialog').forEach((d) => {
            d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
            d.addEventListener('close', syncLock);
            const show = d.showModal.bind(d);
            d.showModal = () => { if (!d.open) show(); syncLock(); const sc = $('#product-dialog-body > :last-child', d); if (sc) sc.scrollTop = 0; };
        });

        // Filters
        $('#filter-text').addEventListener('input', (e) => setFilter({ text: e.target.value.trim() }));
        $('#filter-tech').addEventListener('change', (e) => setFilter({ tech: e.target.value }));
        $('#filter-family').addEventListener('change', (e) => setFilter({ family: e.target.value }));
        $('#filter-reset').addEventListener('click', resetFilters);
        $('#product-more').addEventListener('click', () => { shown += PAGE * 2; animateGrid = 'more'; renderProducts(); animateGrid = false; });
        ['#search-form', '#search-form-mobile'].forEach((sel) => $(sel).addEventListener('submit', (e) => {
            e.preventDefault();
            setFilter({ ...EMPTY, text: $('input', e.target).value.trim() }, true);
            closeMobileMenu();
        }));

        // Applicator
        $('#select-form').addEventListener('submit', (e) => { e.preventDefault(); submitTo(e.target, '/api/applicator/select', renderSelection, '#select-result'); });
        $('#s-medium').addEventListener('change', updateConductivity);
        $('#s-variable').addEventListener('change', () => { updateConductivity(); updateSizingForm(); });

        // Mobile menu
        const toggle = $('#menu-toggle');
        const menu = $('#mobile-menu');
        toggle.addEventListener('click', () => {
            const open = menu.classList.toggle('open');
            menu.setAttribute('aria-hidden', String(!open));
            toggle.setAttribute('aria-expanded', String(open));
        });
        $$('a', menu).forEach((a) => a.addEventListener('click', closeMobileMenu));
        function closeMobileMenu() { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); toggle.setAttribute('aria-expanded', 'false'); }
    }

    // Applicator: show only the sizing fields of the chosen variable (hidden fields are disabled, so they are not sent).
    function updateSizingForm() {
        const variable = $('#s-variable').value;
        $$('[data-for-var]').forEach((g) => {
            const on = g.dataset.forVar === variable;
            g.classList.toggle('hidden', !on);
            $$('input, select', g).forEach((el) => { el.disabled = !on; });
        });
    }

    function updateConductivity() {
        const show = $('#s-variable').value === 'flow' && ['liquid', 'slurry'].includes($('#s-medium').value);
        $('#s-conductivity-wrap').classList.toggle('hidden', !show);
        if (!show) $('#s-conductivity').value = '';
    }

    // ---------- Scroll reveal ----------
    function setupReveal() {
        if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const targets = $$('main > section > div, #products .card');
        const io = new IntersectionObserver((entries) => entries.forEach((e) => {
            if (e.isIntersecting) { e.target.classList.add('revealed'); io.unobserve(e.target); }
        }), { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
        targets.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.top < innerHeight) return; // already visible: no animation
            el.classList.add('reveal'); io.observe(el);
        });
    }

    // ---------- Contact form ----------
    function bindContact() {
        const form = $('#contact-form');
        const status = $('#form-status');
        $('#tag-all').addEventListener('change', (e) => inquiry.setTagAll(e.target.checked));
        $('#contact-items-list').addEventListener('click', (e) => {
            const b = e.target.closest('[data-cstep]');
            if (!b) return;
            const item = inquiry.items.find((x) => x.id === b.dataset.for);
            if (item) { inquiry.setQty(item.id, item.qty + Number(b.dataset.cstep)); $(`[data-for="${CSS.escape(item.id)}"][data-cstep="${b.dataset.cstep}"]`)?.focus(); }
        });
        $('#contact-items-list').addEventListener('change', (e) => {
            if (e.target.dataset.cqty) { inquiry.setQty(e.target.dataset.cqty, parseInt(e.target.value, 10)); return; }
            const id = e.target.dataset.tag;
            if (!id) return;
            inquiry.setTag(id, e.target.checked);
            const input = $(`[data-tagno="${CSS.escape(id)}"]`);
            input.classList.toggle('hidden', !e.target.checked);
            if (e.target.checked) input.focus();
            syncTagAll();
        });
        $('#contact-items-list').addEventListener('input', (e) => { if (e.target.dataset.tagno) inquiry.setTagNo(e.target.dataset.tagno, e.target.value); });
        // Valve datasheet: keep the values (no re-render, so the focus stays), update progress and hints.
        const onDatasheet = (e) => {
            const { dsItem: id, dsField: field } = e.target.dataset;
            if (!id) return;
            inquiry.setDs(id, field, e.target.value);
            const item = inquiry.items.find((x) => x.id === id);
            const sel = CSS.escape(id);
            const complete = dsFilled(item) === dsRequired().length;
            const progress = $(`[data-ds-progress="${sel}"]`);
            progress.textContent = dsStatus(item);
            progress.classList.toggle('ds-ok', complete);
            const hint = $(`[data-ds-hint="${sel}"]`);
            hint.textContent = `ⓘ ${dsHint(item)}`;
            hint.classList.toggle('hidden', !dsHint(item));
            const status = $(`[data-ds-status="${sel}"]`);
            if (status) { status.textContent = dsStatus(item); status.classList.toggle('ds-ok', complete); }
        };
        $('#contact-items-list').addEventListener('input', onDatasheet);
        $('#contact-items-list').addEventListener('change', onDatasheet);
        const show = (msg, ok) => {
            status.textContent = msg;
            status.classList.remove('hidden', 'text-red-600', 'text-green-700');
            status.classList.add(ok ? 'text-green-700' : 'text-red-600');
        };
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const button = $('button[type="submit"]', form);
            const payload = Object.fromEntries(new FormData(form).entries());
            delete payload['tag-all'];
            Object.keys(payload).filter((k) => /^ds\d+-/.test(k)).forEach((k) => delete payload[k]); // datasheet radios; sent per item below
            payload.lang = LANG;
            payload.items = listed().map(({ id, qty, tag, tagNo, ds }) => ({
                id, qty, tag: !!tag, tagNo: tag ? (tagNo || '').trim() : '',
                ...(byId.get(id).datasheet && { datasheet: ds || {} }),
            }));
            button.disabled = true;
            try {
                await postJson('/api/contact', payload);
                show(T('Thank you for your inquiry. An engineer in Azerbaijan will contact you shortly.'), true);
                form.reset();
                inquiry.clear();
            } catch (err) {
                show(err.message === 'Failed to fetch' ? T('Could not reach the server. Please try again later.') : err.message, false);
            } finally { button.disabled = false; }
        });
    }

    // ---------- Start ----------
    document.addEventListener('DOMContentLoaded', async () => {
        bindContact();
        try {
            const [res] = await Promise.all([fetch(`/api/catalog?lang=${LANG}`), window.I18N.ready]);
            if (!res.ok) throw new Error();
            catalog = await res.json();
        } catch {
            $('#catalog-error').classList.remove('hidden');
            return;
        }
        $('#year').textContent = new Date().getFullYear(); // after I18N.ready: the footer sentence is translated as one unit
        catalog.products.forEach((p) => { byId.set(p.id, p); techById.set(p.id, p); });
        catalog.eh.forEach((p) => { byId.set(p.id, p); if (p.family) familySize[p.family] = (familySize[p.family] || 0) + 1; });
        rankFeatured();
        buildStatic();
        setupReveal();
        bindEvents();
        updateConductivity();
        updateSizingForm();
        renderProducts();
        renderInquiry();
    });
})();
