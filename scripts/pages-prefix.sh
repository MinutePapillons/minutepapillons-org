#!/usr/bin/env bash
# Rewrite root-absolute references in the built site (public/) for a
# subpath deployment (GitHub project Pages).
#
# Source files keep root-absolute URLs (WordPress mirror convention) so
# `hugo serve` / `hugo build` locally always work at "/". This script is
# the only place that injects the deployment subpath.
#
# Usage: scripts/pages-prefix.sh /subpath/
#   e.g. scripts/pages-prefix.sh /minutepapillons-org
#
# This script is the deploy gate: it refuses to run on a tree that already
# carries a (foreign) subpath prefix, and it fails if any @font-face or
# root-absolute url() in the CSS would 404 once served from /subpath/.
# Rationale: a single bad run (`pages-prefix.sh --help`) baked /--help/ into
# the committed CSS and every web font 404'd for several deploys, silently.
set -euo pipefail

SUB="${1:-}"
if [ -z "$SUB" ]; then
  echo "usage: pages-prefix.sh /subpath/" >&2
  exit 2
fi
# Reject anything that is not a plain subpath: this is what let `--help`
# (or any typo) become an asset prefix in the first place.
if ! [[ "$SUB" =~ ^/[A-Za-z0-9][A-Za-z0-9._-]*/?$ ]]; then
  echo "ERROR: invalid subpath '$SUB' — expected /name (letters, digits, '.', '_', '-')" >&2
  echo "usage: pages-prefix.sh /subpath/" >&2
  exit 2
fi

CORE="${SUB#/}"; CORE="${CORE%/}"
cd "$(dirname "$0")/.."

if [ ! -d public ]; then
  echo "ERROR: public/ not found — run from the repo root, with the built site in public/" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Refuse a tree that is already prefixed (double-prefix or foreign prefix).
# ---------------------------------------------------------------------------
# Guard against double-prefixing: refuse only if public/ already carries a
# prefixed ref IN A REWRITABLE POSITION (what the sed rules below would have
# produced). Absolute OpenGraph URLs (og:url / og:image) legitimately contain
# /SUB/assets/ preceded by the domain, not a quote/paren/comma/href=, so
# they must NOT trip the guard.
if grep -rqE "href=\"/${CORE}/|[\"']/${CORE}/(assets|css)/|url\(/${CORE}/assets/|, /${CORE}/assets/" public/ 2>/dev/null; then
  echo "public/ already contains /${CORE}/ refs — refusing to double-prefix." >&2
  exit 1
fi

# Refuse ANY other baked-in subpath prefix (e.g. url("/--help/assets/...").
# Those refs are invisible to the sed rules below, so they would ship as 404s.
FOREIGN="$(
  grep -rhoE "[\"'(] */[A-Za-z0-9._-]+/(assets|css)/" public/ \
    --include='*.html' --include='*.css' 2>/dev/null \
    | sed -E "s|^[\"'(] *||" | sort -u | grep -v "^/${CORE}/" || true
)"
if [ -n "$FOREIGN" ]; then
  echo "ERROR: public/ already carries a foreign subpath prefix:" >&2
  printf '%s\n' "$FOREIGN" | head >&2
  echo "Source files must use root-absolute /assets/... refs; fix them, then retry." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. WordPress-style versioned asset filenames.
# ---------------------------------------------------------------------------
# The WP mirror kept literal "?ver=..." in some asset FILENAMES
# (e.g. style.min.css?ver=7.1.1.css) and the HTML refs encode them as
# %3Fver=... . GitHub Pages cannot route those: server-side the "?" starts a
# query string, so the request 404s. Strip the version suffix at deploy time
# only (source/public keep the WP-mirror convention).
find public -type f -name '*[?]*' -print0 | while IFS= read -r -d '' f; do
  case "$f" in
    *'?ver='*) ;;
    *) echo "ERROR: unexpected '?' in filename: $f" >&2; exit 1 ;;
  esac
  clean="${f%%[?]ver=*}"
  if [ -e "$clean" ]; then
    echo "ERROR: rename would clobber existing $clean" >&2; exit 1
  fi
  mv "$f" "$clean"
  echo "renamed -> $clean"
done

find public -type f \( -name '*.html' -o -name '*.css' \) -print0 | xargs -0 sed -i \
  -e 's|%3Fver=[0-9.]*\.[A-Za-z0-9]*||g'

