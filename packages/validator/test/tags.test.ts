import { describe, expect, it } from 'vitest';
import { deriveTags, normalizeTag } from '../src/tags.ts';

describe('deriveTags', () => {
	it('drops boilerplate topics and keeps descriptive ones', () => {
		expect(
			deriveTags({
				slug: 'nujabes',
				topics: ['omarchy', 'omarchy-theme', 'archlinux', 'hyprland', 'lofi', 'warm', 'dark']
			})
		).toEqual(['lofi', 'warm']);
		expect(
			deriveTags({
				slug: 'x',
				topics: ['linux-desktop', 'hyprland-rice', 'wallpaper-pack', 'nature']
			})
		).toEqual(['nature']);
	});

	it('strips prefix/suffix and drops topics that repeat the slug', () => {
		expect(
			deriveTags({
				slug: 'cobalt2',
				topics: ['cobalt2-theme', 'cobalt2', 'omarchy-blue-theme', 'Neon']
			})
		).toEqual(['blue', 'neon']);
		expect(deriveTags({ slug: 'black-gold', topics: ['blackgold', 'gold'] })).toEqual(['gold']);
	});

	it('puts entry tags first, dedupes, caps at five', () => {
		expect(
			deriveTags({
				slug: 'x',
				entryTags: ['retro', 'neon'],
				topics: ['neon', 'space', 'cosmic', 'moody', 'urban', 'extra']
			})
		).toEqual(['retro', 'neon', 'space', 'cosmic', 'moody']);
	});

	it('normalizes and rejects invalid tags', () => {
		expect(normalizeTag(' Yellow Accent ')).toBe('yellow-accent');
		expect(normalizeTag('a')).toBeNull();
		expect(normalizeTag('emoji✨')).toBeNull();
		expect(normalizeTag('x'.repeat(30))).toBeNull();
	});
});
