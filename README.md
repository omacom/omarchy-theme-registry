# Omarchy Themes Registry

The source of truth for community themes listed on [themes.omarchy.org](https://themes.omarchy.org). One small JSON file per theme goes in, a validated, versioned catalog comes out.

```
themes/<slug>.json   →  validator  →  dist/v1/catalog.json + previews  →  R2 (cdn.themes.omarchy.org)
```

## How a theme gets listed

Add `themes/<slug>.json`, where `<slug>` is what Omarchy derives from the repo name (`omarchy-` prefix and `-theme` suffix stripped, lowercased):

```json
{
	"slug": "nujabes",
	"repo": "https://github.com/HalmyLyseas/omarchy-nujabes-theme",
	"name": "Nujabes",
	"submitted_by": "HalmyLyseas",
	"added_at": "2026-09-07"
}
```

That is the whole entry. Mode, palette, author, preview, license and everything else is read from the theme repo itself, so there is nothing to keep in sync. Opening a PR runs the validator against the repo and posts the report on the PR; entries with errors cannot be merged.

Slugs are first-come: the first merged entry keeps the name, and the 22 built-in Omarchy themes are reserved.

### Curator overrides

- `overrides/featured.json` — array of slugs shown as featured.
- `overrides/hidden.json` — `{ "slug": "reason" }`, removes a theme from the catalog without deleting its entry (keeps the slug claimed).

## What the validator checks

Everything `omarchy theme install` enforces, plus what makes a good listing. Errors block; warnings are published on the theme page.

**Errors** — repo missing or private, slug invalid / built-in / already taken, theme not at repo root, symlinks, no palette (`colors.toml`, or legacy `alacritty.toml` to derive from), palette missing required keys or with bad values for them, no `preview.png` at the root (Omarchy's theme switcher shows it, so the site shows the same file), preview under 1000 px wide, images over 50 MB / 40 MP, repo over 400 MB.

**Warnings** — archived repo, files Omarchy drops on install (`*.lua`, terminal configs, `vscode.json`), undeclared or conflicting `mode`, bad values for optional palette keys, missing/heavy/oddly named backgrounds, files in `backgrounds/` subfolders (ignored by Omarchy), no README/LICENSE, no `omarchy-theme` topic, non-conventional repo name, scripts or binaries in the repo, unknown `icons.theme`.

The rules live in `packages/validator/src/validate.ts`; the constants mirrored from `omacom/omarchy` live in `packages/schema/src/constants.ts`.

## The catalog

Published under `/v1/` on the CDN:

| File                     | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `catalog.json`           | Full catalog (`packages/schema` → `Catalog`)                        |
| `catalog.min.json`       | Slug, name, mode, hue, thumb, accent, install command — for the CLI |
| `catalog.json.sha256`    | Integrity                                                           |
| `themes/<slug>.json`     | One entry                                                           |
| `previews/<slug>/<sha>/` | `1200.webp`, `480.webp` — immutable per validated commit            |
| `report.json`            | Build outcome per theme (for maintainers)                           |

Each catalog entry carries the `commit` that passed validation. The build prefers the latest git tag when a repo has one, otherwise the default branch HEAD. A theme that starts failing validation keeps its last-good entry; a repo that is missing three refreshes in a row is dropped until it returns (`state/liveness.json`).

## Working locally

```sh
pnpm install
pnpm test                                    # validator unit tests
GITHUB_TOKEN=$(gh auth token) pnpm validate https://github.com/owner/omarchy-x-theme
GITHUB_TOKEN=$(gh auth token) pnpm build     # full catalog → dist/v1 (clones every repo; cached in .work/)
node scripts/upload.ts --dry-run             # what would go to R2
```

`scripts/import-existing.ts` was used once to seed the registry from `omacom/omarchy-site`.

## Automation

- **`validate-pr.yml`** — on PRs touching `themes/` or `overrides/`: validates changed entries and comments the report.
- **`build.yml`** — on push to `master` and every 6 hours: rebuilds the catalog, uploads changed objects to R2, commits `state/liveness.json`.
- **`ci.yml`** — lint, type-check, tests for code changes.

Required repository configuration: variables `CDN_BASE_URL`, `R2_BUCKET`; secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Without `R2_BUCKET` the build still runs and attaches the catalog as a workflow artifact.
