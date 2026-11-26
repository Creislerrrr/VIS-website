#!/usr/bin/env python3
# VIS website maintenance tool (run by hand, not used by the server): adds product photos to
# frontend/images/eh/ and links them in the catalog data. Run from the project root; see the usage below.
"""Import official Endress+Hauser product photos into the website.

    python3 tools/import-images.py ~/Downloads/EH-Bilder            # match, convert, update catalog
    python3 tools/import-images.py ~/Downloads/EH-Bilder --dry-run  # only show what would be matched

Each image file is matched to a product by its file name. Any of these work:
    Promag_W400.jpg   promag-w-400.png   FMR62B.jpg   CPS11E_front.webp
    coriolis-flowmeter-promass-f300-8f3b.jpg   (the product id, i.e. the last part of the E+H URL)

Every matched photo is converted to the same style: trimmed, centred on a white
800 x 600 canvas, saved as JPEG in frontend/images/eh/<product-id>.jpg.
Requires ImageMagick (`magick`). Unmatched files are listed at the end.
"""
import json, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "backend" / "data" / "eh-products.json"
OUT_DIR = ROOT / "frontend" / "images" / "eh"
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".gif", ".bmp"}

norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())


def keys_for(p):
    """Search keys for a product, most specific first."""
    keys = {norm(p["id"]), norm(p["name"]), norm(p["name"].replace("Proline ", ""))}
    for tok in re.split(r"[\s/]+", p["name"]):
        if re.search(r"\d", tok) and re.search(r"[A-Za-z]", tok) and len(tok) >= 4:
            keys.add(norm(tok))            # model codes such as FMR62B, CPS11E
    if p.get("order"):
        keys.update(norm(o) for o in p["order"].split("/"))
    return {k for k in keys if len(k) >= 4}


def match(filename, index):
    stem = norm(Path(filename).stem)
    best = None
    for key, pid in index:
        if key in stem and (best is None or len(key) > len(best[0])):
            best = (key, pid)
    return best[1] if best else None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if not args:
        sys.exit(__doc__)
    src = Path(args[0]).expanduser()
    if not src.is_dir():
        sys.exit(f"Folder not found: {src}")
    if not dry and not shutil.which("magick"):
        sys.exit("ImageMagick is required: install it, e.g. `sudo pacman -S imagemagick`.")

    products = json.loads(CATALOG.read_text())
    index = [(k, p["id"]) for p in products for k in keys_for(p)]
    by_id = {p["id"]: p for p in products}

    files = sorted(f for f in src.rglob("*") if f.suffix.lower() in EXTS)
    matched, unmatched = {}, []
    for f in files:
        pid = match(f.name, index)
        if pid and pid not in matched:
            matched[pid] = f
        else:
            unmatched.append(f)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for pid, f in matched.items():
        print(f"  {f.name:45} -> {by_id[pid]['name']}")
        if dry:
            continue
        out = OUT_DIR / f"{pid}.jpg"
        subprocess.run(["magick", str(f), "-auto-orient", "-background", "white", "-alpha", "remove", "-alpha", "off",
                        "-fuzz", "4%", "-trim", "+repage", "-resize", "680x500>", "-gravity", "center",
                        "-extent", "800x600", "-strip", "-quality", "85", str(out)], check=True)
        by_id[pid]["image"] = f"images/eh/{pid}.jpg"

    if not dry:
        CATALOG.write_text(json.dumps(products, indent=1, ensure_ascii=False))
    with_img = sum(1 for p in products if p.get("image"))
    print(f"\n{len(matched)} matched, {len(unmatched)} unmatched. {with_img} of {len(products)} products have a photo."
          + ("  (dry run, nothing changed)" if dry else "  Restart the server to see them."))
    if unmatched:
        print("\nNot matched (rename to the product name or model code, e.g. 'Promag_W400.jpg'):")
        for f in unmatched:
            print("  ", f.name)


if __name__ == "__main__":
    main()
