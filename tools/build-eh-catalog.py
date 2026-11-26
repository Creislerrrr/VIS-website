#!/usr/bin/env python3
"""Build backend/data/eh-products.json from the E+H sitemap product URLs.

Usage: python3 tools/build-eh-catalog.py tools/eh-sitemap-urls.txt backend/data/eh-products.json
Keeps "image" values already present in the output file.
"""
import json, re, sys, os
from urllib.parse import unquote

CATEGORIES = {
    "flow-measurement-product-overview": "flow",
    "level-measurement": "level",
    "pressure": "pressure",
    "temperature-measurement-thermometers-transmitters": "temperature",
    "liquid-analysis-product-overview": "liquid-analysis",
    "optical-analysis-product-overview": "gas-analysis",
    "gas-analysis": "gas-analysis",
    "moisture-measurement": "level",
    "system-components-recorder-data-manager": "system",
}
FAMILIES = ["Promass", "Promag", "Prowirl", "Prosonic Flow", "Prosonic", "Picomag", "Dosimag", "Dosimass", "Cubemass", "LNGmass",
    "t-mass", "Teqwave", "Deltatop", "Micropilot", "Levelflex", "Liquiphant", "Soliphant", "Liquicap", "Solicap", "Nivotester",
    "Deltapilot", "Waterpilot", "Cerabar", "Deltabar", "Ceraphant", "Silopilot", "Soliwave", "Gammapilot", "Liquitrend",
    "Solitrend", "Proservo", "Tankvision", "Tank Side Monitor", "Minicap", "Nivector", "Liquipoint", "Solimotion", "FlexView",
    "iTHERM", "iTEMP", "Omnigrad", "Easytemp", "Thermophant", "Memosens", "Liquiline", "Liquisys", "Mycom", "Orbisint",
    "Ceragel", "Tophit", "Orbipac", "Ceramax", "Turbimax", "Oxymax", "Indumax", "Condumax", "Viomax", "Stamolys", "Cleanfit",
    "Dipfit", "Flowfit", "Unifit", "Ecofit", "Memograph", "Ecograph", "Minilog", "Field Xpert", "FieldCare", "FieldEdge",
    "SupplyCare", "Netilion", "Topcal", "Topclean", "Solitrend", "Memobase", "Chromoclean", "Ammoniumx", "Phosphax", "Nitrax",
    "Amtax", "Rxn", "Raman Rxn", "Fieldgate", "Smartblue", "Heartbeat", "Ecograph", "Flowphant", "Levelphant", "Nivophant",
    "Flow-X", "Prothermo", "Proline"]
FAM_LOWER = sorted(((f.lower().replace(" ", "-"), f) for f in FAMILIES), key=lambda x: -len(x[0]))
CODE_RE = re.compile(r"^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z]{1,6}\d{1,5}[a-z0-9]{0,4}$|^\d{2,3}[a-z]{1,2}\d?[a-z]?$", re.I)
# Proline style "a500", "f300", "w400", "53h", "80f"
PROLINE_RE = re.compile(r"^([a-z])(\d)00$", re.I)
SMALL = {"and", "or", "for", "with", "of", "in", "the", "a", "to"}
UPPER = {"ph", "orp", "toc", "cod", "uv", "ex", "us", "rtd", "tc", "pc", "opc", "dp", "lng", "cip", "sip", "erp", "ims",
         "tdlas", "cems", "io", "hart", "fdm", "lel", "smt", "led", "gc", "sac", "wirelesshart", "atex", "iiot", "hmi"}
SKIP_WORDS = {"endress", "hauser", "measurement", "level", "product", "products", "proline", "us", "style"}
NOT_CODES = {"pt100", "pt1000", "80ghz", "mp4", "s7", "h2", "co2", "o2", "4to20"}


def word(w, first=False):
    lw = w.lower()
    if lw in ("pt100", "pt1000"): return "Pt" + lw[2:]
    if lw in UPPER: return "pH" if lw == "ph" else ("ORP" if lw == "orp" else lw.upper())
    if lw in SMALL and not first: return lw
    return lw.capitalize() if first else lw


