import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import {
	BACKGROUND_IMAGE_EXTENSIONS,
	BACKGROUND_VIDEO_EXTENSIONS,
	INSTALL_DENIED_FILES,
	INSTALLED_NOTICE_FILES,
	INSTALLED_THEME_FILES,
	PREVIEW_CANDIDATES,
	SWITCHER_PREVIEW_FILES
} from '@omarchy-themes/schema';

export interface TreeFile {
	/** path relative to the theme root, POSIX separators */
	path: string;
	bytes: number;
	isSymlink: boolean;
	isExecutable: boolean;
}

export interface TreeInfo {
	files: TreeFile[];
	symlinks: string[];
	totalBytes: number;
	fileCount: number;
	/** top-level entries (files and dirs) */
	rootEntries: string[];
	rootFiles: Set<string>;
}

const SKIP_DIRS = new Set(['.git']);

/** Walk a checked-out theme directory. Never follows symlinks. */
export async function walkTree(root: string): Promise<TreeInfo> {
	const files: TreeFile[] = [];
	const symlinks: string[] = [];
	let totalBytes = 0;

	async function walk(dir: string) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const abs = join(dir, entry.name);
			const rel = relative(root, abs).split('\\').join('/');
			const st = await lstat(abs);
			if (st.isSymbolicLink()) {
				symlinks.push(rel);
				files.push({ path: rel, bytes: 0, isSymlink: true, isExecutable: false });
				continue;
			}
			if (st.isDirectory()) {
				await walk(abs);
				continue;
			}
			if (st.isFile()) {
				totalBytes += st.size;
				files.push({
					path: rel,
					bytes: st.size,
					isSymlink: false,
					isExecutable: (st.mode & 0o111) !== 0
				});
			}
		}
	}
	await walk(root);
	const rootEntries = await readdir(root);
	return {
		files,
		symlinks,
		totalBytes,
		fileCount: files.filter((f) => !f.isSymlink).length,
		rootEntries: rootEntries.filter((e) => !SKIP_DIRS.has(e)),
		rootFiles: new Set(files.filter((f) => !f.path.includes('/')).map((f) => f.path))
	};
}

/**
 * Files Omarchy will drop for a repo-installed theme (`stage_installed_theme`). The name check
 * runs on top-level entries only — subdirectories are copied as they are — so a nested `.lua`
 * is kept, as upstream keeps it.
 */
export function ignoredOnInstall(tree: TreeInfo): string[] {
	const denied = new Set<string>(INSTALL_DENIED_FILES);
	return tree.files
		.filter(
			(f) =>
				f.isSymlink || (!f.path.includes('/') && (f.path.endsWith('.lua') || denied.has(f.path)))
		)
		.map((f) => f.path)
		.sort();
}

/**
 * What a marketplace install puts on the machine: the exact names `omarchy theme install <name>`
 * checks out (`INSTALLED_THEME_FILES`, `SWITCHER_PREVIEW_FILES`, `INSTALLED_NOTICE_FILES`), the
 * backgrounds Omarchy picks up (supported image and video formats directly under `backgrounds/`,
 * any case), `shell.<section>.toml` overrides, and a legacy `alacritty.toml` only when there is no
 * `colors.toml` for Omarchy to derive one from. Informational — Omarchy's sparse checkout is what
 * enforces it. Symlinks are never listed. Sorted, relative to the theme root.
 */
export function installedFiles(tree: TreeInfo): string[] {
	const wanted = new Set<string>([
		...INSTALLED_THEME_FILES,
		...SWITCHER_PREVIEW_FILES,
		...INSTALLED_NOTICE_FILES
	]);
	const backgrounds = new Set(inspectBackgrounds(tree).usable.map((f) => f.path));
	const hasColors = tree.rootFiles.has('colors.toml');
	return tree.files
		.filter((f) => {
			if (f.isSymlink) return false;
			if (backgrounds.has(f.path)) return true;
			if (f.path.includes('/')) return false;
			const name = f.path;
			if (wanted.has(name)) return true;
			if (name === 'alacritty.toml') return !hasColors;
			return /^shell\.[A-Za-z0-9_-]+\.toml$/.test(name);
		})
		.map((f) => f.path)
		.sort();
}