# ---------------------------------------------------------------------------
# 3. Prefix root-absolute refs with the subpath.
# ---------------------------------------------------------------------------
# Order matters: the href rule runs FIRST so it prefixes href="/assets/..
# in one step and the asset rules (which require a quote right before the
# path) can never re-match the already-prefixed string. The url("..."/'...'
# rules include the leading slash so a url() can never become a *relative*
# path (which resolves under /SUB/css/ and 404s).
find public -type f \( -name '*.html' -o -name '*.css' \) -print0 | xargs -0 sed -i \
  -e "s|href=\"/|href=\"/${CORE}/|g" \
  -e "s|\"/assets/|\"/${CORE}/assets/|g" \
  -e "s|'/assets/|'/${CORE}/assets/|g" \
  -e "s|\"/css/|\"/${CORE}/css/|g" \
  -e "s|'/css/|'/${CORE}/css/|g" \
  -e "s|url(/assets/|url(/${CORE}/assets/|g" \
  -e "s|url(\"/assets/|url(\"/${CORE}/assets/|g" \
  -e "s|url('/assets/|url('/${CORE}/assets/|g" \
  -e "s|, /assets/|, /${CORE}/assets/|g"

# ---------------------------------------------------------------------------
# 4. Verify the output — fail the deploy instead of shipping 404 assets.
# ---------------------------------------------------------------------------
# Sanity check: no bare root refs may remain (any occurrence of /assets/ or
# /css/ preceded by a quote, comma, or opening paren must be prefixed).
if grep -rnE "[\"',] */(assets|css)/" public/ 2>/dev/null | grep -v "/${CORE}/" | grep -q .; then
  echo "ERROR: unprefixed refs remain in public/:" >&2
  grep -rnE "[\"',] */(assets|css)/" public/ | grep -v "/${CORE}/" | head >&2
  exit 1
fi

# No url() may point at a root path that is not /SUB/... (catches leftovers
# such as url("/--help/assets/...) that no sed rule rewrote).
BAD_URLS="$(
  grep -rhoE "url\(['\"]?/[^)'\"]*" public/ --include='*.css' 2>/dev/null \
    | sed -E "s|^url\(['\"]?||" | sort -u | grep -v "^/${CORE}/" || true
)"
if [ -n "$BAD_URLS" ]; then
  echo "ERROR: root-absolute url() not prefixed with /${CORE}/:" >&2
  printf '%s\n' "$BAD_URLS" | head >&2
  exit 1
fi

# No url() may have lost its leading slash (relative path => 404 under /SUB/css/).
if grep -rqE "url\(['\"]${CORE}/" public/ --include='*.css' 2>/dev/null; then
  echo "ERROR: malformed relative url() (missing leading slash) in public/:" >&2
  grep -rnE "url\(['\"]${CORE}/" public/ --include='*.css' | head >&2
  exit 1
fi

# Every web font declared in the deployed CSS must resolve to a real file.
PREFIX="/${CORE}"
missing=0
while IFS= read -r u; do
  path="${u%%[?#]*}"
  case "$path" in
    /*) ;;
    *) continue ;;  # data: URI, absolute URL, or intentional relative path
  esac
  [ -f "public${path#"$PREFIX"}" ] && continue
  echo "ERROR: @font-face asset missing in public/: $path" >&2
  missing=1
done < <(
  grep -rhoE '@font-face\{[^}]*\}' public/ --include='*.css' 2>/dev/null \
    | grep -oE 'url\([^)]*\)' \
    | sed -E "s|^url\(['\"]?||; s|\)$||; s|['\"]$||" \
    | sort -u
)
if [ "$missing" -ne 0 ]; then
  echo "ERROR: declared web fonts do not resolve — headings/body would fall back." >&2
  exit 1
fi

# The families the typography depends on must still be declared at all.
for fam in "GIANT BOYS" "Neue Machina"; do
  if ! grep -rqF "font-family:\"${fam}\"" public/ --include='*.css' 2>/dev/null; then
    echo "ERROR: no @font-face declares \"${fam}\" in public/ — typography would fall back." >&2
    exit 1
  fi
done

echo "public/ prefixed with /${CORE}/ — ready for subpath deploy."
