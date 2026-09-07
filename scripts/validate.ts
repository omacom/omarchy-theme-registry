/**
 * Validate one or more themes exactly the way the catalog build does.
 *
 *   node scripts/validate.ts https://github.com/owner/omarchy-x-theme   # any repo, listed or not
 *   node scripts/validate.ts x                                            # a registry slug
 *   node scripts/validate.ts --changed                                    # entries changed vs origin/master (CI)
 *   node scripts/validate.ts --json                                       # machine-readable output
 *
 * Exit code 1 if any theme has errors.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import {
	GithubClient,
	canonicalRepoUrl,
	cloneRepo,
	deriveSlug,
	reportToMarkdown,
	validateTheme
} from '@omarchy-themes/validator';
import type { ValidationReport } from '@omarchy-themes/schema';
import { githubToken, loadRegistry, log, probeImage } from './lib.ts';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const json = args.includes('--json');
const targets = args.filter((a) => !a.startsWith('--'));

const registry = await loadRegistry();
const bySlug = new Map(registry.map((e) => [e.slug, e]));

const repos: { repo: string; slug: string | null }[] = [];
if (args.includes('--changed')) {
	const { stdout } = await exec('git', [
		'diff',
		'--name-only',
		'--diff-filter=AM',
		'origin/master...HEAD',
		'--',
		'themes/'
	]);
	for (const f of stdout.split('\n').filter(Boolean)) {
		const slug = basename(f, '.json');
		const e = bySlug.get(slug);
		if (e) repos.push({ repo: e.repo, slug });
	}
} else {
	for (const t of targets) {
		const e = bySlug.get(t);
		if (e) repos.push({ repo: e.repo, slug: e.slug });
		else {
			const canon = canonicalRepoUrl(t);
			if (!canon) throw new Error(`Not a slug or GitHub URL: ${t}`);
			const slug = deriveSlug(canon);
			repos.push({ repo: canon, slug: bySlug.has(slug) ? slug : null });
		}
	}
}
if (!repos.length) {
	log('Nothing to validate.');
	process.exit(0);
}

const gh = new GithubClient({ token: githubToken() });
const results: { repo: string; report: ValidationReport }[] = [];

for (const { repo, slug } of repos) {
	const meta = await gh.repo(repo);
	let report: ValidationReport;
	if (meta.missing) {
		report = await validateTheme({ dir: process.cwd(), repoUrl: repo, meta, probeImage });
		report.errors = report.errors.filter((e) => e.code === 'REPO_MISSING');
		report.warnings = [];
		report.ok = false;
	} else {
		const co = await cloneRepo(repo);
		try {
			report = await validateTheme({
				dir: co.dir,
				repoUrl: repo,
				meta,
				takenSlugs: registry.filter((e) => e.slug !== slug).map((e) => e.slug),
				probeImage
			});
		} finally {
			await co.cleanup();
		}
	}
	results.push({ repo, report });
	if (!json) console.log(reportToMarkdown(report, repo) + '\n');
}

if (json) console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.report.ok) ? 0 : 1);
