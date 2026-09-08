# Omarchy Theme Registry

The list of community themes behind [themes.omarchy.org](https://themes.omarchy.org). Every theme here is a public GitHub repository that `omarchy theme install` can clone; this repo only records which ones are listed, checks them automatically, and publishes the catalog that the website reads.

## Submit your theme

1. Make a theme. The [Omarchy manual](https://omarchy.org/manual/making-your-own-theme/) has the full guide; the short version is a public GitHub repo named `omarchy-<name>-theme` with `colors.toml`, a `backgrounds/` folder and a 16:9 `preview.png` at its root.
2. [**Submit a theme**](https://github.com/omacom/omarchy-theme-registry/issues/new?template=submit-theme.yml).
3. Within a few minutes a bot comments a validation report on the issue.
   - **Passed:** a pull request is opened for you and a maintainer merges it. Your theme is live shortly after, and the bot tells you on the issue.
   - **Needs changes:** fix what the report lists in your repo, then comment `/recheck` on the issue. No need to open a new one.

Once listed, the marketplace follows your repository's default branch: push changes and the listing updates on the next refresh (every six hours). Updates never need a new submission.

### What gets checked

The validator enforces what `omarchy theme install` enforces, plus a few things that make a good listing. Errors block; warnings are shown on your theme page as hints.

**Errors** — repository missing or private; theme not at the repo root; symlinks; no palette (`colors.toml`, or a legacy `alacritty.toml` to derive from) or one missing required keys; no `preview.png` at the root, or narrower than 1000 px; images over 50 MB / 40 MP; repository over 400 MB; a name that is invalid, reserved by a built-in theme, or already taken (first come, first served).

**Warnings** — archived repo; files Omarchy drops on install (`*.lua`, terminal configs, `vscode.json`); undeclared or conflicting `mode`; heavy or oddly named backgrounds, or backgrounds in other subfolders; no README or LICENSE; no `omarchy-theme` topic; unconventional repo name; scripts or binaries in the repo; unknown `icons.theme`.

### What shows up on the theme page

Everything comes from your repository, so keep it tidy there:

- **Name** from the issue form (defaults to the repo name), **author** from the GitHub owner.
- **Description** is the GitHub repository description.
- **Tags** are your repository's GitHub topics, minus boilerplate such as `omarchy-theme`, `hyprland` or `dark`. Add descriptive topics like `warm`, `neon`, `anime`, `minimal`.
- **Mode, colours and hue** from `colors.toml`; **license** and **stars** from GitHub; the **preview** is your `preview.png`, the same image Omarchy shows in its theme switcher.

## Browse and install

Browse at [themes.omarchy.org](https://themes.omarchy.org). Each theme page has the one-line install command:

```sh
omarchy theme install https://github.com/<owner>/omarchy-<name>-theme
```

Or in Omarchy: menu → Install → Style → Theme and paste the repository URL.

## Something wrong with a listed theme?

Problems with a theme itself (it does not install, colours are off) belong in that theme's own issue tracker; the theme page links to it. If a listing should be taken down, open an issue here and a maintainer will review it.

---

## For maintainers and developers

Read `CLAUDE.md` for the working conventions. The short version of everything else:

**Pipeline.** `themes/<slug>.json` (one file per theme, so submissions never conflict) → validator → `dist/v1/` catalog and WebP previews → Cloudflare R2 under `/v1/`. The catalog carries the default-branch commit that passed validation; a theme that starts failing keeps its last-good entry, and a repo missing three refreshes in a row is dropped until it returns (`state/liveness.json`).

**Entry format.** Only what cannot be read from the repo:

```json
// sunset-drive.json
{
	"slug": "sunset-drive",
	"repo": "https://github.com/tahayvr/omarchy-sunset-drive-theme",
	"name": "Sunset Drive",
	"submitted_by": "tahayvr",
	"added_at": "2026-09-07"
}
```

`slug` is what Omarchy derives from the repo name (`omarchy-` prefix and `-theme` suffix stripped, lowercased). An optional `tags` array adds curator tags ahead of the ones derived from topics.

**Curator overrides.** `overrides/featured.json` (array of slugs) and `overrides/hidden.json` (`{ "slug": "reason" }`, hides without giving up the slug). See `overrides/README.md`.

**Submission queue.** [Open PRs labelled `auto-approve`](https://github.com/omacom/omarchy-theme-registry/pulls?q=is%3Apr+is%3Aopen+label%3Aauto-approve) were submitted by the repo owner: read the report in the PR body, glance at the preview, merge. PRs labelled `submission` without `auto-approve` came from someone else; confirm the author is fine with it first. Never hand-edit a submission PR; comment `/recheck` on its issue to regenerate it. To reject, close the issue. The `submission` label must exist before the first issue arrives; the workflow creates the rest.

**Workflows.** `submit.yml` (issue → validate → PR, `/recheck`), `published.yml` (merged PR → notify and close the issue), `validate-pr.yml` (manual PRs to `themes/` or `overrides/`), `build.yml` (push to master, every 6 h, dispatch → build, upload, commit `state/`), `ci.yml` (lint, type-check, tests). Repository configuration: environment `R2-dev` with variables `CDN_BASE_URL`, `R2_BUCKET` and secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; without `R2_BUCKET` the build only attaches the catalog as an artifact. Optional `SUBMIT_TOKEN` secret so bot-opened PRs trigger checks.

**Published files** under `/v1/`: `catalog.json`, `catalog.min.json` (for the CLI), `catalog.json.sha256`, `themes/<slug>.json`, `previews/<slug>/<sha>/{1200,480}.webp` (immutable), `report.json`.

**Working locally.** Node 24, pnpm 12, `just`:

```sh
just install
just check                    # lint, type-check, tests
just validate <url|slug>      # one repo, same rules as the build
just submit <repo> <login>    # dry-run a submission (--write creates the entry)
just build                    # full catalog into dist/v1 (clones every repo; cached in .work/)
just upload-dry               # what would go to R2 (needs R2_* in .env)
```

Rules live in `packages/validator/src/validate.ts`; constants mirrored from `omacom/omarchy` in `packages/schema/src/constants.ts`. Change behaviour there, with a test.
