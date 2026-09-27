/**
 * One-time import of the community theme list from omacom/omarchy-site.
 *
 *   node scripts/import-existing.ts            # writes themes/*.json
 *   node scripts/import-existing.ts --dry-run
 *
 * Existing registry entries are never overwritten; the script only adds missing ones, pinned to
 * their GitHub `repo_id`, and reports anything it could not map (slug collisions, non-GitHub repos,
 * unusable slugs, repos GitHub cannot find).
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { RegistryEntry } from '@omarchy-themes/schema';
import { GithubClient, canonicalRepoUrl, deriveSlug, isValidSlug } from '@omarchy-themes/validator';
import { THEMES_DIR, githubToken, log, today, writeJson } from './lib.ts';

const SOURCE = 'https://raw.githubusercontent.com/omacom/omarchy-site/master/src/data/themes.json';

const dryRun = process.argv.includes('--dry-run');

interface SiteTheme {
	repo: string;
	image: string;
	name: string;
}

async function exists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Fetch ${SOURCE}: ${res.status}`);
const site = (await res.json()) as SiteTheme[];
log(`Fetched ${site.length} entries from omarchy-site`);

const seen = new Map<string, SiteTheme>();
const skipped: string[] = [];
const planned: { slug: string; repo: string; name: string }[] = [];

for (const t of site) {
	const repo = canonicalRepoUrl(t.repo);
	if (!repo) {
		skipped.push(`${t.name}: not a GitHub repo (${t.repo})`);
		continue;
	}
	const slug = deriveSlug(repo);
	if (!isValidSlug(slug)) {
		skipped.push(`${t.name}: repo name gives unusable slug "${slug}"`);
		continue;
	}
	const prior = seen.get(slug);
	if (prior) {
		skipped.push(
			`${t.name}: slug "${slug}" collides with "${prior.name}" (${prior.repo}); first claim kept`
		);
		continue;
	}
	seen.set(slug, t);
	planned.push({ slug, repo, name: t.name.trim() });
}

const gh = new GithubClient({ token: githubToken() });
let added = 0;
let kept = 0;

for (const { slug, repo, name } of planned) {
	const target = join(THEMES_DIR, `${slug}.json`);
	if (await exists(target)) {
		kept++;
		continue;
	}
	// Pin the entry to the repository as it exists now, the same as a submission does.
	const meta = await gh.repo(repo);
	if (meta.missing) {
		skipped.push(`${name}: GitHub cannot find ${repo}, so it cannot be pinned`);
		continue;
	}
	const entry = RegistryEntry.parse({
		slug,
		repo,
		repo_id: meta.id,
		name,
		submitted_by: 'import',
		added_at: today()
	});
	if (dryRun) log(`+ ${entry.slug}  ${entry.repo}`);
	else await writeJson(target, entry);
	added++;
}

log(`\nAdded ${added}, kept ${kept} existing, skipped ${skipped.length}`);
for (const s of skipped) log(`  - ${s}`);
