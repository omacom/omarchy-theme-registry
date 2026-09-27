/**
 * Build the public catalog from the registry.
 *
 *   node scripts/build-catalog.ts                # full build → dist/v1/
 *   node scripts/build-catalog.ts --only x,y     # subset (debugging)
 *   node scripts/build-catalog.ts --no-clone     # reuse .work/cache only (offline sanity check)
 *
 * For every registry entry: fetch GitHub metadata → resolve the default branch HEAD (what
 * `omarchy theme install` clones) → clone at that commit (skipped when the cache already has that SHA) →
 * validate → render previews → emit a CatalogTheme.
 *
 * A theme whose repo is at fault (missing, private, failing validation, no renderable preview)
 * is dropped from this build and listed in dist/v1/report.json. Its themes/<slug>.json entry
 * stays, so it comes back on the first build it passes. Only a failure on the build's side
 * (GitHub API error, clone failure) keeps the entry this build last published, so an outage
 * cannot empty the catalog.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
	Catalog,
	CatalogMin,
	CatalogTheme,
	CATALOG_SCHEMA_VERSION,
	OMARCHY_MIN_VERSION,
	type CatalogMinTheme,
	type CatalogTheme as CatalogThemeT,
	type RegistryEntry,
	type ValidationReport
} from '@omarchy-themes/schema';
import {
	GithubClient,
	cloneRepo,
	validateTheme,
	repoFindings,
	REPO_META_CODES,
	type RepoMeta,
	deriveTags
} from '@omarchy-themes/validator';
import {
	CDN_BASE_URL,
	DIST_DIR,
	WORK_DIR,
	githubToken,
	loadOverrides,
	loadRegistry,
	log,
	mapLimit,
	probeImage,
	processPreview,
	readJsonOr,
	writeJson
} from './lib.ts';

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null;
const noClone = args.includes('--no-clone');
const CONCURRENCY = Number(process.env.BUILD_CONCURRENCY ?? 6);

const CACHE_DIR = join(WORK_DIR, 'cache');
const PREVIEW_CACHE = join(WORK_DIR, 'previews');
const OUT = join(DIST_DIR, 'v1');

interface CacheRecord {
	sha: string;
	report: ValidationReport;
	preview: {
		sha: string;
		width: number;
		height: number;
		placeholder: string;
	} | null;
	/** last catalog entry published for this slug; only used when the build cannot reach the repo */
	lastGood?: CatalogThemeT;
}

async function exists(p: string) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

const registry = await loadRegistry();
const overrides = await loadOverrides();
const gh = new GithubClient({ token: githubToken() });
const now = new Date().toISOString();

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(PREVIEW_CACHE, { recursive: true });
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'previews'), { recursive: true });
await mkdir(join(OUT, 'themes'), { recursive: true });

type Outcome =
	| { slug: string; status: 'ok'; theme: CatalogThemeT; warnings: number }
	| { slug: string; status: 'last-good'; theme: CatalogThemeT; errors: string[] }
	| { slug: string; status: 'excluded'; reason: string; errors: string[] }
	| { slug: string; status: 'hidden'; reason: string }
	| { slug: string; status: 'missing' };

const entries = registry.filter((e) => !only || only.has(e.slug));
const allSlugs = registry.map((e) => e.slug);

async function previewUrls(slug: string, sha: string) {
	return {
		src: `${CDN_BASE_URL}/v1/previews/${slug}/${sha}/1200.webp`,
		thumb: `${CDN_BASE_URL}/v1/previews/${slug}/${sha}/480.webp`
	};
}

async function renderPreview(
	slug: string,
	sha: string,
	previewAbs: string | null
): Promise<CacheRecord['preview']> {
	if (!previewAbs) return null;
	try {
		const p = await processPreview(previewAbs);
		const dir = join(PREVIEW_CACHE, slug, sha);
		await mkdir(dir, { recursive: true });
		for (const f of p.files) await writeFile(join(dir, f.name), f.buffer);
		return { sha, width: p.width, height: p.height, placeholder: p.placeholder };
	} catch (e) {
		log(`  preview failed for ${slug}: ${(e as Error).message}`);
		return null;
	}
}

