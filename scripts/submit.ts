/**
 * Turn a submission (issue form or flags) into a validated `themes/<slug>.json`.
 *
 *   node scripts/submit.ts --repo https://github.com/o/omarchy-x-theme --name "X" --submitted-by login
 *   node scripts/submit.ts --issue-body-file body.md --submitted-by login --write --json
 *
 * Prints a JSON result (with --json) or the Markdown report. Never exits non-zero for a bad
 * submission — the result's `ok` says whether an entry was produced — only for crashes.
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
	GithubClient,
	canonicalRepoUrl,
	cloneRepo,
	deriveSlug,
	parseIssueForm,
	reportToMarkdown,
	validateTheme
} from '@omarchy-themes/validator';
import { RegistryEntry, type Finding, type ValidationReport } from '@omarchy-themes/schema';
import { THEMES_DIR, githubToken, loadRegistry, probeImage, writeJson } from './lib.ts';

const { values: args } = parseArgs({
	options: {
		repo: { type: 'string' },
		name: { type: 'string' },
		'submitted-by': { type: 'string' },
		'issue-body-file': { type: 'string' },
		write: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false }
	}
});

interface Result {
	ok: boolean;
	slug: string | null;
	name: string | null;
	repo: string | null;
	submitted_by: string;
	/** submitter owns the repo (user) or is a public member of the owning org */
	owner_verified: boolean;
	/** set when this repo is already in the registry */
	existing_slug: string | null;
	entry: RegistryEntry | null;
	/** path written (with --write) */
	file: string | null;
	errors: Finding[];
	report: ValidationReport | null;
	markdown: string;
}

const submittedBy = args['submitted-by'];
if (!submittedBy) throw new Error('--submitted-by is required');

let repoInput = args.repo ?? null;
let name = args.name ?? null;
if (args['issue-body-file']) {
	const form = parseIssueForm(await readFile(args['issue-body-file'], 'utf8'));
	repoInput ??= form.repo;
	name ??= form.name;
}

const result: Result = {
	ok: false,
	slug: null,
	name,
	repo: null,
	submitted_by: submittedBy,
	owner_verified: false,
	existing_slug: null,
	entry: null,
	file: null,
	errors: [],
	report: null,
	markdown: ''
};

const fail = (code: string, message: string) => result.errors.push({ code, message });

const canon = repoInput ? canonicalRepoUrl(repoInput) : null;
if (!repoInput) fail('NO_REPO', 'No repository URL found in the submission.');
else if (!canon)
	fail(
		'REPO_NOT_GITHUB',
		`\`${repoInput}\` is not a GitHub repository URL (https://github.com/<owner>/<repo>).`
	);

const registry = await loadRegistry();

if (canon) {
	result.repo = canon;
	const gh = new GithubClient({ token: githubToken() });
	const meta = await gh.repo(canon);
	if (!meta.missing && meta.movedTo) result.repo = meta.movedTo;

	const listed = registry.find((e) => e.repo.toLowerCase() === result.repo!.toLowerCase());
	if (listed) {
		result.existing_slug = listed.slug;
		fail(
			'ALREADY_LISTED',
			`This repository is already in the registry as \`${listed.slug}\`. The catalog follows its default branch, so updates need no new submission.`
		);
	} else if (meta.missing) {
		fail('REPO_MISSING', 'Repository does not exist or is not public.');
	} else {
		const co = await cloneRepo(result.repo);
		try {
			result.report = await validateTheme({
				dir: co.dir,
				repoUrl: result.repo,
				meta,
				takenSlugs: registry.map((e) => e.slug),
				probeImage
			});
		} finally {
			await co.cleanup();
		}
		result.owner_verified = await gh.controlsRepo(submittedBy, meta);
		result.slug = result.report.facts.slug ?? deriveSlug(result.repo);
		result.name ??= titleCase(result.slug);

		if (result.report.ok) {
			const parsed = RegistryEntry.safeParse({
				slug: result.slug,
				repo: result.repo,
				name: result.name,
				submitted_by: submittedBy,
				added_at: new Date().toISOString().slice(0, 10)
			});
			if (parsed.success) {
				result.entry = parsed.data;
				result.ok = true;
				if (args.write) {
					result.file = join(THEMES_DIR, `${result.slug}.json`);
					await writeJson(result.file, result.entry);
				}
			} else {
				for (const i of parsed.error.issues)
					fail('ENTRY_INVALID', `${i.path.join('.') || 'entry'}: ${i.message}`);
			}
		}
	}
}

result.markdown = toMarkdown(result);
if (args.json) console.log(JSON.stringify(result, null, 2));
else console.log(result.markdown);

function titleCase(slug: string): string {
	return slug
		.split(/[-_.]+/)
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join(' ');
}

function toMarkdown(r: Result): string {
	const lines: string[] = [];
	if (r.report) {
		lines.push(reportToMarkdown(r.report, `Submission of \`${r.slug}\``));
	} else {
		lines.push(`### Submission: ❌ needs changes`);
	}
	if (r.errors.length) {
		lines.push('', '**Errors (must fix):**');
		for (const f of r.errors) lines.push(`- \`${f.code}\` — ${f.message}`);
	}
	lines.push('');
	if (r.ok) {
		lines.push(
			r.owner_verified
				? `Submitted by the repository owner — this will be published once a maintainer merges the pull request.`
				: `The submitter does not appear to own \`${r.repo}\` (or is a private org member), so a maintainer will confirm the listing before merging.`
		);
	} else {
		lines.push(
			'Fix the errors in the theme repository, then comment `/recheck` on this issue to run validation again.'
		);
	}
	return lines.join('\n');
}