def parse(url):
    parts = url.rstrip("/").split("/")
    cat_slug, slug = parts[5], unquote(parts[6])
    category = CATEGORIES.get(cat_slug)
    if not category: return None
    tokens = [t for t in re.split(r"[-_\s]+", slug) if t]
    low = [t.lower() for t in tokens]
    joined = "-".join(low)

    family = None; fam_pos = None; fam_len = 0
    for key, name in FAM_LOWER:
        k = key.split("-")
        for i in range(len(low) - len(k) + 1):
            if low[i:i + len(k)] == k:
                family, fam_pos, fam_len = name, i, len(k)
                break
        if family: break

    if slug.isdigit(): return None
    is_code = lambda t: bool(CODE_RE.match(t)) and t.lower() not in NOT_CODES
    codes = [t for t in tokens if is_code(t)]
    if not family and not codes and category not in ("gas-analysis", "system"):
        return None  # overview / landing page, not a product

    if family:
        rest = tokens[fam_pos + fam_len:]
        model = []
        for t in rest:
            if any(re.search(r"\d", x) for x in model) and not re.search(r"\d", t) and len(t) > 1: break
            m = PROLINE_RE.match(t)
            if m: model.append(f"{m.group(1).upper()} {m.group(2)}00")
            elif CODE_RE.match(t) or re.match(r"^\d", t): model.append(t.upper())
            elif t.lower() in ("inline", "e", "s", "h", "w", "l", "p", "d", "i", "x", "c", "t", "f", "a", "b", "r", "u", "g", "q", "k"): model.append(t.upper() if len(t) == 1 else t.capitalize())
            elif t.lower() == "us" or t.lower() == "style": continue
            else: model.append(t.upper() if CODE_RE.match(t) else t.capitalize())
        # drop trailing order codes like 8F3B / 5W4C after a Proline model
        if len(model) >= 2 and re.match(r"^\d[A-Z][A-Z0-9]{1,3}$", model[-1]):
            order = model.pop()
        else:
            order = None
        prefix = "Proline " if family in ("Promass", "Promag", "Prowirl", "Prosonic Flow", "t-mass", "Teqwave") else ""
        name = (prefix + family + " " + " ".join(model)).strip()
        type_tokens = tokens[:fam_pos]
    else:
        code_idx = next((i for i, t in enumerate(tokens) if is_code(t)), None)
        if code_idx is not None:
            code = tokens[code_idx].upper()
            type_tokens = tokens[:code_idx] + [t for t in tokens[code_idx + 1:] if not is_code(t)]
            desc = " ".join(word(t, i == 0) for i, t in enumerate(type_tokens) if t.lower() not in SKIP_WORDS)
            name = code if not desc else f"{code}"
        else:
            name = " ".join(word(t, True) for t in tokens)
            type_tokens = []
        order = None

    type_tokens = [t for t in type_tokens if t.lower() not in SKIP_WORDS and not is_code(t)]
    ptype = " ".join(word(t, i == 0) for i, t in enumerate(type_tokens)).strip()
    if "us-style" in joined or joined.endswith("-us") or "-us-" in joined: ptype = (ptype + " (US style)").strip()
    if not ptype:
        ptype = {"flow": "Flowmeter", "level": "Level instrument", "pressure": "Pressure instrument", "temperature": "Temperature instrument",
                 "liquid-analysis": "Liquid analysis", "gas-analysis": "Gas / optical analysis", "system": "System component"}[category]
    if family in ("Cerabar", "Deltabar", "Ceraphant") or ptype.lower().startswith(("absolute gauge", "differential pressure", "gauge pressure")):
        category = "pressure"
    if family == "Cerabar" and re.search(r"\bPMD", name): name = name.replace("Cerabar", "Deltabar"); family = "Deltabar"
    pid = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")
    return {"id": pid, "name": name, "type": ptype, "category": category, "family": family or "", "order": order,
            "tech": technology(category, family or "", joined), "url": url, "image": None}


