import { describe, expect, it } from 'vitest';
import {
	hueBucket,
	modeFromBackground,
	normalizeHex,
	paletteFromAlacritty,
	parseColorsToml
} from '../src/palette.ts';

describe('normalizeHex', () => {
	it.each([
		['#7aa2f7', '#7aa2f7'],
		['#7AA2F7', '#7aa2f7'],
		['7aa2f7', '#7aa2f7'],
		['0x7aa2f7', '#7aa2f7'],
		['#abc', '#aabbcc'],
		['#7aa2f7ff', '#7aa2f7']
	])('%s → %s', (i, o) => expect(normalizeHex(i)).toBe(o));
	it('rejects junk', () => {
		expect(normalizeHex('rgba(1,2,3)')).toBeNull();
		expect(normalizeHex(12)).toBeNull();
		expect(normalizeHex('#12345')).toBeNull();
	});
});

describe('parseColorsToml', () => {
	it('parses a quattro palette', () => {
		const p = parseColorsToml(`
mode = "dark"
accent = "#7aa2f7"
background = "#1a1b26"
foreground = "#a9b1d6"
red = "#f7768e"
hyprland_active_border = "rgba(26a269ee) rgba(2ec27eee) 45deg"
`);
		expect(p.declaredMode).toBe('dark');
		expect(p.colors.accent).toBe('#7aa2f7');
		expect(p.extras.hyprland_active_border).toContain('45deg');
		expect(p.badKeys).toEqual([]);
		expect(p.unknownKeys).toEqual([]);
	});

	it('maps legacy keys and lets canonical names win', () => {
		const p = parseColorsToml(`
theme_type = "light"
bg = "#ffffff"
background = "#fefefe"
color1 = "#ff0000"
color9 = "#ff5555"
`);
		expect(p.declaredMode).toBe('light');
		expect(p.colors.background).toBe('#fefefe');
		expect(p.colors.red).toBe('#ff0000');
		expect(p.colors.bright_red).toBe('#ff5555');
	});

	it('reports bad values and unknown keys', () => {
		const p = parseColorsToml(`accent = "blue"\nfoo = "#000000"\nmode = "dusk"`);
		expect(p.badKeys).toEqual(['accent', 'mode']);
		expect(p.unknownKeys).toEqual(['foo']);
	});
});

describe('paletteFromAlacritty', () => {
	it('derives the core palette', () => {
		const p = paletteFromAlacritty(`
[colors.primary]
background = "#1a1b26"
foreground = "#a9b1d6"
[colors.normal]
black = "#15161e"
red = "#f7768e"
green = "#9ece6a"
yellow = "#e0af68"
blue = "#7aa2f7"
magenta = "#bb9af7"
cyan = "#7dcfff"
white = "#a9b1d6"
[colors.bright]
black = "#414868"
red = "#f7768e"
white = "#c0caf5"
[colors.selection]
background = "CellForeground"
`);
		expect(p.colors.selection).toBeUndefined();
		expect(p.badKeys).toEqual([]);
		expect(p.colors.background).toBe('#1a1b26');
		expect(p.colors.accent).toBe('#7aa2f7');
		expect(p.colors.dark_foreground).toBe('#414868');
		expect(p.colors.bright_foreground).toBe('#c0caf5');
	});
});

describe('modeFromBackground', () => {
	it('uses the r+g+b > 382 rule', () => {
		expect(modeFromBackground('#1a1b26')).toBe('dark');
		expect(modeFromBackground('#fefefe')).toBe('light');
		expect(modeFromBackground('#808080')).toBe('light'); // 384
		expect(modeFromBackground('#7f7f7f')).toBe('dark'); // 381
	});
});

describe('hueBucket', () => {
	it.each([
		['#7aa2f7', 'blue'],
		['#9ece6a', 'green'],
		['#bb9af7', 'purple'],
		['#ff9e64', 'orange'],
		['#f7768e', 'pink'],
		['#e0af68', 'orange'],
		['#f9e2af', 'yellow'],
		['#2ac3de', 'teal'],
		['#ff0000', 'red'],
		['#cc241d', 'red'],
		['#9099b2', 'blue'],
		['#8a8a8a', 'gray'],
		['#000000', 'gray']
	])('%s → %s', (hex, hue) => expect(hueBucket(hex)).toBe(hue));
});
