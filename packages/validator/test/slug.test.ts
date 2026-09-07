import { describe, expect, it } from 'vitest';
import { canonicalRepoUrl, deriveSlug, isValidSlug } from '../src/slug.ts';

describe('deriveSlug (mirrors omarchy-theme-install)', () => {
	it.each([
		['https://github.com/x/omarchy-tokyo-night-theme', 'tokyo-night'],
		['https://github.com/x/omarchy-Tokyo-Night-theme.git', 'tokyo-night'],
		['git@github.com:x/omarchy-flexoki_light-theme.git', 'flexoki_light'],
		['https://github.com/x/omarchy-c++-theme', 'c++'],
		['https://github.com/JJDizz1L/aetheria', 'aetheria'],
		['https://github.com/tahayvr/matte-black-theme', 'matte-black'],
		['https://github.com/x/omarchy-agentuity.theme', 'agentuity.theme'],
		['https://github.com/x/omarchy-theme', 'theme'],
		['https://github.com/x/repo/', 'repo']
	])('%s → %s', (url, slug) => {
		expect(deriveSlug(url)).toBe(slug);
	});
});

describe('isValidSlug', () => {
	it.each(['tokyo-night', 'c++', 'a.b_c-d', '_x', '9lives'])('accepts %s', (s) =>
		expect(isValidSlug(s)).toBe(true)
	);
	it.each(['-leading', '.hidden', 'has space', 'Ünïcode', 'Upper', ''])('rejects %s', (s) =>
		expect(isValidSlug(s)).toBe(false)
	);
});

describe('canonicalRepoUrl', () => {
	it.each([
		['https://github.com/a/b', 'https://github.com/a/b'],
		['https://github.com/a/b.git', 'https://github.com/a/b'],
		['https://github.com/a/b/', 'https://github.com/a/b'],
		['https://github.com/a/b/tree/main', 'https://github.com/a/b'],
		['git@github.com:a/b.git', 'https://github.com/a/b'],
		['https://www.github.com/a/b', 'https://github.com/a/b']
	])('%s → %s', (input, out) => expect(canonicalRepoUrl(input)).toBe(out));
	it('rejects non-github', () => {
		expect(canonicalRepoUrl('https://gitlab.com/a/b')).toBeNull();
		expect(canonicalRepoUrl('not a url')).toBeNull();
	});
});
