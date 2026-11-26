#!/usr/bin/env python3
"""Build backend/data/emerson-products.json from the fetched Emerson product pages.

Usage:
  python3 tools/fetch-emerson-pages.py tools/emerson-sitemap-urls.txt tools/emerson-pages.json   # names + descriptions
  python3 tools/build-emerson-catalog.py tools/emerson-sitemap-urls.txt tools/emerson-pages.json backend/data/emerson-products.json
Pages not fetched (yet) get a name made from the URL slug.
Keeps "image" values already present in the output file.
"""
import json, os, re, sys

# Sub-brands (product lines) as they appear at the start of the URL slug.
LINES = ["Micro Motion", "Rosemount", "Flexim", "Spectrex", "Roxar", "Paine", "Damcos", "Leveldatic", "Fisher", "Bettis",
         "Keystone", "Vanessa", "Yarway", "Crosby", "Anderson Greenwood", "ASCO", "TESCOM", "Sempell", "Kunkle", "Clarkson",
         "Daniel", "Gulde", "Biffi", "EL-O-Matic", "Hytork", "Shafer", "TopWorx", "Enardo", "Tartarini", "Francel", "Cashco",
         "Valtek", "Varec", "AVENTICS", "Dresser", "KTM", "Pentair", "Net Safety", "Emerson"]
LINE_SLUGS = sorted(((l.lower().replace(" ", "-"), l) for l in set(LINES)), key=lambda x: -len(x[0]))

# Not physical products (software, apps, services, spare-part bundles) -> left out.
EXCLUDE = re.compile(r"\b(software|insight|app|application|applications|service|services|strategy|planning|training|"
                     r"spare parts|parts kit|kit|kits|label|o-ring|screw|cover|bracket|cable|license|subscription|"
                     r"program|course|consulting|asset management|data analytics|sample product|spare|replacement)\b", re.I)

# First match wins; checked against "name + description + slug".
RULES = [
    ("valves", r"actuator|positioner|valve|regulator|damper"),  # plus everything from the final-control division
    ("gas-analysis", r"gas analy|gas chromatograph|chromatograph|flame detect|gas detect|combustible gas|toxic gas|oxygen analy|"
                     r"combustion|flue gas|continuous gas|emissions? monitor|\bh2s\b|hydrocarbon gas|laser analy|ndir|zirconia|"
                     r"process gas|condensate analy|calorific|btu|oxygen|combustibles|oxymitter|infrared gas|gas sensor|net safety|"
                     r"microleak|leak detect|gas monitor|catalytic bead|\bh2\b|\bnox\b|carbon monoxide|hydrocarbon analy|flame ioni|"
                     r"chemiluminescence|flame simulator|safeye|quasar|\bfid\b|\bhfid\b"),
    ("liquid-analysis", r"\bph\b|\borp\b|conductivity|dissolved oxygen|chlorine|turbidity|ozone|liquid analy|refractomet|"
                        r"water quality|analyzer transmitter|sensor cable|amperometric|toroidal|monochloramine|\bfcli?\b|\bdo sensor|"
                        r"single use sensor|liquid (standard )?panel|wcld|rosemount (1056|1057|1058|1066|56|5081)\b"),
    ("flow", r"coriolis|flow ?meter|flowmeter|magnetic flow|mag meter|vortex|annubar|orifice|flow transmitter|"
             r"density meter|densit|viscosit|specific gravity|ultrasonic flow|clamp-on|flow measurement|flow computer|"
             r"heat and cold metering|compressed air|steam measurement|net oil|wet gas|multiphase|concentration meter|"
             r"fluxus|\bflow\b|watercut|wetgas|viscomaster|micro motion"),
    ("level", r"level|radar|tank gaug|guided wave|tank|interface|vibrating fork|point level|switch|leveldatic"),
    ("pressure", r"pressure|manifold|diaphragm seal|remote seal|differential|dp |transducer|gauge"),
    ("temperature", r"temperature|thermowell|\brtd\b|thermocouple|thermometer|heat flux"),
    ("system", r"."),
]

