# state/

Machine-maintained state that has to survive between catalog builds. Committed by the build workflow (`omarchy-themes-bot`, message `chore: update liveness state [skip ci]`); do not edit by hand unless you are deliberately resetting something.

## `liveness.json`

Tracks registry entries whose GitHub repository is currently **missing** (404/451 — deleted, made private, or renamed without a redirect). One record per slug:

```json
{
	"strikes": {
		"gruvu": { "count": 3, "since": "2026-09-08T04:19:27.323Z", "last": "2026-09-08T16:23:11.006Z" }
	}
}
```

- `count` — consecutive builds in which the repo was missing.
- `since` — when the first strike was recorded.
- `last` — when the count last changed.

How the build uses it:

1. A repo that is missing gets one strike per build (builds run on push and every 6 hours).
2. While `count` is below 3, the theme keeps its last-good catalog entry, so a brief outage or an accidental private flip does not remove it from the site.
3. At 3 strikes the theme is dropped from the catalog. Its `themes/<slug>.json` entry stays, so the slug remains claimed, and `dist/v1/report.json` lists it under `missing`.
4. Once a repo is past 3 strikes its record is frozen (no more updates), so this file only changes when something actually changes.
5. If the repo comes back, the record is deleted on the next build and the theme is listed again automatically.

To force an immediate re-check after a repo is restored, nothing is needed — the next build handles it. To permanently remove a theme instead of waiting for strikes, delete its registry entry or add it to `overrides/hidden.json`.
