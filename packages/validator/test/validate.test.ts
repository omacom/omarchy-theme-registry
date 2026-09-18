import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateTheme } from '../src/validate.ts';
import type { RepoMeta } from '../src/github.ts';

const TOKYO = `
mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"
foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"
red = "#f7768e"
yellow = "#e0af68"
orange = "#eb927b"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
brown = "#75493d"
bright_red = "#ff7a93"
bright_yellow = "#ff9e64"
bright_green = "#b9f27c"
bright_cyan = "#0db9d7"
bright_blue = "#7da6ff"
bright_magenta = "#bb9af7"
`;

const meta = (over: Partial<RepoMeta> = {}): RepoMeta => ({
	owner: 'x',
	name: 'omarchy-fixture-theme',
	htmlUrl: 'https://github.com/x/omarchy-fixture-theme',
	description: 'fixture',
	isPrivate: false,
	isArchived: false,
	isFork: false,
	defaultBranch: 'main',
	stars: 1,
	pushedAt: '2026-09-01T00:00:00Z',
	createdAt: '2026-08-01T00:00:00Z',
	license: 'MIT',
	topics: ['omarchy-theme'],
	sizeKb: 100,
	missing: false,
	movedTo: null,
	...over
});

const probe = async () => ({ width: 1920, height: 1080 });

let base: string;
beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), 'validator-fixtures-'));
});
afterAll(() => rm(base, { recursive: true, force: true }));

async function fixture(
	name: string,
	files: Record<string, string | Buffer>,
	size?: Record<string, number>
) {
	const dir = join(base, name);
	for (const [p, content] of Object.entries(files)) {
		await mkdir(dirname(join(dir, p)), { recursive: true });
		const bytes = size?.[p] ? Buffer.alloc(size[p]!) : content;
		await writeFile(join(dir, p), bytes);
	}
	return dir;
}

