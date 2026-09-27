import { describe, expect, it } from 'vitest';
import {
	DIGEST_MARKER,
	installedChanges,
	renderDigest,
	type DigestInput,
	type DigestTheme
} from '../src/digest.ts';

const theme = (slug: string, commit: string, over: Partial<DigestTheme> = {}): DigestTheme => ({
	slug,
	name: slug[0]!.toUpperCase() + slug.slice(1),
	repo: `https://github.com/artist/omarchy-${slug}-theme`,
	commit: commit.padEnd(40, '0'),
	author: { login: 'artist', url: 'https://github.com/artist' },
	preview: {
		src: `https://cdn.test/v1/previews/${slug}/${commit}/1200.webp`,
		thumb: `https://cdn.test/v1/previews/${slug}/${commit}/480.webp`,
		width: 1200,
		height: 675,
		placeholder: '#000000'
	},
	installed_files: ['colors.toml', 'preview.png', 'backgrounds/1.jpg'],
	...over
});

const input = (over: Partial<DigestInput>): DigestInput => ({
	generatedAt: '2026-09-27T18:00:00.000Z',
	previous: { generated_at: '2026-09-27T12:00:00.000Z', themes: [] },
	current: [],
	dropReasons: {},
	changes: {},
	siteUrl: 'https://themes.test',
	...over
});

describe('installedChanges', () => {
	it('keeps files a marketplace install checks out, before or after, except README and LICENSE', () => {
		const before = { installed_files: ['README.md', 'colors.toml', 'backgrounds/old.jpg'] };
		const after = { installed_files: ['colors.toml', 'backgrounds/new.jpg'] };
		const files = [
			{ path: 'README.md', status: 'modified' },
			{ path: 'install.sh', status: 'added' },
			{ path: 'colors.toml', status: 'modified' },
			{ path: 'backgrounds/old.jpg', status: 'removed' },
			{ path: 'backgrounds/new.jpg', status: 'added' }
		];
		expect(installedChanges(files, before, after).map((f) => f.path)).toEqual([
			'colors.toml',
			'backgrounds/old.jpg',
			'backgrounds/new.jpg'
		]);
	});
});

describe('renderDigest', () => {
	it('reports nothing changed when every theme is on the same commit', () => {
		const t = theme('dune', 'aaa');
		const d = renderDigest(
			input({ previous: { generated_at: '2026-09-27T12:00:00.000Z', themes: [t] }, current: [t] })
		);
		expect(d.changed).toBe(false);
		expect(d.markdown.startsWith(DIGEST_MARKER(false))).toBe(true);
		expect(d.markdown).toContain('No listed theme changed');
	});

	it('lists updated, new and dropped themes', () => {
		const d = renderDigest(
			input({
				previous: {
					generated_at: '2026-09-27T12:00:00.000Z',
					themes: [theme('dune', 'aaa'), theme('gone', 'ccc')]
				},
				current: [theme('dune', 'bbb'), theme('fresh', 'ddd')],
				changes: {
					dune: [
						{ path: 'preview.png', status: 'modified' },
						{ path: 'backgrounds/2.jpg', status: 'added' }
					]
				},
				dropReasons: { gone: 'PREVIEW_MISSING: No preview.png' }
			})
		);
		expect(d.changed).toBe(true);
		expect(d.markdown.startsWith(DIGEST_MARKER(true))).toBe(true);
		expect(d.markdown).toContain('**Updated (1)**');
		expect(d.markdown).toContain('/compare/aaa');
		// a changed preview shows before and after
		expect(d.markdown).toContain('previews/dune/aaa/480.webp');
		expect(d.markdown).toContain('previews/dune/bbb/480.webp');
		expect(d.markdown).toContain(
			'backgrounds/2.jpg`](https://github.com/artist/omarchy-dune-theme/blob/'
		);
		expect(d.markdown).toContain('**Newly listed or back (1)**');
		expect(d.markdown).toContain('https://themes.test/themes/fresh');
		expect(d.markdown).toContain('**Dropped (1)**');
		expect(d.markdown).toContain('PREVIEW_MISSING: No preview.png');
	});

	it('leaves out commits that touch nothing a marketplace install checks out', () => {
		const d = renderDigest(
			input({
				previous: { generated_at: '2026-09-27T12:00:00.000Z', themes: [theme('dune', 'aaa')] },
				current: [theme('dune', 'bbb')],
				changes: { dune: [] }
			})
		);
		expect(d.changed).toBe(false);
		expect(d.markdown).toContain('1 other theme(s) got new commits');
	});

	it('flags a theme GitHub could not compare', () => {
		const d = renderDigest(
			input({
				previous: { generated_at: '2026-09-27T12:00:00.000Z', themes: [theme('dune', 'aaa')] },
				current: [theme('dune', 'bbb')],
				changes: { dune: null }
			})
		);
		expect(d.changed).toBe(true);
		expect(d.markdown).toContain('history was rewritten');
	});

	it('says so when there is no previous catalog', () => {
		const d = renderDigest(input({ previous: null, current: [theme('dune', 'aaa')] }));
		expect(d.changed).toBe(false);
		expect(d.markdown).toContain('could not be read');
	});

	it('truncates to fit an issue comment', () => {
		const many = Array.from({ length: 50 }, (_, i) => theme(`t${i}`, 'eee'));
		const d = renderDigest(input({ current: many }), 2_000);
		expect(d.markdown.length).toBeLessThan(2_200);
		expect(d.markdown).toContain('…truncated');
		expect(renderDigest(input({ current: many })).markdown).not.toContain('…truncated');
	});
});