async function buildOne(entry: RegistryEntry): Promise<Outcome> {
	const { slug } = entry;
	const hiddenReason = overrides.hidden[slug];
	if (hiddenReason) return { slug, status: 'hidden', reason: hiddenReason };

	const cachePath = join(CACHE_DIR, `${slug}.json`);
	const cached = await readJsonOr<CacheRecord | null>(cachePath, null);

	// The build could not look at the repo, so this says nothing about the theme: keep what was
	// last published rather than let a GitHub outage empty the catalog.
	// An entry cached before a schema change no longer parses; it is skipped, not published.
	const unreachable = (reason: string): Outcome => {
		log(`  ${slug}: ${reason}`);
		const lastGood = CatalogTheme.safeParse(cached?.lastGood);
		return lastGood.success
			? { slug, status: 'last-good', theme: lastGood.data, errors: [reason] }
			: { slug, status: 'excluded', reason: 'unreachable', errors: [reason] };
	};

	let meta: RepoMeta;
	try {
		meta = await gh.repo(entry.repo);
	} catch (e) {
		return unreachable(`GitHub error: ${(e as Error).message}`);
	}

	if (meta.missing) {
		// Forget the last published entry, so a later outage cannot bring the theme back.
		if (cached?.lastGood) {
			delete cached.lastGood;
			await writeJson(cachePath, cached);
		}
		return { slug, status: 'missing' };
	}

	// Validate exactly what `omarchy theme install` clones: HEAD of the default branch.
	// (Tags are ignored on purpose — they are rarely maintained and would pin stale previews.)
	const sha = await gh.headSha(meta.htmlUrl, meta.defaultBranch);
	if (!sha) return unreachable('could not resolve HEAD');

	let record: CacheRecord;
	const takenSlugs = allSlugs.filter((s) => s !== slug);
	// A record written before `installed_files` existed has to be rebuilt from a fresh clone.
	const cachedFacts = cached?.report.facts as Partial<ValidationReport['facts']> | undefined;
	if (
		cached &&
		cached.sha === sha &&
		cached.preview &&
		cachedFacts?.installed_files &&
		(await exists(join(PREVIEW_CACHE, slug, sha, '1200.webp')))
	) {
		record = cached;
		// re-run the repo-level checks that depend on live metadata without re-cloning
		const repo = repoFindings(meta, entry.repo_id ?? null);
		record.report.errors = [
			...record.report.errors.filter((e) => !REPO_META_CODES.has(e.code)),
			...repo.errors
		];
		record.report.warnings = [
			...record.report.warnings.filter((w) => !REPO_META_CODES.has(w.code)),
			...repo.warnings
		];
		record.report.ok = record.report.errors.length === 0;
	} else if (noClone) {
		return unreachable('--no-clone');
	} else {
		log(`  clone ${slug} @ ${sha.slice(0, 7)}`);
		let co: Awaited<ReturnType<typeof cloneRepo>>;
		try {
			co = await cloneRepo(meta.htmlUrl, { sha });
		} catch (e) {
			return unreachable(`clone failed: ${(e as Error).message}`);
		}
		try {
			const report = await validateTheme({
				dir: co.dir,
				repoUrl: entry.repo,
				meta,
				expectedRepoId: entry.repo_id ?? null,
				takenSlugs,
				probeImage
			});
			const previewAbs =
				report.facts.preview_path &&
				!report.errors.some((e) => e.path === report.facts.preview_path)
					? join(co.dir, report.facts.preview_path)
					: null;
			const preview = await renderPreview(slug, sha, previewAbs);
			record = { sha, report, preview, ...(cached?.lastGood ? { lastGood: cached.lastGood } : {}) };
		} finally {
			await co.cleanup();
		}
	}

	const { report } = record;
	const f = report.facts;
	const blocking = [...report.errors];
	if (!record.preview)
		blocking.push({ code: 'PREVIEW_UNRENDERABLE', message: 'No preview could be rendered.' });

	if (blocking.length || !f.mode || !f.hue || !f.colors || !f.generation) {
		// The repo is at fault: drop it from this build and forget the last published entry.
		// The registry entry stays, so the theme returns on the first build it passes.
		delete record.lastGood;
		await writeJson(cachePath, record);
		const errors = blocking.map((e) => `${e.code}${e.path ? ` ${e.path}` : ''}: ${e.message}`);
		return { slug, status: 'excluded', reason: 'validation', errors };
	}

	const urls = await previewUrls(slug, sha);
	const theme = CatalogTheme.parse({
		slug,
		name: entry.name,
		repo: entry.repo,
		author: { login: meta.owner, url: `https://github.com/${meta.owner}` },
		description: meta.description,
		license: meta.license,
		mode: f.mode,
		hue: f.hue,
		colors: f.colors,
		generation: f.generation,
		ignored_on_install: f.ignored_on_install,
		installed_files: f.installed_files,
		backgrounds: f.backgrounds,
		preview: {
			...urls,
			width: record.preview!.width,
			height: record.preview!.height,
			placeholder: record.preview!.placeholder
		},
		commit: sha,
		pushed_at: meta.pushedAt,
		stars: meta.stars,
		added_at: entry.added_at,
		tags: deriveTags({ topics: meta.topics, entryTags: entry.tags, slug }),
		featured: overrides.featured.includes(slug),
		// Repository hygiene (topic, license, name, archived…) is for the artist's submission report.
		// A marketplace install only checks out theme files, so it says nothing to someone installing.
		warnings: report.warnings.filter((w) => !w.code.startsWith('REPO_')).map((w) => w.code),
		install: `omarchy theme install ${slug}`
	} satisfies CatalogThemeT);

	record.lastGood = theme;
	await writeJson(cachePath, record);
	// copy rendered previews into dist
	await cp(join(PREVIEW_CACHE, slug, sha), join(OUT, 'previews', slug, sha), { recursive: true });
	return { slug, status: 'ok', theme, warnings: report.warnings.length };
}