export interface BackgroundInfo {
	/** direct children of backgrounds/ that Omarchy will pick up */
	usable: TreeFile[];
	/** files under backgrounds/ Omarchy will NOT pick up (subfolders, unsupported extensions) */
	skipped: TreeFile[];
	hasVideo: boolean;
	totalBytes: number;
}

export function inspectBackgrounds(tree: TreeInfo): BackgroundInfo {
	const img = new Set<string>(BACKGROUND_IMAGE_EXTENSIONS);
	const vid = new Set<string>(BACKGROUND_VIDEO_EXTENSIONS);
	const usable: TreeFile[] = [];
	const skipped: TreeFile[] = [];
	let hasVideo = false;
	for (const f of tree.files) {
		if (!f.path.startsWith('backgrounds/') || f.isSymlink) continue;
		const rest = f.path.slice('backgrounds/'.length);
		const ext = extname(rest).slice(1).toLowerCase();
		if (rest.includes('/') || !(img.has(ext) || vid.has(ext))) {
			skipped.push(f);
			continue;
		}
		if (vid.has(ext)) hasVideo = true;
		usable.push(f);
	}
	return {
		usable,
		skipped,
		hasVideo,
		totalBytes: usable.reduce((n, f) => n + f.bytes, 0)
	};
}

/** Find the best preview image the same way the Omarchy switcher and the gallery would. */
/** The `preview.*` file Omarchy's theme switcher would use, or null. No fallbacks. */
export function findPreview(tree: TreeInfo): string | null {
	for (const c of PREVIEW_CANDIDATES) if (tree.rootFiles.has(c)) return c;
	return null;
}

export type Generation = 'native' | 'hybrid' | 'legacy';

/** Legacy hand-written per-app files (pre-quattro). */
const LEGACY_APP_FILES = new Set([
	'alacritty.toml',
	'hyprland.conf',
	'hyprlock.conf',
	'waybar.css',
	'walker.css',
	'wofi.css',
	'mako.ini',
	'swayosd.css',
	'neovim.lua',
	'kitty.conf',
	'ghostty.conf',
	'foot.ini'
]);

export function detectGeneration(tree: TreeInfo): Generation {
	const hasColors = tree.rootFiles.has('colors.toml');
	const legacyCount = [...tree.rootFiles].filter((f) => LEGACY_APP_FILES.has(f)).length;
	if (hasColors && legacyCount === 0) return 'native';
	if (hasColors) return 'hybrid';
	return 'legacy';
}

const SUSPICIOUS_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.rb', '.pl', '.desktop']);
const BINARY_EXT = new Set(['.so', '.bin', '.exe', '.dll', '.dylib', '.AppImage', '.deb', '.rpm']);

/**
 * Scripts and binaries. A marketplace install never checks them out; surfaced so submitters know
 * and reviewers can look. (`.fish` is not listed: `colors.fish` and `fzf.fish` are palette
 * assignments shipped by a popular template, not programs.)
 */
export function suspiciousFiles(tree: TreeInfo): string[] {
	return tree.files
		.filter((f) => {
			if (f.isSymlink) return false;
			const ext = extname(f.path);
			const name = basename(f.path);
			return (
				SUSPICIOUS_EXT.has(ext) ||
				BINARY_EXT.has(ext) ||
				(f.isExecutable && !/\.(png|jpe?g|webp|gif|toml|css|ini|md|txt|json|lua|conf)$/i.test(name))
			);
		})
		.map((f) => f.path)
		.sort();
}

export async function readRootFile(root: string, name: string): Promise<string | null> {
	try {
		return await readFile(join(root, name), 'utf8');
	} catch {
		return null;
	}
}

export function hasRootFileMatching(tree: TreeInfo, re: RegExp): boolean {
	return [...tree.rootFiles].some((f) => re.test(f));
}