def technology(category, family, slug):
    """Map a product onto one of the Applicator technology families in catalog.json."""
    has = lambda *ws: any(w in slug for w in ws)
    if category == "flow":
        if family in ("Promag", "Picomag", "Dosimag") or has("electromagnetic"): return "electromagnetic"
        if family in ("Promass", "Cubemass", "Dosimass", "LNGmass") or has("coriolis"): return "coriolis"
        if family == "Prowirl" or has("vortex"): return "vortex"
        if family in ("Prosonic Flow",) or has("ultrasonic", "flowsic"): return "ultrasonic-flow"
        if family == "Deltatop" or has("dp-flow", "differential"): return "dp-flow"
        if family == "t-mass" or has("thermal"): return "thermal-mass"
    if category == "level":
        if family == "Levelflex" or has("guided"): return "guided-radar"
        if family == "Micropilot" or has("radar"): return "radar-level"
        if family in ("Waterpilot", "Deltapilot") or has("hydrostatic"): return "hydrostatic-level"
        if family in ("Liquiphant", "Soliphant", "Nivotester", "Liquipoint", "Minicap") or has("vibronic", "point", "switch", "capacitance", "conductive"): return "point-level"
        if family == "Gammapilot" or has("radiometric", "gamma"): return "radiometric"
        if family == "Prosonic" or has("ultrasonic"): return "ultrasonic-level"
    if category == "pressure":
        return "dp-transmitter" if family == "Deltabar" or has("differential") else "pressure-transmitter"
    if category == "temperature":
        return "temp-transmitter" if family == "iTEMP" or has("transmitter", "tmt") else "temp-assembly"
    if category == "liquid-analysis" and has("ph", "orp", "conductiv", "oxygen", "memosens", "transmitter", "liquiline"): return "ph-conductivity"
    if category == "gas-analysis": return "gas-analyzer"
    return None


def dedupe(items):
    """Several E+H pages can describe the same product (order-code generations, marketing pages)."""
    items = [p for p in items if "80ghz" not in p["id"]]  # campaign landing pages
    groups = {}
    for p in items: groups.setdefault((p["name"], p["category"]), []).append(p)
    out = []
    for (name, _), ps in groups.items():
        if len(ps) == 1: out.append(ps[0]); continue
        # Same Proline device, different order-code generations -> one entry, newest page.
        if all(p["order"] for p in ps):
            ps.sort(key=lambda p: p["order"])
            keep = dict(ps[-1]); keep["order"] = " / ".join(p["order"] for p in ps); out.append(keep); continue
        # Marketing duplicate of a product page.
        real = [p for p in ps if not p["id"].startswith("endress-hauser-")]
        if len(real) == 1: out.append(real[0]); continue
        # Genuinely different items (bundles, accessories): suffix with the extra slug words.
        base = set(re.split(r"[\s-]+", name.lower()))
        for p in real:
            extra = [w for w in p["id"].split("-") if w not in base and w not in SKIP_WORDS and w not in ("tdlas", "gas", "analyzer", "compact", "transmitter")]
            if extra:
                p = dict(p); p["name"] = name + " " + " ".join(word(w, i == 0) if not CODE_RE.match(w) else w.upper() for i, w in enumerate(extra))
            out.append(p)
    return out


def main(src, dst):
    old = {}
    if os.path.exists(dst):
        old = {p["id"]: p for p in json.load(open(dst))}
    seen, out = set(), []
    for line in open(src):
        p = parse(line.strip())
        if not p or p["id"] in seen: continue
        seen.add(p["id"])
        if p["id"] in old and old[p["id"]].get("image"): p["image"] = old[p["id"]]["image"]
        out.append(p)
    out = dedupe(out)
    out.sort(key=lambda p: (p["category"], p["name"].lower()))
    json.dump(out, open(dst, "w"), indent=1, ensure_ascii=False)
    print(len(out), "products")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
