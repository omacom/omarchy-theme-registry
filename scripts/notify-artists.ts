/**
 * Tell artists when their listed theme is left out of the catalog, and when it is back.
 * Runs after the catalog build and upload; see `packages/validator/src/health.ts` for the rules.
 *
 *   node scripts/notify-artists.ts             # post
 *   node scripts/notify-artists.ts --dry-run   # print what it would post, change nothing
 *   node scripts/notify-artists.ts --max-new 5 # first notices per run (default 10)
 *
 * Env: GITHUB_TOKEN (issues: write), GITHUB_REPOSITORY (default omacom/omarchy-theme-registry).
 * Reads dist/report.json and dist/v1/catalog.json from the build.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	BROKEN_LABEL,
	canonicalRepoUrl,
	codesFromMarker,
	parseIssueForm,
	planHealth,
	repoOwnerAndName,
	type BrokenTheme,
	type HealthIssue
} from '@omarchy-themes/validator';
import { DIST_DIR, SITE_URL, githubToken, loadRegistry, log, readJson } from './lib.ts';

const { values: args } = parseArgs({
	options: {
		'dry-run': { type: 'boolean', default: false },
		'max-new': { type: 'string', default: '10' }
	}
});
const dryRun = args['dry-run'];
const REPO = process.env.GITHUB_REPOSITORY ?? 'omacom/omarchy-theme-registry';
const token = githubToken();
if (!token) throw new Error('GITHUB_TOKEN is required');

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'user-agent': 'omarchy-themes-registry',
			'x-github-api-version': '2022-11-28',
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
	if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
	return (res.status === 204 ? undefined : await res.json()) as T;
}

async function all<T>(path: string): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; ; page++) {
		const batch = await api<T[]>(
			'GET',
			`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
		);
		out.push(...batch);
		if (batch.length < 100) return out;
	}
}

interface Issue {
	number: number;
	body: string | null;
	labels: { name: string }[];
	pull_request?: unknown;
}

// ── what the build found ─────────────────────────────────────────────────
const registry = await loadRegistry();
const bySlug = new Map(registry.map((e) => [e.slug, e]));
const report = await readJson<{
	problems: { slug: string; status: string; reason?: string; errors?: string[] }[];
}>(join(DIST_DIR, 'report.json'));
const catalog = await readJson<{ themes: { slug: string; repo: string }[] }>(
	join(DIST_DIR, 'v1', 'catalog.json')
);

// Only failures the repository causes: not a build that could not reach GitHub, not a curator's hide.
const broken: BrokenTheme[] = report.problems.flatMap((p) => {
	const entry = bySlug.get(p.slug);
	const repoFault =
		p.status === 'missing' || (p.status === 'excluded' && p.reason === 'validation');
	if (!entry || !repoFault) return [];
	const owner = repoOwnerAndName(entry.repo).owner;
	const submitter = entry.submitted_by;
	const mention = [owner];
	if (submitter !== 'import' && submitter.toLowerCase() !== owner.toLowerCase())
		mention.push(submitter);
	return [
		{
			slug: p.slug,
			name: entry.name,
			repo: entry.repo,
			errors: p.errors ?? [],
			missing: p.status === 'missing',
			mention
		}
	];
});

// ── what is already on GitHub ────────────────────────────────────────────
const repoOfIssue = (issue: Issue): string | null => {
	const body = issue.body ?? '';
	const form = parseIssueForm(body).repo;
	if (form) return canonicalRepoUrl(form);
	const slug = /<!-- theme-health slug=(\S+) /.exec(body)?.[1];
	return (slug && bySlug.get(slug)?.repo) || null;
};

const openIssues: HealthIssue[] = [];
for (const issue of await all<Issue>(`/repos/${REPO}/issues?labels=${BROKEN_LABEL}&state=open`)) {
	if (issue.pull_request) continue;
	const repo = repoOfIssue(issue);
	if (!repo) continue;
	const comments = await all<{ body: string }>(`/repos/${REPO}/issues/${issue.number}/comments`);
	const text = [issue.body ?? '', ...comments.map((c) => c.body)].join('\n');
	openIssues.push({ number: issue.number, repo, lastCodes: codesFromMarker(text) });
}

// The published submission for a repo, or its latest one.
const submissionIssues = new Map<string, number>();
const submissions = (await all<Issue>(`/repos/${REPO}/issues?labels=submission&state=all`))
	.filter((i) => !i.pull_request)
	.sort((a, b) => a.number - b.number);
for (const issue of submissions) {
	const repo = repoOfIssue(issue);
	if (!repo) continue;
	const k = repo.toLowerCase();
	const published = issue.labels.some((l) => l.name === 'published');
	if (published || !submissionIssues.has(k)) submissionIssues.set(k, issue.number);
}

const actions = planHealth({
	broken,
	listed: catalog.themes,
	openIssues,
	submissionIssues,
	maxNew: Number(args['max-new']),
	siteUrl: SITE_URL
});

log(
	`${broken.length} themes not listed because of their repository; ${openIssues.length} open ${BROKEN_LABEL} issues; ${actions.length} actions`
);

// ── post ─────────────────────────────────────────────────────────────────
if (dryRun) {
	for (const a of actions) {
		const target = a.kind === 'open' ? `new issue "${a.title}"` : `#${a.issue}`;
		console.log(`\n=== ${a.kind} ${a.slug}: ${target}\n${a.body}`);
	}
	process.exit(0);
}

if (actions.length) {
	await api('POST', `/repos/${REPO}/labels`, {
		name: BROKEN_LABEL,
		color: 'd93f0b',
		description: 'A listed theme left out of the catalog because of a problem in its repository'
	}).catch(() => {}); // already exists
}

for (const a of actions) {
	const issue = `/repos/${REPO}/issues`;
	switch (a.kind) {
		case 'open':
			await api('POST', issue, { title: a.title, body: a.body, labels: [BROKEN_LABEL] });
			break;
		case 'reopen':
			// Label first: submit.yml ignores reopened issues that carry it.
			await api('POST', `${issue}/${a.issue}/labels`, { labels: [BROKEN_LABEL] });
			await api('PATCH', `${issue}/${a.issue}`, { state: 'open' });
			await api('POST', `${issue}/${a.issue}/comments`, { body: a.body });
			break;
		case 'update':
			await api('POST', `${issue}/${a.issue}/comments`, { body: a.body });
			break;
		case 'resolve':
			await api('POST', `${issue}/${a.issue}/comments`, { body: a.body });
			await api('DELETE', `${issue}/${a.issue}/labels/${BROKEN_LABEL}`);
			await api('PATCH', `${issue}/${a.issue}`, { state: 'closed', state_reason: 'completed' });
			break;
	}
	log(`${a.kind} ${a.slug}${a.kind === 'open' ? '' : ` #${a.issue}`}`);
	// GitHub limits how fast content is created; stay well under it.
	await new Promise((r) => setTimeout(r, 2000));
}
