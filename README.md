# Minute papillons — static site (Hugo)

Static Hugo build of https://www.minutepapillons.org — the 6 pages of the live site,
in French (default language, at the site root) and English (under `/en/`):

- `/` (accueil) → `/en/` (home)
- `/220-2/` → `/en/220-2/`
- `/louez-moi/` → `/en/louez-moi/`
- `/trouver-nos-cabines/` → `/en/trouver-nos-cabines/`
- `/on-parle-de-votre-projet/` → `/en/on-parle-de-votre-projet/`
- `/questions-frequentes/` → `/en/questions-frequentes/`

## Multilingual (FR / EN)

- Content lives in `content/fr/` and `content/en/` (Hugo per-language content dirs).
- `hugo.toml` declares both languages: FR is `defaultContentLanguage` (weight 1,
  served at the root) and EN is weight 2 (served under the `/en/` language
  subdirectory).
  **NB (Hugo ≥ 0.159):** `languages.*.contentDir` is relative to the *project*
  root, so it must be `content/fr` / `content/en` (not just `fr` / `en`);
  with the old-style `fr` / `en` values Hugo silently finds no content files.
- `layouts/partials/header.html` renders the main nav from the `main` menu
  (per-language `menu.main` entries in the page front matter) and a language
  switcher from `.AllTranslations`.
- `layouts/baseof.html` emits per-page `<link rel="alternate" hreflang>`
  alternates plus `x-default` (the default-language home), and sets
  `<html lang>` from the page's language locale.
- Translations are linked by identical path/basename under each language
  directory (Hugo's "translation by directory" scheme). To add a page in EN,
  create `content/en/<same-path>/` so Hugo links it automatically; the
  switcher picks it up with no template changes.
- Asset URLs are page-relative (`hugo.toml`: `relativeURLs = true`), so the
  same build works at a project subpath (`/minutepapillons-org/`), at an apex
  domain, or on `alx.github.io` with no URL rewriting at deploy time. This
  replaced `scripts/pages-prefix.sh`, whose sed pass once baked `"/--help/"`
  into the output and 404'd every web font.

## Layout

- `hugo.toml`, `content/`, `layouts/`, `static/` — Hugo source
- `public/` — built site (served as-is; `hugo build` regenerates it here)
- `build_hugo.py` — original converter from the WordPress mirror (provenance).
  It expects the WP mirror checkout next to it and outputs to `./hugo/`; the
  mirror is archived in `../minutepapillons-wp-mirror-*.tar.gz`. Do not run it
  without the mirror extracted.

## Layout

- `hugo.toml`, `content/`, `layouts/`, `static/` — Hugo source
- `public/` — built site (served as-is; `hugo build` regenerates it here)
- `build_hugo.py` — original converter from the WordPress mirror (provenance).
  It expects the WP mirror checkout next to it and outputs to `./hugo/`; the
  mirror is archived in `../minutepapillons-wp-mirror-*.tar.gz`. Do not run it
  without the mirror extracted.

## Build

```sh
hugo --baseURL https://minutepapillons.github.io/minutepapillons-org/ # → public/
bash scripts/check-assets.sh public   # fail the deploy on a 404 asset/font
bash scripts/check-clean.sh public    # fail the deploy on WordPress heritage
```

`check-clean.sh` is the anti-regression guard for epic `org-6i7`. It fails the
build if any of this comes back: `block-*` / `has-*` / `is-*` / `container-core*`
`elements-*` / `alignwide` / `alignfull` classes, inline `style=` attributes,
an inlined `<style>` element, `/assets/{themes,core,plugins,uploads}/` paths,
`?ver=` cache-busters, a second stylesheet (the site ships exactly one), a
stylesheet over 25 KB of rules (comments excluded), or a `<meta name="generator">`
that disagrees with `.hugo-version` (i.e. a stale build). It parses minified and
plain output alike.

Hugo is pinned in `.hugo-version` (and `HUGO_VERSION` in the workflow, which
fails if the two disagree). CI builds the site and publishes `public/`; that
directory is **not** committed (see `.gitignore`) — a stale `public/` would be
whatever the deploy publishes.

Two targets share one build: `https://minutepapillons.github.io/minutepapillons-org/`
and `https://alx.github.io/`. The OpenGraph tags always point at the org site
(`ogBase` in `hugo.toml`), so the canonical URL is stable from either host.

## Vérification visuelle

Le harnais compare les styles calculés (police, corps, couleurs, marges,
largeurs) et le texte de chaque page × largeur, plus les fontes réellement
chargées et les requêtes réseau en échec. Il ne compare **pas** les pixels :
le rendu de texte diffère trop d'une machine à l'autre pour être un critère.

```sh
npm install                                    # puppeteer-core uniquement
CHROME_BIN=$(command -v chrome || command -v chromium) \
  scripts/run-visual.sh --mode baseline --base http://127.0.0.1:8080/ --dir .visual-baseline
# ... après modification ...
CHROME_BIN=... scripts/run-visual.sh --mode compare \
  --base http://127.0.0.1:8080/ --dir .visual-baseline --no-shots --widths 375
```

`scripts/run-visual.sh` borne la mémoire du processus (scope systemd) : sur une
petite machine, Chromium peut provoquer un OOM global et emporter d'autres
services. Lancer **une largeur à la fois** pour la même raison.

`scripts/font-census.mjs` relève les fontes effectivement rendues sur chaque
page : c'est lui qui a montré qu'Inter restait utilisée par `figcaption` alors
que le bead annonçait le contraire.
