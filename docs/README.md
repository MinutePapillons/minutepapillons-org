# Archived provenance

## `build_hugo.py`

The one-off converter that turned the `minutepapillons.org` WordPress static
mirror into a first Hugo port. **Do not run it.**

It is kept only as a record of where the content came from. Its assumptions no
longer hold: it emits `assets/{uploads,plugins,themes}` and `assets/core`, and
those trees were removed by epic `org-6i7` (assets became `static/{img,css,fonts}`).
Running it now would regenerate the WordPress-derived markup, classes and
stylesheets that the refactor deliberately deleted.

The hand-written site is the source of truth; see the top-level `README.md`.
`scripts/check-clean.sh` fails CI if any WordPress heritage reappears.