TECH = [
    ("flow", "coriolis", r"coriolis|micro motion|density|densit|viscosit|specific gravity|concentration"),
    ("flow", "electromagnetic", r"magnetic|magmeter|8700|8705|8750|8800m"),
    ("flow", "vortex", r"vortex|8800"),
    ("flow", "ultrasonic-flow", r"ultrasonic|fluxus|clamp|3410|3418|3414|3818|daniel"),
    ("flow", "dp-flow", r"annubar|orifice|wedge|venturi|differential|dp flow|405|485|585|3051sfp|3051cf"),
    ("flow", "thermal-mass", r"thermal mass"),
    ("level", "guided-radar", r"guided wave|guided radar|5300|5301|5302|5303|3300"),
    ("level", "radar-level", r"radar|5408|5402|5900|1408|1208|tank gaug"),
    ("level", "point-level", r"switch|vibrating fork|point level|2100|2120|2130|2140|2160|2180"),
    ("level", "hydrostatic-level", r"hydrostatic|3051sal|3051l|submersible|dp level"),
    ("level", "ultrasonic-level", r"ultrasonic"),
    ("pressure", "dp-transmitter", r"differential|\bdp\b"),
    ("pressure", "gauges-seals", r"gauge|diaphragm seal|remote seal|manifold|1199|1159"),
    ("pressure", "pressure-transmitter", r"."),
    ("temperature", "temp-transmitter", r"transmitter|644|248|3144|3144p|848"),
    ("temperature", "temp-assembly", r"."),
    ("liquid-analysis", "ph-conductivity", r"."),
    ("gas-analysis", "gas-detection", r"flame|gas detect|combustible|toxic|\bh2s\b|spectrex|928|935|975"),
    ("gas-analysis", "gas-analyzer", r"."),
    ("valves", "valve-positioner", r"positioner|valve controller|fieldvue|dvc"),
]

DEFAULT_TYPE = {"flow": "Flow instrument", "level": "Level instrument", "pressure": "Pressure instrument",
                "temperature": "Temperature instrument", "liquid-analysis": "Liquid analysis", "gas-analysis": "Gas analysis",
                "system": "System component", "valves": "Valve / actuator"}


def clean_name(name):
    name = re.sub(r"[™®©]", "", name)
    return re.sub(r"\s+", " ", name).strip(" -–|")


def product_line(slug, name):
    for s, line in LINE_SLUGS:
        if slug.startswith(s + "-") or name.lower().startswith(line.lower() + " "):
            return line
    return ""


def product_type(name, line, category):
    """Descriptive part of the name: 'Rosemount 3051S Pressure Transmitter' -> 'Pressure transmitter'."""
    words = name.split()
    if line and name.lower().startswith(line.lower()):
        words = words[len(line.split()):]
    while words and (re.search(r"\d", words[0]) or words[0].isupper() or words[0] in ("-", "–", "Series", "Model", "Figure")):
        words = words[1:]
    t = " ".join(words).strip(" -–")
    t = re.sub(r"\s+-\s+.*$", "", t)  # drop marketing tail after " - "
    if not t or len(t) > 70:
        return DEFAULT_TYPE[category]
    return t[0].upper() + t[1:]


def slug_name(slug):
    line = next((l for s, l in LINE_SLUGS if slug.startswith(s + "-")), "")
    rest = slug[len(line) + 1:] if line else slug
    words = [w.upper() if re.search(r"\d", w) or len(w) <= 2 else w.capitalize() for w in rest.split("-")]
    words = [w.lower() if w.lower() in ("and", "for", "of", "in", "with", "the", "to") else w for w in words]
    return " ".join(filter(None, [line] + words))


def parse(url, page):
    division, slug = url.split("/")[4], url.rstrip("/").rsplit("/", 1)[1]
    if page.get("error", "").startswith("HTTP Error 404"):
        return None
    line_slug = next((s for s, _ in LINE_SLUGS if slug.startswith(s + "-")), "")
    if len(slug[len(line_slug):].strip("-").split("-")) < 2:
        return None  # e.g. "micro-motion-plkusbcablea": an accessory part number, not a product page
    name = clean_name(page.get("name") or slug_name(slug))
    desc = page.get("description", "").strip()
    if EXCLUDE.search(name) or EXCLUDE.search(slug.replace("-", " ")):
        return None
    hay = f"{name} {desc} {slug.replace('-', ' ')}".lower()
    if division == "final-control":
        category = "valves"
    else:
        category = next(c for c, rx in RULES if rx and re.search(rx, hay))
    tech = next((t for c, t, rx in TECH if c == category and re.search(rx, hay)), None)
    line = product_line(slug, name)
    return {"id": slug, "name": name, "type": product_type(name, line, category), "category": category,
            "family": line, "order": None, "tech": tech, "url": url, "image": None, "brand": "Emerson",
            "description": desc if desc.lower() != name.lower() else "",
            # Main product family pages (e.g. "Rosemount 3051S Pressure Transmitter Family") lead the product finder.
            "featured": bool(re.search(r"\b(family|series)\b", name, re.I))}


def main(urls, cache, dst):
    pages = json.load(open(cache)) if os.path.exists(cache) else {}
    old = {p["id"]: p for p in json.load(open(dst))} if os.path.exists(dst) else {}
    seen, out = set(), []
    for url in (u.strip() for u in open(urls)):
        if not url: continue
        p = parse(url, pages.get(url, {}))
        if not p or p["id"] in seen or p["name"].lower() in seen:
            continue
        seen.update((p["id"], p["name"].lower()))
        if old.get(p["id"], {}).get("image"):
            p["image"] = old[p["id"]]["image"]
        out.append(p)
    out.sort(key=lambda p: (p["category"], p["name"].lower()))
    json.dump(out, open(dst, "w"), indent=1, ensure_ascii=False)
    print(len(out), "products")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
