# overrides/

Curator-only settings that sit on top of the registry entries. They are applied when the catalog is built and are never touched by submissions, so re-submitting a theme cannot undo a curator decision. Edit these files by hand (or via a pull request); the build workflow picks them up on push to `master`.

Both files are validated against `Overrides` in `packages/schema/src/index.ts`. A slug must be a valid theme slug (`^[a-z0-9_][a-z0-9._+-]*$`, the same rule Omarchy applies to install names); unknown keys are rejected.

## `featured.json`

An array of slugs to show as featured on the site. Order does not matter — the site sorts. The site only shows its "Featured" filter (and uses it as the default) when this list is non-empty.

```json
["aetheria", "vhs80", "blackgold"]
```

Each listed theme gets `"featured": true` in the catalog. A slug that is not currently in the catalog (excluded, missing, or hidden) is simply ignored.

## `hidden.json`

An object of `slug → reason`. A hidden theme is left out of the catalog but keeps its `themes/<slug>.json` entry, so the slug stays claimed and nobody else can take the name. Use it for temporary removals — a theme with a problem screenshot, a takedown request, a duplicate — and delete the registry entry instead when a theme is gone for good.

```json
{
	"vaporwave-dupe": "Duplicate of vaporwave; author asked to keep the slug",
	"some-theme": "Preview contains personal data; waiting for the author to replace it"
}
```

The reason is for maintainers and appears in `dist/v1/report.json` under `hidden`; it is not published to the site.

## Slugs, not names

Slugs are what Omarchy derives from the repository name (`omarchy-` prefix and `-theme` suffix removed, lowercased), so they can differ from the display name: "Black Gold" is `blackgold`, "Harbor Dark" is `harbordark`. Check `themes/` for the file name if in doubt.
