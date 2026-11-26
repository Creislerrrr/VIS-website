# VIS – Vantage Industrial Supply & Services

Website based on `VIS-WebSite.zip`, redesigned in a light theme (orange accent) after the sites of
Endress+Hauser (incl. the Applicator tool), VEGA, WIKA, Emerson, Siemens, ABB and Pepperl+Fuchs.

**Features:** product finder (Emerson + Endress+Hauser) with filters and search · mega menu · VIS Applicator (technology selection +
flowmeter sizing) · English / Russian / Azerbaijani · control & safety systems (ICSS specification → Emerson products) · valve datasheet in the inquiry · industries · brand overview · services · FAQ · inquiry list (like a cart) that is sent
with the contact form.

```
VIS-Website/
├── frontend/              static site (served by the backend)
│   ├── index.html
│   ├── css/styles.css
│   ├── js/main.js         catalog UI, filters, Applicator, inquiry list, contact form
│   ├── js/i18n.js         language switch (EN / RU / AZ) and translation of the page
│   ├── i18n/              ru.json, az.json (English text → translation), keys.json (all English texts)
│   └── images/            logo, favicon, hero photo, category + plant illustrations (SVG)
│       └── products/      one illustration per product family (<id>.svg)
├── backend/
│   ├── server.js          zero-dependency Node server
│   ├── lib/applicator.js  selection + sizing logic
│   ├── lib/i18n.js        server-side translations (catalog texts, messages)
│   └── data/              catalog.json (technologies, industries, FAQ, ICSS requirements, valve datasheet fields),
│                          emerson-products.json, icss-products.json, eh-products.json, product-info.json,
│                          inquiries.json (git-ignored)
├── tools/                 scripts: translation check, building the Emerson / E+H product lists
└── package.json
```

## Run

```bash
npm start            # http://127.0.0.1:3000
npm run dev          # auto-restart on changes
PORT=8080 HOST=0.0.0.0 npm start
```

No `npm install` is needed. You need Node 18 or newer.

## Start here (new to the project?)

The whole site is one page (`frontend/index.html`) plus a small Node server. There is no framework and no build step:
what you see in the files is exactly what runs in the browser.

**What happens when someone opens the site**

1. `backend/server.js` sends `index.html`, the CSS, the JS files and the images (it is a plain static file server).
2. In the browser, `js/i18n.js` runs first: it picks the language (EN / RU / AZ), loads `i18n/<lang>.json` and replaces
   the English texts of the page with the translations.
3. `js/main.js` then asks the server for the catalog (`GET /api/catalog?lang=ru`): all products, categories,
   industries, FAQ … already translated by `backend/lib/i18n.js`.
4. `main.js` builds the dynamic parts from that catalog (menu, product finder, brands, industries, FAQ) and listens
   for clicks (one click handler for the whole page, see `bindEvents()`).
5. The **Applicator** form is sent to `POST /api/applicator/select`; `backend/lib/applicator.js` scores every
   technology for the process conditions and sizes the suitable ones. `main.js` shows the result.
