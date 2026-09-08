/**
 * Build the public catalog from the registry.
 *
 *   node scripts/build-catalog.ts                # full build → dist/v1/
 *   node scripts/build-catalog.ts --only x,y     # subset (debugging)
 *   node scripts/build-catalog.ts --no-clone     # reuse .work/cache only (offline sanity check)
 *
 * For every registry entry: fetch GitHub metadata → pick the commit to validate (latest tag, else
 * default-branch HEAD) → clone at that commit (skipped when the cache already has that SHA) →
 * validate → render previews → emit a CatalogTheme. Themes with blocking errors keep their
 * last-good catalog entry if one exists in the cache; otherwise they are left out and listed in
 * dist/v1/report.json for maintainers.
 *
 * Liveness: a repo that is missing on GitHub gets a strike in state/liveness.json; after 3 strikes it
 * is dropped from the catalog until it comes back. The workflow commits state/ after each run.
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
import { GithubClient, cloneRepo, validateTheme, type RepoMeta } from '@omarchy-themes/validator';
import {
	CDN_BASE_URL,
	DIST_DIR,
	STATE_DIR,
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
const STRIKES_TO_DROP = 3;

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
	/** last catalog entry we published for this slug (for last-good fallback) */
	lastGood?: CatalogThemeT;
}
interface Liveness {
	strikes: Record<string, { count: number; since: string; last: string }>;
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
const liveness = await readJsonOr<Liveness>(join(STATE_DIR, 'liveness.json'), { strikes: {} });
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
	| { slug: string; status: 'missing'; strikes: number };

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

	let meta: RepoMeta;
	try {
		meta = await gh.repo(entry.repo);
	} catch (e) {
		log(`  ${slug}: GitHub error ${(e as Error).message}`);
		if (cached?.lastGood)
			return { slug, status: 'last-good', theme: cached.lastGood, errors: [String(e)] };
		return { slug, status: 'excluded', reason: 'github-error', errors: [String(e)] };
	}

	if (meta.missing) {
		const s = liveness.strikes[slug] ?? { count: 0, since: now, last: now };
		// Stop touching the record once the theme is dropped, so state/ only changes when
		// something actually changes (otherwise the bot would commit every scheduled run).
		if (s.count < STRIKES_TO_DROP) {
			s.count += 1;
			s.last = now;
		}
		liveness.strikes[slug] = s;
		if (s.count < STRIKES_TO_DROP && cached?.lastGood)
			return {
				slug,
				status: 'last-good',
				theme: cached.lastGood,
				errors: [`repo missing (strike ${s.count})`]
			};
		return { slug, status: 'missing', strikes: s.count };
	}
	delete liveness.strikes[slug];

	// pick the commit: latest tag if any, else HEAD of default branch
	const tag = await gh.latestTag(meta.htmlUrl);
	const sha = tag ? tag.sha : await gh.headSha(meta.htmlUrl, meta.defaultBranch);
	if (!sha) {
		if (cached?.lastGood)
			return {
				slug,
				status: 'last-good',
				theme: cached.lastGood,
				errors: ['could not resolve HEAD']
			};
		return { slug, status: 'excluded', reason: 'no-commit', errors: ['could not resolve HEAD'] };
	}

	let record: CacheRecord;
	const takenSlugs = allSlugs.filter((s) => s !== slug);
	if (
		cached &&
		cached.sha === sha &&
		cached.preview &&
		(await exists(join(PREVIEW_CACHE, slug, sha, '1200.webp')))
	) {
		record = cached;
		// re-run the repo-level checks that depend on live metadata without re-cloning
		record.report.errors = record.report.errors.filter((e) => !e.code.startsWith('REPO_'));
		record.report.warnings = record.report.warnings.filter((w) => !w.code.startsWith('REPO_'));
		if (meta.isPrivate)
			record.report.errors.push({ code: 'REPO_PRIVATE', message: 'Repository is private.' });
		if (meta.isArchived)
			record.report.warnings.push({
				code: 'REPO_ARCHIVED',
				message: 'Repository is archived; it still installs, but nobody maintains it.'
			});
		record.report.ok = record.report.errors.length === 0;
	} else if (noClone) {
		if (cached?.lastGood)
			return { slug, status: 'last-good', theme: cached.lastGood, errors: ['--no-clone'] };
		return { slug, status: 'excluded', reason: 'no-clone', errors: [] };
	} else {
		log(`  clone ${slug} @ ${sha.slice(0, 7)}`);
		const co = await cloneRepo(meta.htmlUrl, { sha });
		try {
			const report = await validateTheme({
				dir: co.dir,
				repoUrl: entry.repo,
				meta,
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
		await writeJson(cachePath, record);
		const errors = blocking.map((e) => `${e.code}${e.path ? ` ${e.path}` : ''}: ${e.message}`);
		if (record.lastGood) return { slug, status: 'last-good', theme: record.lastGood, errors };
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
		tags: entry.tags ?? [],
		featured: overrides.featured.includes(slug),
		warnings: report.warnings.map((w) => w.code),
		install: `omarchy theme install ${entry.repo}`
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
if (!only) await writeJson(join(STATE_DIR, 'liveness.json'), liveness);

log(`\nCatalog: ${themes.length} themes → ${OUT}`);
log(
	`  ok ${report.counts.ok} · last-good ${report.counts['last-good']} · excluded ${report.counts.excluded} · hidden ${report.counts.hidden} · missing ${report.counts.missing}`
);
for (const p of report.problems) {
	const detail =
		'errors' in p ? p.errors.slice(0, 3).join(' | ') : 'strikes' in p ? `strikes ${p.strikes}` : '';
	log(`  - ${p.slug} [${p.status}] ${detail}`);
}
