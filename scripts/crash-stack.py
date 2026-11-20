#!/usr/bin/env python3
"""Print the crashed thread of a macOS .ips crash report (JSON after a one-line header), symbolized
as far as the report goes. Used by CI to put a test crash's stack in the log."""
import json, sys

text = open(sys.argv[1]).read()
header, _, body = text.partition("\n")
r = json.loads(body)
images = r.get("usedImages", [])
exc = r.get("exception", {})
print(f"{json.loads(header).get('name', '?')}: {exc.get('type')} {exc.get('signal')} {exc.get('subtype', '')}")
print("termination:", r.get("termination", {}).get("indicator", ""))
for i, t in enumerate(r.get("threads", [])):
    if not t.get("triggered"):
        continue
    print(f"Crashed thread {i} {t.get('queue', t.get('name', ''))}:")
    for n, f in enumerate(t.get("frames", [])):
        img = images[f["imageIndex"]] if f.get("imageIndex", -1) < len(images) else {}
        sym = f.get("symbol", "?")
        loc = f" ({f['sourceFile']}:{f.get('sourceLine', '')})" if "sourceFile" in f else ""
        print(f"  {n:3} {img.get('name', '?'):34} {sym}{loc}")