6. Products the visitor adds go into the **inquiry list** (kept in the browser's `localStorage`). The contact form sends
   the list to `POST /api/contact`; the server checks it and saves it in `backend/data/inquiries.json`.

**Where do I change …?**

| I want to change …                               | File |
|--------------------------------------------------|------|
| a text, section or layout of the page            | `frontend/index.html` (+ the translation in `frontend/i18n/ru.json`, `az.json`) |
| colours, spacing, look of buttons/cards          | `frontend/css/styles.css` (Tailwind classes in `index.html` for the rest) |
| products, categories, industries, FAQ            | `backend/data/catalog.json`, `emerson-products.json`, `eh-products.json`, `icss-products.json` |
| the texts in the product details window          | `backend/data/product-info.json` |
| how the Applicator chooses / sizes               | `backend/lib/applicator.js` |
| what happens on a click, how lists are drawn     | `frontend/js/main.js` |
| a translation                                    | `frontend/i18n/ru.json` / `az.json`, then run `node tools/i18n-check.mjs` |

Every source file starts with a comment that explains what it does, and the files are split into sections
(`// ---------- … ----------`), so reading a file from the top is the easiest way in.

## API

| Method | Path              | Description |
|--------|-------------------|-------------|
| GET    | `/api/catalog`    | Products, categories, industries, brands, FAQ |
| POST   | `/api/applicator/select` | `{variable, medium, temperature, pressure, conductivity, ex, hygienic}` + optional sizing values (`flow, pipeDn, height, nozzle, density, dp, velocity, cleaning`) → ranked technologies, each suitable one with `sizing` |
| POST   | `/api/applicator/sizing` | `{variable, …}`: flow `{technology, medium, flow, pipeDn?}` → velocity per DN + recommended DN; level `{technology, medium, height, nozzle?, density?}`; pressure `{type, maxPressure, medium, temperature?, staticPressure?}`; temperature `{pipeDn, temperature, medium, velocity?}`; analysis `{pipeDn, temperature?, pressure?, cleaning?}` → headline, values, notes |
| POST   | `/api/contact`    | JSON `{name, company, email, message, project?, items?}` (`project` = the customer's project name / reference; each item: `{id, qty, tag, tagNo, datasheet?}`; `datasheet` is required for valves and actuators, see below) → saved to `backend/data/inquiries.json` |
| GET    | `/api/inquiries`  | List inquiries; needs `ADMIN_TOKEN` env var + header `Authorization: Bearer <token>` |
| GET    | `/api/health`     | Health check |

## Notes
- Tailwind is loaded from the CDN (as in the original). For production, consider building Tailwind locally.
- Swap the SVG illustrations in `frontend/images/` for real product photos whenever you have them. Keep the same filenames, or update the paths in `index.html`.
- Products and texts live in `backend/data/catalog.json`; edit that file to change the portfolio.
- Phone number and email address in `index.html` are placeholders.
- Every product in `catalog.json` has an `image` path. To use a real photo, put it in `frontend/images/products/` and change that path.

## Emerson portfolio (lead brand)

- Emerson is the lead brand: Emerson products come first in the product finder and in every product list.
- **E+H only where Emerson has no equivalent:** the server leaves out every E+H product whose technology (Coriolis, radar,
  pH, pressure transmitter, …) Emerson also covers (see `backend/server.js`). `eh-products.json` keeps the full E+H
  portfolio, so removing that filter brings the products back.
- `backend/data/emerson-products.json` (~760 products: Rosemount, Micro Motion, Flexim, Fisher, Keystone, …) is built from
  the official Emerson product sitemap (`https://www.emerson.com/en.sitemap-index.xml`, spare-part numbers left out):
  ```bash
  python3 tools/fetch-emerson-pages.py tools/emerson-sitemap-urls.txt tools/emerson-pages.json   # names + descriptions, slow (rate limit)
  python3 tools/build-emerson-catalog.py tools/emerson-sitemap-urls.txt tools/emerson-pages.json backend/data/emerson-products.json
  ```
  The fetch step is optional: emerson.com rate-limits it heavily (HTTP 429). Without it, names are made from the URL.
- Product photos work like for E+H: set `image` in `emerson-products.json` (kept when rebuilding).

## Product details & sizing

- The product details window shows written information instead of a link to the manufacturer: overview, product-line
  and product-type texts from `backend/data/product-info.json`, the measuring principle and typical technology data
  from `catalog.json`, typical industries and the VIS services. Edit `product-info.json` to change the texts.
- The **Applicator** is one form: process conditions (step 1) rank the technologies, and the optional sizing values
  (step 2) size every suitable technology in the same result. Sizing covers flow (pipe DN, with a check of the existing pipe), level (range, antenna, probe length,
  hydrostatic sensor range), pressure (sensor range, span, turndown), temperature (insertion length, sensor type) and
  liquid analysis (assembly and installation for the pipe size). Logic: `backend/lib/applicator.js`.

## Endress+Hauser portfolio

- `backend/data/eh-products.json` holds the full E+H portfolio (~1,000 products), built from the official
  E+H sitemap: `python3 tools/build-eh-catalog.py tools/eh-sitemap-urls.txt backend/data/eh-products.json`
  (re-running keeps existing photos).
- **Product photos:** get the official images from Endress+Hauser (partner portal / sales contact), put them
  in one folder and run `python3 tools/import-images.py <folder>` (add `--dry-run` first to check the matching).
  File names must contain the product name or model code, e.g. `Promag_W400.jpg`, `FMR62B.png`.
  Photos are converted to a uniform 800x600 white-background JPEG in `frontend/images/eh/`.
  Products without a photo show the matching technology illustration.
- Confirm with Endress+Hauser that VIS may use their product photos on the website before going live.

## Valve datasheet

- Every valve and actuator in an inquiry needs a datasheet with at least: **line size, fluid name, inlet pressure, outlet
  pressure (bar g), temperature (°C), actuation type (electric / pneumatic) and sand presence (yes / no)**, plus the
  optional valve duty (control / on-off / emergency shutdown).
- The fields are defined once in `catalog.json` → `valveDatasheet`: the contact form is built from it and the server
  validates against it (required fields, number ranges, outlet pressure ≤ inlet pressure). Add a field there and it
  appears in the form, the product details and the validation.
- Which products need it: category `valves` (Emerson / E+H portfolio) and the "Valve Positioners & Control Valves"
  family, except services, spare parts, software and positioners (`NO_DATASHEET` in `backend/server.js`).
- The values are saved per product in the browser's inquiry list and stored with the inquiry under `items[].datasheet`.

## Control & safety systems (ICSS)

- Based on the generic *Integrated Control and Safety System (ICSS) Specification* (Emerson DeltaV, BPCS + SIS).
  The section "Built to your ICSS specification" lists its main requirements (with section numbers) and the products
  that meet them: `catalog.json` → `icss`.
- The products from the specification (DeltaV, DeltaV SIS, CHARMs, AMS Device Manager, AMS 6500 ATG, DeltaV Simulate,
  Mimic, FIELDVUE DVC6200 / DVC6200 SIS, …) are in `backend/data/icss-products.json`, in the product category
  "Control & safety systems". They are kept out of `emerson-products.json`, because that file is regenerated from the
  Emerson sitemap.
- "Quote against your specification" fills the contact form with a short template; the customer sends the document
  itself by email.

## Languages (English, Russian, Azerbaijani)

- Switch in the top bar (and in the mobile menu): **EN · RU · AZ**. The choice is remembered (`localStorage`), and
  `?lang=ru` / `?lang=az` links open the site in that language. Without a choice, the browser language decides
  (Russian or Azerbaijani browsers get their language, everything else English). Switching reloads the page; the
  inquiry list is kept.
- **The English text is the key.** `frontend/i18n/ru.json` and `az.json` map each English text to its translation.
  A missing translation simply shows the English text, so a new English text never breaks the page.
- Where texts come from and who translates them:
  - `index.html`: translated in the browser at start-up by `js/i18n.js` (a sentence with a link or `<strong>` is one
    entry, including its HTML tags).
  - `js/main.js`: `T('English text with {placeholders}', { … })`.
  - Catalog texts (categories, technologies, industries, FAQ, ICSS, valve datasheet, product-info texts, our own
    ICSS products, the product type line of every Emerson / E+H product): translated by the server,
    `GET /api/catalog?lang=ru` (`backend/lib/i18n.js`). Manufacturer product names (Rosemount 3051S …) stay as they are.
  - Category names can have their own translation under the key `"<name> (category)"`, e.g. `"Flow (category)"` →
    "Измерение расхода" in menus and filters, while `"Flow"` → "Расход" stays for the Applicator.
  - Terminology: Azerbaijani uses "axın" for flow ("axınölçən" = flowmeter), Russian "расход".
  - Applicator results and form errors: translated by the server from `lang` in the request body.
- Inquiries are stored with `lang`, so the reply can be in the customer's language.
- **After changing or adding English text**, run the check (needs Chromium):
  ```bash
  node tools/i18n-check.mjs           # missing / unused translations, broken {placeholders} or HTML tags
  node tools/i18n-check.mjs --write   # also writes i18n/keys.json and i18n/missing-ru.json / missing-az.json
  ```
  Translate the entries of `missing-<lang>.json` and add them to `<lang>.json`. Keep `{placeholders}` and HTML tags
  exactly; `{a}` (English "a / an") can be left out.
- Rules for new script texts: write whole sentences with placeholders (no words glued into a sentence, because
  Russian and Azerbaijani change word endings), and pass literal strings to `T()` / `t()` so the check finds them.
