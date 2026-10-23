import { describe, expect, it } from 'vitest';
import {
	codesFromMarker,
	codesOf,
	healthMarker,
	noticeBody,
	planHealth,
	type BrokenTheme,
	type HealthInput
} from '../src/health.ts';

const repo = (slug: string) => `https://github.com/artist/omarchy-${slug}-theme`;

const broken = (slug: string, errors: string[], over: Partial<BrokenTheme> = {}): BrokenTheme => ({
	slug,
	name: slug[0]!.toUpperCase() + slug.slice(1),
	repo: repo(slug),
	errors,
	missing: false,
	mention: ['artist'],
	...over
});

const input = (over: Partial<HealthInput>): HealthInput => ({
	broken: [],
	listed: [],
	issues: [],
	submissionIssues: new Map(),
	maxNew: 10,
	siteUrl: 'https://themes.test',
	...over
});

const PREVIEW = 'PREVIEW_MISSING: No preview.png at the repository root.';
const PALETTE = 'PALETTE_INCOMPLETE colors.toml: Palette is missing required keys: blue.';

describe('planHealth', () => {
	it("reopens the theme's submission issue when it has one", () => {
		const [a] = planHealth(
			input({
				broken: [broken('dune', [PREVIEW])],
				submissionIssues: new Map([[repo('dune'), 12]])
			})
		);
		expect(a).toMatchObject({ kind: 'reopen', issue: 12, slug: 'dune' });
		expect(a!.body).toContain('@artist');
		expect(a!.body).toContain('`PREVIEW_MISSING` — No preview.png');
	});

	it('opens a new issue for a theme that never had one', () => {
		const [a] = planHealth(input({ broken: [broken('dune', [PREVIEW])] }));
		expect(a).toMatchObject({ kind: 'open', title: 'Not listed: Dune (dune)' });
	});

	it('stays quiet while the problems are the same', () => {
		const actions = planHealth(
			input({
				broken: [broken('dune', [PREVIEW])],
				issues: [{ number: 12, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: true }]
			})
		);
		expect(actions).toEqual([]);
	});

	it('comments again when the problems change', () => {
		const [a] = planHealth(
			input({
				broken: [broken('dune', [PREVIEW, PALETTE])],
				issues: [{ number: 12, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: true }]
			})
		);
		expect(a).toMatchObject({ kind: 'update', issue: 12 });
		expect(a!.body).toContain('changed');
		expect(codesFromMarker(a!.body)).toEqual(['PALETTE_INCOMPLETE', 'PREVIEW_MISSING']);
	});

	it('closes the issue once the theme is listed again', () => {
		const [a] = planHealth(
			input({
				listed: [{ slug: 'dune', repo: repo('dune') }],
				issues: [{ number: 12, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: true }]
			})
		);
		expect(a).toMatchObject({ kind: 'resolve', issue: 12, slug: 'dune' });
		expect(a!.body).toContain('https://themes.test/themes/dune');
	});

	it('spreads first notices over builds, submitters first', () => {
		const actions = planHealth(
			input({
				broken: [broken('aaa', [PREVIEW]), broken('bbb', [PREVIEW]), broken('zzz', [PREVIEW])],
				submissionIssues: new Map([[repo('zzz'), 5]]),
				maxNew: 2
			})
		);
		expect(actions.map((a) => a.slug)).toEqual(['zzz', 'aaa']);
	});

	it('stays quiet on a closed issue while the problems are the same', () => {
		const actions = planHealth(
			input({
				broken: [broken('dune', [PREVIEW])],
				issues: [{ number: 40, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: false }],
				submissionIssues: new Map([[repo('dune'), 12]])
			})
		);
		expect(actions).toEqual([]);
	});

	it('reopens a closed issue when the problems change', () => {
		const [a] = planHealth(
			input({
				broken: [broken('dune', [PALETTE])],
				issues: [{ number: 40, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: false }]
			})
		);
		expect(a).toMatchObject({ kind: 'reopen', issue: 40 });
		expect(a!.body).toContain('changed');
	});

	it('prefers the open issue when a repo has an open and a closed one', () => {
		const actions = planHealth(
			input({
				listed: [{ slug: 'dune', repo: repo('dune') }],
				issues: [
					{ number: 50, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: false },
					{ number: 12, repo: repo('dune'), lastCodes: ['PREVIEW_MISSING'], open: true }
				]
			})
		);
		expect(actions).toMatchObject([{ kind: 'resolve', issue: 12 }]);
	});

	it('asks nothing of the artist for problems only a maintainer can fix', () => {
		const replaced = 'REPO_REPLACED: This is not the repository that was submitted.';
		expect(planHealth(input({ broken: [broken('dune', [replaced])] }))).toEqual([]);
		const [a] = planHealth(input({ broken: [broken('dune', [replaced, PREVIEW])] }));
		expect(codesFromMarker(a!.body)).toEqual(['PREVIEW_MISSING']);
		expect(a!.body).not.toContain('REPO_REPLACED');
	});

	it('matches repositories regardless of case', () => {
		const actions = planHealth(
			input({
				broken: [broken('dune', [PREVIEW])],
				issues: [
					{
						number: 12,
						repo: repo('dune').toUpperCase(),
						lastCodes: ['PREVIEW_MISSING'],
						open: true
					}
				]
			})
		);
		expect(actions).toEqual([]);
	});
});

describe('notices', () => {
	it('leaves out PREVIEW_UNRENDERABLE when a preview error already explains it', () => {
		const t = broken('dune', [PREVIEW, 'PREVIEW_UNRENDERABLE: No preview could be rendered.']);
		expect(codesOf(t)).toEqual(['PREVIEW_MISSING']);
		expect(noticeBody(t, codesOf(t), true)).not.toContain('PREVIEW_UNRENDERABLE');
		const alone = broken('dune', ['PREVIEW_UNRENDERABLE: No preview could be rendered.']);
		expect(codesOf(alone)).toEqual(['PREVIEW_UNRENDERABLE']);
	});

	it('names a missing repository', () => {
		const t = broken('gone', [], { missing: true });
		expect(codesOf(t)).toEqual(['REPO_MISSING']);
		expect(noticeBody(t, codesOf(t), true)).toContain('missing or private');
	});

	it('reads the last marker back', () => {
		const text = `${healthMarker('x', ['A'])}\n…\n${healthMarker('x', ['A', 'B'])}`;
		expect(codesFromMarker(text)).toEqual(['A', 'B']);
		expect(codesFromMarker('no marker')).toBeNull();
		expect(codesFromMarker(healthMarker('x', []))).toEqual([]);
	});
});
