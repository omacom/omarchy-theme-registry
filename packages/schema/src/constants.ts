/**
 * Constants mirrored from omacom/omarchy (branch `quattro`, v4.0.x).
 * When Omarchy changes one of these, change it here — the validator must agree with the installer.
 */

/** `bin/omarchy-theme-install`: the derived directory name must match this. */
export const SLUG_RE = /^[a-z0-9_][a-z0-9._+-]*$/;

/** Built-in themes shipped in `$OMARCHY_PATH/themes`. Reserved slugs — a community theme cannot shadow one. */
export const BUILTIN_THEMES = [
	'catppuccin-latte',
	'catppuccin',
	'ethereal',
	'everforest',
	'flexoki-light',
	'gruvbox',
	'hackerman',
	'kanagawa',
	'last-horizon',
	'lumon',
	'lupine',
	'matte-black',
	'miasma',
	'nord',
	'osaka-jade',
	'retro-82',
	'ristretto',
	'rose-pine',
	'solitude',
	'tokyo-night',
	'vantablack',
	'white'
] as const;

/**
 * `bin/omarchy-theme-set` → `stage_installed_theme`: files dropped from a theme installed from a git repo.
 * Any `*.lua` file and any symlink are also dropped (handled by pattern, not by name).
 */
export const INSTALL_DENIED_FILES = [
	'alacritty.toml',
	'foot.ini',
	'ghostty.conf',
	'kitty.conf',
	'vscode.json'
] as const;

/** Background formats accepted directly under `backgrounds/` (depth 1). */
export const BACKGROUND_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] as const;
export const BACKGROUND_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] as const;

/**
 * Preview file names at the repo root, in priority order. Omarchy's theme switcher
 * (`omarchy-theme-switcher`) looks for `preview.*` only, so a listed theme must ship one —
 * the marketplace shows exactly what the user will see on their system.
 */
export const PREVIEW_CANDIDATES = [
	'preview.png',
	'preview.jpg',
	'preview.jpeg',
	'preview.webp'
] as const;

/** Palette keys the validator requires in `colors.toml` for a theme to be listed. */
export const PALETTE_REQUIRED_KEYS = [
	'accent',
	'background',
	'foreground',
	'red',
	'yellow',
	'green',
	'cyan',
	'blue',
	'magenta'
] as const;

/** Full palette key set as shipped by built-in themes (used for the "complete palette" fact). */
export const PALETTE_KEYS = [
	'accent',
	'selection',
	'muted',
	'background',
	'dark_background',
	'darker_background',
	'lighter_background',
	'foreground',
	'dark_foreground',
	'light_foreground',
	'bright_foreground',
	'red',
	'yellow',
	'orange',
	'green',
	'cyan',
	'blue',
	'magenta',
	'brown',
	'bright_red',
	'bright_yellow',
	'bright_green',
	'bright_cyan',
	'bright_blue',
	'bright_magenta'
] as const;

/**
 * Legacy `colors.toml` key names still accepted by `omarchy-theme-color`, mapped to current names.
 * `color0..15` follow the ANSI order.
 */
export const PALETTE_LEGACY_ALIASES: Record<string, (typeof PALETTE_KEYS)[number]> = {
	bg: 'background',
	fg: 'foreground',
	dark_bg: 'dark_background',
	darker_bg: 'darker_background',
	lighter_bg: 'lighter_background',
	dark_fg: 'dark_foreground',
	light_fg: 'light_foreground',
	bright_fg: 'bright_foreground',
	color0: 'background',
	color1: 'red',
	color2: 'green',
	color3: 'yellow',
	color4: 'blue',
	color5: 'magenta',
	color6: 'cyan',
	color7: 'foreground',
	color8: 'dark_foreground',
	color9: 'bright_red',
	color10: 'bright_green',
	color11: 'bright_yellow',
	color12: 'bright_blue',
	color13: 'bright_magenta',
	color14: 'bright_cyan',
	color15: 'bright_foreground'
};

export const HUES = [
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'purple',
	'pink',
	'gray'
] as const;

export const MODES = ['dark', 'light'] as const;

export const GENERATIONS = ['native', 'hybrid', 'legacy'] as const;

/** Hard caps enforced by the validator (errors). */
export const LIMITS = {
	repoSizeBytes: 400 * 1024 * 1024,
	imageBytes: 50 * 1024 * 1024,
	imagePixels: 40_000_000,
	previewMinWidth: 1000
} as const;

/** Soft thresholds (warnings). */
export const THRESHOLDS = {
	backgroundsTotalBytes: 25 * 1024 * 1024,
	backgroundBytes: 8 * 1024 * 1024,
	newForDays: 14
} as const;

/** Catalog contract version. Bump only on breaking changes to the catalog shape. */
export const CATALOG_SCHEMA_VERSION = 1;

/** Minimum Omarchy version the catalog's install semantics assume. */
export const OMARCHY_MIN_VERSION = '4.0.0';
