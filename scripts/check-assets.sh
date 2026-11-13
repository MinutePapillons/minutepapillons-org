#!/usr/bin/env bash
# Verify that every local asset referenced by the built site exists on disk.
#
# This replaces the runtime guard that used to live in scripts/pages-prefix.sh.
# The site no longer rewrites URLs at deploy time (hugo.toml: relativeURLs =
# true), so the only thing left to check is that the refs Hugo emitted actually
# resolve — a missing stylesheet or web font is silent otherwise (headings just
# fall back for every visitor).
#
# Usage: scripts/check-assets.sh [public-dir]   (default: public)
#
# Resolves BOTH root-absolute (/img/x.png — what a baseURL-less build emits)
# and page-relative (./img/x.png, ../css/x.css) refs, so it works for any
# deployment target. Exits non-zero on the first category that fails.
set -euo pipefail

DIR="${1:-public}"
cd "$(dirname "$0")/.."

if [ ! -d "$DIR" ]; then
  echo "ERROR: built site not found: $DIR" >&2
  echo "       run 'hugo --destination $DIR' first." >&2
  exit 1
fi

python3 - "$DIR" <<'PY'
import os, re, sys
from urllib.parse import urljoin, urlparse

root = sys.argv[1]
# Directories that hold generated pages and assets.
html_files = []
for dirpath, _dirnames, filenames in os.walk(root):
    for f in filenames:
        if f.endswith('.html'):
            html_files.append(os.path.join(dirpath, f))
html_files.sort()

CSS_URL = re.compile(r'url\(\s*["\']?([^)"\']+)["\']?\s*\)')
ATTR = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
SRCSET = re.compile(r'srcset\s*=\s*["\']([^"\']+)["\']', re.I)

def page_url(path):
    """URL path Hugo would serve this file at, e.g. dir/en/index.html -> /dir/en/"""
    rel = os.path.relpath(path, root).replace(os.sep, '/')
    return '/' + (rel[:-len('index.html')] if rel.endswith('index.html') else rel)

def is_external(u):
    return u.startswith(('http://', 'https://', '//', 'data:', 'mailto:', 'tel:', '#', 'javascript:'))

def resolve_to_file(page_path, ref):
    """Map a ref on a page to a file on disk under root, or None if external."""
    if is_external(ref):
        return None
    # Drop query/fragment: those are not part of the file path.
    ref = ref.split('#')[0].split('?')[0]
    if not ref:
        return None
    base = 'https://x' + page_url(page_path)
    absolute = urlparse(urljoin(base, ref)).path  # always site-root-relative
    return os.path.join(root, absolute.lstrip('/'))

missing = []
checked = 0
seen = set()

for page in html_files:
    with open(page, encoding='utf-8', errors='replace') as fh:
        html = fh.read()

    refs = ATTR.findall(html)
    for ss in SRCSET.findall(html):
        for part in ss.split(','):
            token = part.strip().split()
            if token:
                refs.append(token[0])

    for ref in refs:
        target = resolve_to_file(page, ref)
        if target is None:
            continue
        # Only validate things that look like files (skip bare directory links).
        if not re.search(r'\.(css|m?js|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|ico|pdf|xml)$', target, re.I):
            continue
        key = (target, ref)
        if key in seen:
            continue
        seen.add(key)
        checked += 1
        if not os.path.isfile(target):
            missing.append((page, ref, target))

    # url() refs inside stylesheets linked from this page.
    for ref in ATTR.findall(html):
        css_file = resolve_to_file(page, ref)
        if not css_file or not css_file.endswith('.css') or not os.path.isfile(css_file):
            continue
        with open(css_file, encoding='utf-8', errors='replace') as fh:
            css = fh.read()
        for u in CSS_URL.findall(css):
            u = u.strip()
            if is_external(u):
                continue
            u = u.split('#')[0].split('?')[0]
            if not u:
                continue
            target = os.path.join(os.path.dirname(css_file), u) if not u.startswith('/') else os.path.join(root, u.lstrip('/'))
            target = os.path.normpath(target)
            key = (target, u)
            if key in seen:
                continue
            seen.add(key)
            checked += 1
            if not os.path.isfile(target):
                missing.append((css_file, u, target))

# The two faces the typography depends on must actually ship.
fonts_dir = os.path.join(root, 'fonts')
if os.path.isdir(fonts_dir):
    have = {f.lower() for f in os.listdir(fonts_dir)}
    for need in ('giant-boys.woff2', 'neuemachina-regular.woff2'):
        if need not in have:
            missing.append(('(fonts)', need, os.path.join(fonts_dir, need)))

# Weird WordPress-style filenames must never come back.
for dirpath, _d, filenames in os.walk(root):
    for f in filenames:
        if '?' in f or '%3F' in f:
            missing.append(('(filename)', f, os.path.join(dirpath, f)))

print(f"checked {checked} asset reference(s) across {len(html_files)} page(s) in {root}/")
if missing:
    print(f"\n{len(missing)} MISSING:", file=sys.stderr)
    for page, ref, target in missing[:25]:
        print(f"  {os.path.relpath(page, root)} -> {ref}", file=sys.stderr)
    if len(missing) > 25:
        print(f"  ... and {len(missing) - 25} more", file=sys.stderr)
    sys.exit(1)
print("all referenced assets resolve.")
PY
