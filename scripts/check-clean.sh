#!/usr/bin/env bash
# Guard against the WordPress heritage creeping back into the built site.
#
# The refactor (epic org-6i7) removed every trace of the WordPress export:
# block classes, inline style attributes, plugin stylesheets, cache-busted
# "?ver=" filenames and the /assets/{themes,core,plugins,uploads} tree. Nothing
# in the repo prevents a paste, a restored backup or a careless merge from
# reintroducing one of them, so this runs on every build and fails the deploy.
#
# Usage: scripts/check-clean.sh [public-dir] [expected-hugo-version]
#        (defaults: public, .hugo-version)
#
# Exits non-zero listing every violation found. All checks run before exiting
# so one run reports everything, not just the first category.
set -euo pipefail

DIR="${1:-public}"
EXPECTED_VERSION="${2:-}"
cd "$(dirname "$0")/.."

if [ ! -d "$DIR" ]; then
  echo "ERROR: built site not found: $DIR" >&2
  echo "       run 'hugo --destination $DIR' first." >&2
  exit 1
fi

# Fall back to the pinned version file so CI and local runs agree.
if [ -z "$EXPECTED_VERSION" ] && [ -f .hugo-version ]; then
  EXPECTED_VERSION="$(tr -d '[:space:]' < .hugo-version)"
fi

python3 - "$DIR" "$EXPECTED_VERSION" <<'PY'
import os, re, sys

root = sys.argv[1]
expected_version = sys.argv[2] if len(sys.argv) > 2 else ""

# Every class prefix the WordPress export used to emit. Matching is on whole
# class tokens, so a legitimate name such as "language-switcher" is untouched
# while "has-global-padding" is caught.
WP_CLASS = re.compile(
    r'(?:^|\s)(?:'
    r'block-[\w-]+|'            # block-paragraph, block-columns, block-media-text...
    r'has-[\w-]+|'              # has-text-align-center, has-global-padding...
    r'is-[\w-]+|'               # is-layout-flex, is-style-rounded...
    r'container-core[\w-]*|'    # container-core-group-is-layout-...
    r'elements-[\w-]+|'         # elements-1, elements-2...
    r'alignwide|alignfull|'
    r'wp-[\w-]+'
    r')(?=\s|$)'
)

CLASS_ATTR = re.compile(r'class\s*=\s*["\']([^"\']*)["\']', re.I)
STYLE_ATTR = re.compile(r'\sstyle\s*=\s*["\'][^"\']*["\']', re.I)
# A <style> element in the output means a plugin stylesheet has been inlined
# into content again (contact-lite and trouver-nos-cabines both did this).
STYLE_ELEMENT = re.compile(r'<style\b', re.I)
# Attribute order and quoting vary: --minify emits name=generator content="..."
# while an unminified build emits name="generator" content="...". Match either.
# Attribute order, quoting and spacing all vary with --minify, so parse the tag
# and read name/content independently rather than matching one literal form.
META_TAG = re.compile(r'<meta\b[^>]*>', re.I)
ATTR_PAIR = re.compile(r'([\w-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))')


def attr(tag, name):
    for m in ATTR_PAIR.finditer(tag):
        if m.group(1).lower() == name:
            return (m.group(2) or m.group(3) or m.group(4) or '').strip()
    return None


def generator_versions(html):
    out = []
    for tag in META_TAG.findall(html):
        if (attr(tag, 'name') or '').lower() == 'generator':
            content = attr(tag, 'content') or ''
            if content.lower().startswith('hugo'):
                out.append(content.split('Hugo', 1)[1].strip())
    return out
WP_ASSET_PATH = re.compile(r'/assets/(?:themes|core|plugins|uploads)/', re.I)
VER_QUERY = re.compile(r'[?&]ver=', re.I)

# The stylesheet budget. Comments are excluded so the number measures rules,
# not documentation; this file deliberately records why each rule exists.
CSS_BUDGET_BYTES = 25 * 1024

violations = []