log(`Building catalog for ${entries.length} themes (concurrency ${CONCURRENCY})`);
const outcomes = await mapLimit(entries, CONCURRENCY, async (e) => {
	try {
		return await buildOne(e);
	} catch (err) {
		log(`  ${e.slug}: unexpected ${(err as Error).stack ?? err}`);
		return {
			slug: e.slug,
			status: 'excluded',
			reason: 'exception',
			errors: [String(err)]
		} as Outcome;
	}
});

const themes = outcomes
	.flatMap((o) => (o.status === 'ok' || o.status === 'last-good' ? [o.theme] : []))
	.sort((a, b) => a.name.localeCompare(b.name, 'en'));

const catalog = Catalog.parse({
	schema_version: CATALOG_SCHEMA_VERSION,
	generated_at: now,
	omarchy_min: OMARCHY_MIN_VERSION,
	themes
});
const min = CatalogMin.parse({
	schema_version: CATALOG_SCHEMA_VERSION,
	generated_at: now,
	themes: themes.map((t): CatalogMinTheme => ({
		slug: t.slug,
		name: t.name,
		repo: t.repo,
		author: t.author.login,
		mode: t.mode,
		hue: t.hue,
		commit: t.commit,
		featured: t.featured,
		install: t.install,
		thumb: t.preview.thumb,
		accent: t.colors.accent!,
		background: t.colors.background!
	}))
});

const catalogJson = JSON.stringify(catalog);
await writeFile(join(OUT, 'catalog.json'), catalogJson);
await writeFile(
	join(OUT, 'catalog.json.sha256'),
	createHash('sha256').update(catalogJson).digest('hex') + '\n'
);
await writeFile(join(OUT, 'catalog.min.json'), JSON.stringify(min));
for (const t of themes) await writeJson(join(OUT, 'themes', `${t.slug}.json`), t, false);

const report = {
	generated_at: now,
	counts: Object.fromEntries(
		(['ok', 'last-good', 'excluded', 'hidden', 'missing'] as const).map((s) => [
			s,
			outcomes.filter((o) => o.status === s).length
		])
	),
	problems: outcomes.filter((o) => o.status !== 'ok' && o.status !== 'hidden'),
	warnings: Object.fromEntries(
		outcomes.flatMap((o) => (o.status === 'ok' && o.warnings ? [[o.slug, o.theme.warnings]] : []))
	)
};
await writeJson(join(OUT, 'report.json'), report);

log(`\nCatalog: ${themes.length} themes → ${OUT}`);
log(
	`  ok ${report.counts.ok} · last-good ${report.counts['last-good']} · excluded ${report.counts.excluded} · hidden ${report.counts.hidden} · missing ${report.counts.missing}`
);
for (const p of report.problems) {
	const detail = 'errors' in p ? p.errors.slice(0, 3).join(' | ') : 'reason' in p ? p.reason : '';
	log(`  - ${p.slug} [${p.status}] ${detail}`);
}
