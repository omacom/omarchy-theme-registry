import { parse as parseToml } from 'smol-toml';
import {
	HUES,
	PALETTE_KEYS,
	PALETTE_LEGACY_ALIASES,
	PALETTE_REQUIRED_KEYS,
	type Palette
} from '@omarchy-themes/schema';

type Hue = (typeof HUES)[number];
type Mode = 'dark' | 'light';

export interface PaletteResult {
	colors: Palette;
	/** `mode` as declared in the file (or legacy `theme_type`), if any */
	declaredMode: Mode | null;
	/** keys that were present but unparseable */
	badKeys: string[];
	/** unknown keys, kept for warnings */
	unknownKeys: string[];
	/** extra non-colour keys Omarchy understands (e.g. hyprland_active_border) */
	extras: Record<string, string>;
}

const KNOWN_EXTRAS = new Set(['hyprland_active_border', 'hyprland_inactive_border']);

/** Accept `#rgb`, `#rrggbb`, `#rrggbbaa`, `rrggbb`, `0xrrggbb`; return lowercase `#rrggbb` or null. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	let v = value.trim().toLowerCase();
	if (v.startsWith('0x')) v = v.slice(2);
	if (v.startsWith('#')) v = v.slice(1);
	if (/^[0-9a-f]{3}$/.test(v)) v = v.replace(/./g, (c) => c + c);
	if (/^[0-9a-f]{8}$/.test(v)) v = v.slice(0, 6);
	return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

export function parseColorsToml(text: string): PaletteResult {
	const raw = parseToml(text) as Record<string, unknown>;
	return normalizePalette(raw);
}

export function normalizePalette(raw: Record<string, unknown>): PaletteResult {
	const colors: Palette = {};
	const badKeys: string[] = [];
	const unknownKeys: string[] = [];
	const extras: Record<string, string> = {};
	let declaredMode: Mode | null = null;

	const known = new Set<string>(PALETTE_KEYS);
	for (const [key, value] of Object.entries(raw)) {
		const k = key.toLowerCase();
		if (k === 'mode' || k === 'theme_type') {
			if (value === 'dark' || value === 'light') declaredMode = value;
			else badKeys.push(key);
			continue;
		}
		if (KNOWN_EXTRAS.has(k)) {
			if (typeof value === 'string') extras[k] = value;
			continue;
		}
		const target = known.has(k) ? (k as keyof Palette) : PALETTE_LEGACY_ALIASES[k];
		if (!target) {
			unknownKeys.push(key);
			continue;
		}
		const hex = normalizeHex(value);
		if (!hex) {
			badKeys.push(key);
			continue;
		}
		// canonical names win over legacy aliases when both are present
		if (colors[target] === undefined || known.has(k)) colors[target] = hex;
	}
	return { colors, declaredMode, badKeys, unknownKeys, extras };
}

/**
 * Mirrors `omarchy-theme-colors-from-alacritty`: pull the primary/normal/bright tables out of a
 * legacy alacritty.toml. Only used when colors.toml is absent.
 */
export function paletteFromAlacritty(text: string): PaletteResult {
	const raw = parseToml(text) as {
		colors?: {
			primary?: Record<string, unknown>;
			normal?: Record<string, unknown>;
			bright?: Record<string, unknown>;
			selection?: Record<string, unknown>;
		};
	};
	const c = raw.colors ?? {};
	const out: Record<string, unknown> = {};
	if (c.primary?.background) out.background = c.primary.background;
	if (c.primary?.foreground) out.foreground = c.primary.foreground;
	if (c.selection?.background) out.selection = c.selection.background;
	for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
		if (c.normal?.[name]) out[name] = c.normal[name];
		if (c.bright?.[name]) out[`bright_${name}`] = c.bright[name];
	}
	if (c.normal?.black) out.dark_background = c.normal.black;
	if (c.normal?.white) out.light_foreground = c.normal.white;
	if (c.bright?.black) out.dark_foreground = c.bright.black;
	if (c.bright?.white) out.bright_foreground = c.bright.white;
	if (out.blue && !out.accent) out.accent = out.blue;
	// Alacritty allows keywords such as "CellForeground" here; drop anything that is not a colour
	// instead of reporting it — the file was never written for Omarchy's palette rules.
	for (const [k, v] of Object.entries(out)) if (normalizeHex(v) === null) delete out[k];
	return normalizePalette(out);
}

export function missingRequiredKeys(colors: Palette): string[] {
	return PALETTE_REQUIRED_KEYS.filter((k) => colors[k] === undefined);
}

export function isCompletePalette(colors: Palette): boolean {
	return PALETTE_KEYS.every((k) => colors[k] !== undefined);
}

function hexToRgb(hex: string): [number, number, number] {
	return [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16)
	];
}

/** `omarchy-theme-color` fallback: r+g+b > 382 → light. */
export function modeFromBackground(background: string): Mode {
	const [r, g, b] = hexToRgb(background);
	return r + g + b > 382 ? 'light' : 'dark';
}

function rgbToHsl(hex: string): [number, number, number] {
	const [r255, g255, b255] = hexToRgb(hex);
	const r = r255 / 255,
		g = g255 / 255,
		b = b255 / 255;
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
	else if (max === g) h = ((b - r) / d + 2) * 60;
	else h = ((r - g) / d + 4) * 60;
	return [h, s, l];
}

/** Bucket the accent colour into one of the marketplace's filterable hues. */
export function hueBucket(hex: string): Hue {
	const [h, s, l] = rgbToHsl(hex);
	if (s < 0.15 || l < 0.08 || l > 0.95) return 'gray';
	if (h < 12 || h >= 352) return 'red';
	if (h < 38) return 'orange';
	if (h < 68) return 'yellow';
	if (h < 160) return 'green';
	if (h < 195) return 'teal';
	if (h < 255) return 'blue';
	if (h < 300) return 'purple';
	return 'pink';
}