describe('validateTheme', () => {
	it('passes a native quattro theme with no warnings that matter', async () => {
		const dir = await fixture('native', {
			'colors.toml': TOKYO,
			'icons.theme': 'Yaru-magenta\n',
			'btop.theme': 'theme[main_bg]="#1a1b26"',
			'colors.fish': 'set -U fish_color_command green',
			'preview.png': 'png',
			'preview.mp4': 'video for the switcher; the marketplace renders preview.png',
			'LICENSE.old': 'not an exact notice name',
			'README.md': '# fixture',
			LICENSE: 'MIT',
			'backgrounds/1-a.webp': 'img',
			'backgrounds/2-b.webp': 'img'
		});
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/omarchy-fixture-theme',
			meta: meta(),
			probeImage: probe
		});
		expect(r.errors).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.facts).toMatchObject({
			slug: 'fixture',
			mode: 'dark',
			hue: 'blue',
			generation: 'native',
			palette_source: 'colors.toml',
			palette_complete: true,
			preview_path: 'preview.png',
			backgrounds: { count: 2, has_video: false }
		});
		expect(r.warnings.map((w) => w.code)).toEqual([]);
		// a marketplace install checks out what Omarchy reads plus LICENSE/README; colors.fish is neither
		expect(r.facts.installed_files).toEqual([
			'LICENSE',
			'README.md',
			'backgrounds/1-a.webp',
			'backgrounds/2-b.webp',
			'btop.theme',
			'colors.toml',
			'icons.theme',
			'preview.mp4',
			'preview.png'
		]);
	});

	it('warns about ignored files on a hybrid theme', async () => {
		const dir = await fixture('hybrid', {
			'colors.toml': TOKYO,
			'alacritty.toml': '[colors.primary]\nbackground = "#000000"',
			'neovim.lua': 'return {}',
			'hyprland.lua': 'x',
			'waybar.css': '*{}',
			'vscode.json': '{"extension":"enkia.tokyo-night"}',
			'extras/nvim/init.lua': 'x',
			'shell.lock.toml': 'text = "#a9b1d6"\n',
			'preview.png': 'png',
			'backgrounds/a.png': 'img',
			'backgrounds/B.JPG': 'img',
			'backgrounds/loop.mp4': 'video'
		});
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/omarchy-hybrid-theme',
			probeImage: probe
		});
		expect(r.ok).toBe(true);
		expect(r.facts.generation).toBe('hybrid');
		// only top-level entries are subject to the denylist; subdirectories are copied as they are
		expect(r.facts.ignored_on_install).toEqual([
			'alacritty.toml',
			'hyprland.lua',
			'neovim.lua',
			'vscode.json'
		]);
		// legacy per-app files and the denied ones are never checked out; a shell section override is,
		// and so is every supported background format, any case
		expect(r.facts.backgrounds).toMatchObject({ count: 3, has_video: true });
		expect(r.facts.installed_files).toEqual([
			'backgrounds/B.JPG',
			'backgrounds/a.png',
			'backgrounds/loop.mp4',
			'colors.toml',
			'preview.png',
			'shell.lock.toml'
		]);
		const codes = r.warnings.map((w) => w.code);
		expect(codes).toContain('IGNORED_ON_INSTALL');
		expect(codes).toContain('VSCODE_EXTENSION');
		expect(codes).toContain('NO_README');
	});

	it('derives a legacy palette from alacritty.toml', async () => {
		const dir = await fixture('legacy', {
			'alacritty.toml': `[colors.primary]
background = "#282828"
foreground = "#ebdbb2"
[colors.normal]
red = "#cc241d"
green = "#98971a"
yellow = "#d79921"
blue = "#458588"
magenta = "#b16286"
cyan = "#689d6a"`,
			'waybar.css': '*{}',
			'preview.jpg': 'jpg',
			'backgrounds/a.jpg': 'img'
		});
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/omarchy-legacy-theme',
			probeImage: probe
		});
		expect(r.ok).toBe(true);
		expect(r.facts.generation).toBe('legacy');
		expect(r.facts.palette_source).toBe('alacritty.toml');
		expect(r.facts.mode).toBe('dark');
		expect(r.facts.preview_path).toBe('preview.jpg');
		// no colors.toml, so alacritty.toml is checked out for Omarchy to derive the palette from
		expect(r.facts.installed_files).toEqual(['alacritty.toml', 'backgrounds/a.jpg', 'preview.jpg']);
		expect(r.warnings.map((w) => w.code)).toContain('PALETTE_LEGACY');
		expect(r.warnings.map((w) => w.code)).toContain('MODE_UNDECLARED');
	});

	it('rejects a nested layout', async () => {
		const dir = await fixture('nested', {
			'README.md': '#',
			'matte-black/colors.toml': TOKYO,
			'matte-black/preview.png': 'png'
		});
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/matte-black-theme',
			probeImage: probe
		});
		expect(r.ok).toBe(false);
		const codes = r.errors.map((e) => e.code);
		expect(codes).toContain('THEME_NESTED');
		expect(codes).toContain('SLUG_BUILTIN');
	});

	it('rejects symlinks, missing palette, private/archived repos, taken slugs', async () => {
		const dir = await fixture('bad', { 'README.md': '#', 'backgrounds/a.png': 'img' });
		await symlink('README.md', join(dir, 'link.md'));
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/omarchy-Bad Name-theme',
			meta: meta({ isPrivate: true, isArchived: true }),
			takenSlugs: ['bad name'],
			probeImage: probe
		});
		const codes = r.errors.map((e) => e.code);
		expect(codes).toContain('SYMLINK');
		expect(codes).toContain('PALETTE_MISSING');
		expect(codes).toContain('PREVIEW_MISSING');
		expect(codes).toContain('REPO_PRIVATE');
		expect(r.warnings.map((w) => w.code)).toContain('REPO_ARCHIVED');
		expect(codes).toContain('SLUG_INVALID');
		expect(r.facts.slug).toBeNull();
	});

	it('flags slug collisions and image limits', async () => {
		const dir = await fixture(
			'limits',
			{ 'colors.toml': TOKYO, 'preview.png': 'x', 'backgrounds/huge.png': 'x' },
			{ 'backgrounds/huge.png': 51 * 1024 * 1024 }
		);
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/omarchy-limits-theme',
			takenSlugs: ['limits'],
			probeImage: async () => ({ width: 640, height: 360 })
		});
		const codes = r.errors.map((e) => e.code);
		expect(codes).toContain('SLUG_TAKEN');
		expect(codes).toContain('IMAGE_TOO_LARGE');
		expect(codes).toContain('PREVIEW_TOO_SMALL');
	});

	it('surfaces scripts and mode conflicts as warnings', async () => {
		const dir = await fixture('payload', {
			'colors.toml': TOKYO.replace('mode = "dark"', 'mode = "dark"'),
			'light.mode': '',
			'install.sh': '#!/bin/sh\necho hi',
			'preview.png': 'png',
			'backgrounds/My Wallpaper.png': 'img',
			'backgrounds/sub/x.png': 'img'
		});
		await chmod(join(dir, 'install.sh'), 0o755);
		const r = await validateTheme({
			dir,
			repoUrl: 'https://github.com/x/omarchy-payload-theme',
			probeImage: probe
		});
		expect(r.ok).toBe(true);
		const codes = r.warnings.map((w) => w.code);
		expect(codes).toContain('NON_THEME_PAYLOAD');
		expect(codes).toContain('MODE_CONFLICT');
		expect(codes).toContain('BACKGROUND_FILENAME');
		expect(codes).toContain('BACKGROUND_SKIPPED');
		expect(r.facts.backgrounds.count).toBe(1);
		expect(r.facts.installed_files).not.toContain('install.sh');
		expect(r.facts.installed_files).toContain('light.mode');
	});
});
