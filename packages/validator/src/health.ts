/**
 * Telling artists when their theme is not listed, and when it is back. Pure: given what the build
 * found and what issues exist, decide what to post. `scripts/notify-artists.ts` carries it out.
 *
 * One issue per broken theme carries the conversation: the theme's submission issue when it has
 * one (reopened), otherwise a new issue. Either is labelled `theme-broken` while the theme is out
 * and closed once it is back. A new comment is posted only when the problems change.
 *
 * Someone may close that issue while the theme is still out. It keeps its label, so it stays the
 * theme's issue: nothing is posted while the problems are the same, it is reopened when they
 * change, and it is unlabelled once the theme is back. Otherwise every build would notify anew.
 */

export const BROKEN_LABEL = 'theme-broken';

/** A listed theme the build left out because of its repository (not a build-side failure). */
export interface BrokenTheme {
	slug: string;
	name: string;
	repo: string;
	/** `CODE path: message` lines from the build report; empty for a missing repository */
	errors: string[];
	missing: boolean;
	/** GitHub logins to mention: the repo owner, and the submitter when someone else */
	mention: string[];
}

export interface HealthIssue {
	number: number;
	/** canonical repo URL the issue is about */
	repo: string;
	/** error codes named by the last notice on it, or null when there is none */
	lastCodes: string[] | null;
	open: boolean;
}

export interface HealthInput {
	broken: BrokenTheme[];
	/** themes listed in this build */
	listed: { slug: string; repo: string }[];
	/** issues labelled `theme-broken`, open or closed */
	issues: HealthIssue[];
	/** submission issue per repo URL, for themes that came through the form */
	submissionIssues: Map<string, number>;
	/** at most this many themes get a first notice per run; the rest wait for the next build */
	maxNew: number;
	siteUrl: string;
}

export type HealthAction =
	| { kind: 'update'; slug: string; issue: number; body: string }
	| { kind: 'reopen'; slug: string; issue: number; body: string }
	| { kind: 'open'; slug: string; title: string; body: string }
	| { kind: 'resolve'; slug: string; issue: number; body: string };

const key = (repo: string) => repo.toLowerCase();

/**
 * Problems only a maintainer can fix: the repository was replaced or never pinned, or the
 * registry's install name collides (renaming the repo does not change a listed theme's slug).
 * Artists are not asked to fix these; they show in the build report for maintainers.
 */
export const MAINTAINER_CODES: ReadonlySet<string> = new Set([
	'REPO_REPLACED',
	'REPO_UNPINNED',
	'SLUG_BUILTIN',
	'SLUG_TAKEN'
]);

/** `PREVIEW_MISSING: No preview…` or `PALETTE_INCOMPLETE colors.toml: …` → `PREVIEW_MISSING`. */
export function errorCode(line: string): string {
	return /^[A-Z][A-Z0-9_]+/.exec(line)?.[0] ?? line;
}

/**
 * The errors an artist can act on. Maintainer-only problems are left out, and so is
 * PREVIEW_UNRENDERABLE when a preview error already says why (the build adds it whenever it has
 * no preview to render).
 */
export function explainedErrors(all: string[]): string[] {
	const errors = all.filter((e) => !MAINTAINER_CODES.has(errorCode(e)));
	const codes = errors.map(errorCode);
	const explained = codes.some((c) => c !== 'PREVIEW_UNRENDERABLE' && /^(PREVIEW_|IMAGE_)/.test(c));
	return explained ? errors.filter((e) => errorCode(e) !== 'PREVIEW_UNRENDERABLE') : errors;
}

export function codesOf(theme: BrokenTheme): string[] {
	return theme.missing
		? ['REPO_MISSING']
		: [...new Set(explainedErrors(theme.errors).map(errorCode))].sort();
}

/** The marker each notice carries, so the next run can tell whether the problems changed. */
export const healthMarker = (slug: string, codes: string[]) =>
	`<!-- theme-health slug=${slug} codes=${codes.join(',')} -->`;

export function codesFromMarker(text: string): string[] | null {
	const all = [...text.matchAll(/<!-- theme-health slug=\S+ codes=(\S*) -->/g)];
	const last = all.at(-1);
	return last ? (last[1] ? last[1].split(',') : []) : null;
}

export function noticeBody(theme: BrokenTheme, codes: string[], first: boolean): string {
	const who = theme.mention.map((l) => `@${l}`).join(' ');
	const lines = [
		healthMarker(theme.slug, codes),
		first
			? `${who} **${theme.name}** (\`${theme.slug}\`) is not listed on the Omarchy theme marketplace right now: the catalog build found a problem in [the repository](${theme.repo}).`
			: `${who} The problems with **${theme.name}** (\`${theme.slug}\`) changed; it is still not listed.`,
		''
	];
	if (theme.missing)
		lines.push(`- The repository is missing or private. If it moved, reply here with the new URL.`);
	else
		for (const e of explainedErrors(theme.errors))
			lines.push(`- \`${errorCode(e)}\` ${e.slice(errorCode(e).length).replace(/^:?\s*/, '— ')}`);
	lines.push(
		'',
		'Fix this in the repository and push. The catalog is rebuilt every six hours and lists the theme again automatically once it passes, with no need to resubmit. This issue closes when it is back.'
	);
	return lines.join('\n');
}

export function planHealth(input: HealthInput): HealthAction[] {
	const actions: HealthAction[] = [];
	// One issue per repo: an open one over a closed one, then the newest.
	const byRepo = new Map<string, HealthIssue>();
	for (const i of input.issues) {
		const prev = byRepo.get(key(i.repo));
		const better = !prev || (i.open === prev.open ? i.number > prev.number : i.open);
		if (better) byRepo.set(key(i.repo), i);
	}
	let fresh = 0;

	// Themes with a submission issue first: those artists asked to be listed.
	const broken = [...input.broken].sort(
		(a, b) =>
			Number(!input.submissionIssues.has(key(a.repo))) -
				Number(!input.submissionIssues.has(key(b.repo))) || a.slug.localeCompare(b.slug)
	);
	for (const theme of broken) {
		const codes = codesOf(theme);
		// Out only for reasons a maintainer has to fix: nothing to ask of the artist.
		if (!codes.length) continue;
		const issue = byRepo.get(key(theme.repo));
		if (issue) {
			const same = issue.lastCodes !== null && issue.lastCodes.join(',') === codes.join(',');
			if (!same)
				actions.push({
					kind: issue.open ? 'update' : 'reopen',
					slug: theme.slug,
					issue: issue.number,
					body: noticeBody(theme, codes, issue.lastCodes === null)
				});
			continue;
		}
		if (fresh >= input.maxNew) continue;
		fresh++;
		const submission = input.submissionIssues.get(key(theme.repo));
		if (submission !== undefined)
			actions.push({
				kind: 'reopen',
				slug: theme.slug,
				issue: submission,
				body: noticeBody(theme, codes, true)
			});
		else
			actions.push({
				kind: 'open',
				slug: theme.slug,
				title: `Not listed: ${theme.name} (${theme.slug})`,
				body: noticeBody(theme, codes, true)
			});
	}

	const listed = new Map(input.listed.map((t) => [key(t.repo), t.slug]));
	for (const issue of byRepo.values()) {
		const slug = listed.get(key(issue.repo));
		if (slug === undefined) continue;
		actions.push({
			kind: 'resolve',
			slug,
			issue: issue.number,
			body: `${healthMarker(slug, [])}\nThe theme passes again and is back on the marketplace: ${input.siteUrl}/themes/${slug}. Thanks for fixing it.`
		});
	}
	return actions;
}