html_files = []
for dirpath, _dirnames, filenames in os.walk(root):
    for f in filenames:
        if f.endswith('.html'):
            html_files.append(os.path.join(dirpath, f))
html_files.sort()

for page in html_files:
    rel = os.path.relpath(page, root)
    with open(page, encoding='utf-8', errors='replace') as fh:
        html = fh.read()

    for m in CLASS_ATTR.finditer(html):
        for token in m.group(1).split():
            if WP_CLASS.match(token):
                violations.append((rel, f'WordPress class "{token}"'))

    for m in STYLE_ATTR.finditer(html):
        snippet = ' '.join(m.group(0).split())[:60]
        violations.append((rel, f'inline style attribute: {snippet}'))

    for m in STYLE_ELEMENT.finditer(html):
        violations.append((rel, 'inlined <style> element in generated HTML'))

    for m in WP_ASSET_PATH.finditer(html):
        violations.append((rel, f'WordPress asset path "{m.group(0)}"'))

    for m in VER_QUERY.finditer(html):
        context = html[max(0, m.start() - 40):m.end() + 12].replace('\n', ' ')
        violations.append((rel, f'"?ver=" cache-buster: ...{context.strip()}'))

    # Hugo's alias pages (/fr/index.html and friends) are auto-generated
    # redirect stubs, not rendered from our layouts, so they legitimately carry
    # no generator tag and none of our markup. Skip them rather than weaken the
    # check for real pages.
    # Quoting differs between minified (http-equiv=refresh) and plain builds,
    # so detect the redirect by structure: a refresh meta and no body content.
    is_alias = (len(re.findall(r'http-equiv\s*=\s*["\']?refresh', html, re.I)) >= 1
                and not re.search(r'<body', html, re.I))

    # Exactly one <meta name="generator">, naming the pinned Hugo.
    gens = generator_versions(html)
    if not gens and not is_alias:
        violations.append((rel, 'missing <meta name="generator" content="Hugo x.y.z">'))
    elif expected_version:
        for got in gens:
            if got != expected_version:
                violations.append(
                    (rel, f'Hugo version mismatch: page says {got}, '
                          f'.hugo-version pins {expected_version} (stale build?)'))

# Stylesheet budget: measure the rules, ignoring /* comment */ blocks.
css_sizes = {}
for dirpath, _dirnames, filenames in os.walk(root):
    for f in filenames:
        if not f.endswith('.css'):
            continue
        path = os.path.join(dirpath, f)
        with open(path, encoding='utf-8', errors='replace') as fh:
            css = fh.read()
        without_comments = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        size = len(without_comments.encode('utf-8'))
        css_sizes[os.path.relpath(path, root)] = size
        if size > CSS_BUDGET_BYTES:
            violations.append(
                (os.path.relpath(path, root),
                 f'stylesheet exceeds budget: {size} B of rules '
                 f'(limit {CSS_BUDGET_BYTES} B, comments excluded)'))

# One stylesheet only: a second one means a plugin sheet came back.
if len(css_sizes) > 1:
    violations.append(
        ('(css)', f'{len(css_sizes)} stylesheets shipped ({", ".join(sorted(css_sizes))}); '
                  'the refactor keeps exactly one'))

# No WordPress-style cache-busted filenames on disk either.
for dirpath, _dirnames, filenames in os.walk(root):
    for f in filenames:
        if VER_QUERY.search(f) or WP_CLASS.search(f):
            violations.append((os.path.relpath(dirpath, root), f'WordPress-style filename "{f}"'))

print(f'checked {len(html_files)} page(s) and {len(css_sizes)} stylesheet(s) in {root}/')
for name, size in sorted(css_sizes.items()):
    print(f'  {name}: {size} B of rules')

if violations:
    print(f'\n{len(violations)} WordPress-heritage violation(s):', file=sys.stderr)
    for where, what in violations[:40]:
        print(f'  {where}: {what}', file=sys.stderr)
    if len(violations) > 40:
        print(f'  ... and {len(violations) - 40} more', file=sys.stderr)
    sys.exit(1)

print('no WordPress heritage found.')
PY
