# Omarchy Theme Registry

Source of truth for the community themes listed on **themes.omarchy.org**. One small JSON file per theme goes in (`themes/<slug>.json`), a validated catalog and processed preview images come out and are uploaded to Cloudflare R2. The website (`../omarchy-marketplace-site`, Rails) and later the Omarchy CLI only ever read the published catalog; nothing here talks to the site's database.

## Working rules

- **Never `git commit` or `git push`.** Leave changes in the working tree and report them; the user reviews and commits. Applies to every repo in this project.
- Branch is `master` (no `main`). Workflows and `validate.ts --changed` diff against `origin/master`.
- **`preview.png` at the repo root is mandatory** (`PREVIEW_MISSING` is an error). Omarchy's theme switcher shows that exact file, so the site must too; never add fallbacks to wallpapers or other images.
- Never write the R2 dev URL (`pub-*.r2.dev`) into README, examples, docs or code. It lives only in the gitignored `.env` and the GitHub environment `R2-dev` (`CDN_BASE_URL`, `R2_BUCKET`, `R2_*` secrets).
- TypeScript is pinned to 6.x because typescript-eslint does not support 7 yet; do not bump it.
- Mirror Omarchy, don't reinvent: slug derivation, denied-on-install files, the files a marketplace install checks out (`INSTALLED_THEME_FILES`, mirroring the sparse-checkout patterns in `omarchy-theme-install`), background extensions and palette keys are copied from `omacom/omarchy` into `packages/schema/src/constants.ts`. Change behaviour there, with a test.
- A theme may ship anything it likes in its repository; Omarchy's sparse checkout decides what a marketplace install puts on disk, and `facts.installed_files` only reports it. Do not add denylist-style errors for scripts or other non-theme content.
- If files change on disk from outside the session, say so and wait for instructions rather than fixing them.

## Layout

- `packages/schema` — Zod schemas and constants: `RegistryEntry`, `Overrides`, `CatalogTheme`/`Catalog`, `ValidationReport`, `INSTALLED_THEME_FILES`, `TAG_DENYLIST`/`TAG_DENY_PATTERN`, size limits, built-in theme names.
- `packages/validator` — `validateTheme` (errors block, warnings publish; `facts.installed_files` is what a marketplace install checks out), `installedFiles`, `deriveSlug`/`canonicalRepoUrl`, palette parsing and hue bucketing, repo inspection, `GithubClient` (retries, `controlsRepo` for ownership), `cloneRepo`, `parseIssueForm`, `deriveTags` (catalog tags from GitHub topics minus boilerplate), `reportToMarkdown`. Tests in `packages/validator/test` (vitest).
- `scripts/` — `validate.ts` (a URL, a slug, or `--changed`), `submit.ts` (issue form or flags → validated entry, `--write --json`), `build-catalog.ts` (clones every repo at default-branch HEAD, validates, renders WebP previews, writes `dist/v1/…`, keeps last-good entries, liveness strikes), `upload.ts` (R2 via S3 API, immutable preview keys), `lib.ts` (paths, `CDN_BASE_URL`, registry/overrides loaders).
- `themes/*.json` entries; `overrides/featured.json` + `hidden.json` (curator-only, see `overrides/README.md`); `state/liveness.json` (bot-committed strike counts, see `state/README.md`).
- Published catalog: `/v1/catalog.json`, `catalog.min.json`, `catalog.json.sha256`, `themes/<slug>.json`, `previews/<slug>/<sha>/{1200,480}.webp`, `report.json`.

## Automation (`.github/workflows`)

- `submit.yml` — issues from the "Submit a theme" form (label `submission`) and `/recheck` comments: validate, comment the report, on green write the entry and open/refresh a `submit/<slug>` PR (`auto-approve` when the submitter owns the repo; the PR body links the theme repo). The PR runs no checks by design — `submit.ts` has already validated the theme and the branch is only pushed on green. Uses `SUBMIT_TOKEN` if set, otherwise `GITHUB_TOKEN`.
- `published.yml` — when a `submit/<slug>` PR merges: notify and close the issue, label `published`, delete the branch.
- `validate-pr.yml` — PRs touching `overrides/` only. It deliberately does **not** watch `themes/`: `submit.yml` has already validated the entry before the `submit/<slug>` PR exists, and a second run only added a held `action_required` check for a maintainer to click.
- `build.yml` — on push to master (code/`overrides/` only — **not** `themes/`, so merging a queue of submissions does not rebuild once per merge), every 6 h, and on dispatch: build, upload to R2, commit `state/`. A merged theme therefore goes live at the next scheduled build; user-facing copy must say so rather than promising it immediately.
- `ci.yml` — lint, type-check, tests.

The `submission` label must exist before the first issue arrives (the workflow creates the others).

## Commands

`just` lists everything; `just ci` = lint + type-check + tests (same as `ci.yml`). `just validate <url|slug>`, `just submit <repo> <login>`, `just build`, `just upload-dry`. The justfile loads `.env` and takes `GITHUB_TOKEN` from `gh auth token` when unset. Node 24 runs `.ts` directly; pnpm 12 workspace; `pnpm format` before checking lint.

A full build clones every repo (cached in `.work/`) and takes minutes; use `validate`/`submit` for single repos.
