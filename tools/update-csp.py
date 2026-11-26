#!/usr/bin/env python3
"""Recompute the Content-Security-Policy in index.html.

The app has a few inline <script> blocks, so the policy allows each one by its SHA-256 hash instead of allowing all inline
scripts. Run this after editing ANY inline script, or the browser will refuse to run it:

    python3 tools/update-csp.py            # rewrite the policy
    python3 tools/update-csp.py --check    # exit 1 if the policy is out of date (used by tests/run.html's twin check)
"""
import base64, hashlib, re, sys, pathlib

path = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
html = path.read_text(encoding='utf-8')

# The API the page talks to is declared once in index.html (const API_URL = IS_LOCAL ? '<local>' : '<production>'); connect-src is derived from it.
m = re.search(r"const API_URL = IS_LOCAL \? '(http://localhost:\d+)' : '(https://[^']+)'", html)
assert m, 'API_URL not found in index.html'
api_local, api_prod = m.group(1), m.group(2)

# inline classic scripts only (no src, not a module)
scripts = [m.group(1) for m in re.finditer(r'<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>(.*?)</script>', html, re.S)]
hashes = ' '.join("'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode() for s in scripts)

policy = "; ".join([
    "default-src 'none'",
    f"script-src 'self' {hashes} https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    f"connect-src 'self' https://accounts.google.com/gsi/ {api_prod} {api_local}",   # the API: production Worker, and the local one for tests
    "frame-src 'self' https://accounts.google.com/gsi/",   # 'self' = the sandboxed HEIC converter page
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
])
new = re.sub(r'(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)', lambda m: m.group(1) + policy + m.group(2), html, count=1)
if '--check' in sys.argv:
    sys.exit(0 if new == html else 1)
path.write_text(new, encoding='utf-8')
print(f'{len(scripts)} inline scripts hashed; policy updated ({len(policy)} chars)')
