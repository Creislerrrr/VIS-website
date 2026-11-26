#!/usr/bin/env python3
"""Fetch name (h1) and short description of Emerson product pages into a JSON cache.

Usage: python3 tools/fetch-emerson-pages.py tools/emerson-sitemap-urls.txt tools/emerson-pages.json
tools/emerson-sitemap-urls.txt = product URLs from https://www.emerson.com/en.sitemap-index.xml
(the "products" sitemaps), filtered to named product pages (spare-part numbers dropped).
Already cached URLs are skipped, so the script can be re-run after an interruption.
emerson.com rate-limits (HTTP 429 + Retry-After), so pages are fetched one at a time with a pause.
"""
import html, json, os, re, sys, time, urllib.error, urllib.request

UA = {"User-Agent": "Mozilla/5.0"}


def fetch(url):
    err = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                page = r.read().decode("utf-8", "replace")
            h1 = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
            desc = re.search(r'<meta name="description" content="([^"]*)"', page)
            clean = lambda s: re.sub(r"\s+", " ", html.unescape(html.unescape(re.sub(r"<[^>]+>", "", s)))).strip()
            return url, {"name": clean(h1.group(1)) if h1 else "", "description": clean(desc.group(1)) if desc else ""}
        except urllib.error.HTTPError as e:
            err = str(e)
            if e.code == 429:
                wait = min(900, int(e.headers.get("Retry-After") or 120)) + 5
                print(f"rate limited, waiting {wait}s", flush=True); time.sleep(wait)
            elif e.code == 404:
                break
            else:
                time.sleep(5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001 - network errors: retry, then record
            err = str(e)
            time.sleep(5 * (attempt + 1))
    return url, {"error": err}


def main(src, dst):
    cache = json.load(open(dst)) if os.path.exists(dst) else {}
    todo = [u.strip() for u in open(src) if u.strip() and "error" in cache.get(u.strip(), {"error": 1})]
    print(len(todo), "pages to fetch")
    for i, url in enumerate(todo, 1):
        cache[url] = fetch(url)[1]
        if i % 25 == 0:
            json.dump(cache, open(dst, "w"), indent=1, ensure_ascii=False); print(i, flush=True)
        time.sleep(2.5)
    json.dump(cache, open(dst, "w"), indent=1, ensure_ascii=False)
    print("errors:", sum("error" in v for v in cache.values()))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
