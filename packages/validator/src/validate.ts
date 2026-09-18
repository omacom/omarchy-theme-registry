import { basename, extname } from 'node:path';
import {
	BUILTIN_THEMES,
	LIMITS,
	PALETTE_LEGACY_ALIASES,
	PALETTE_REQUIRED_KEYS,
	THRESHOLDS,
	type Finding,
	type ValidationReport
} from '@omarchy-themes/schema';
import type { RepoMeta } from './github.ts';
import {
	detectGeneration,
	findPreview,
	hasRootFileMatching,
	ignoredOnInstall,
	inspectBackgrounds,
	installedFiles,
	readRootFile,
	suspiciousFiles,
	walkTree
} from './inspect.ts';
import {
	hueBucket,
	isCompletePalette,
	missingRequiredKeys,
	modeFromBackground,
	paletteFromAlacritty,
	parseColorsToml,
	type PaletteResult
} from './palette.ts';
import { deriveSlug, isValidSlug } from './slug.ts';

export interface ValidateOptions {
	/** checked-out theme directory */
	dir: string;
	/** canonical repo URL — used for slug derivation */
	repoUrl: string;
	/** GitHub metadata, if available (null when validating a local directory only) */
	meta?: RepoMeta | null;
	/** slugs already in the registry (excluding this theme's own, when re-validating) */
	takenSlugs?: Iterable<string>;
	/** image dimension probe; injected so the validator has no hard dependency on sharp */
	probeImage?: (absPath: string) => Promise<{ width: number; height: number } | null>;
}

class Report {
	errors: Finding[] = [];
	warnings: Finding[] = [];
	error(code: string, message: string, path?: string) {
		this.errors.push(path ? { code, message, path } : { code, message });
	}
	warn(code: string, message: string, path?: string) {
		this.warnings.push(path ? { code, message, path } : { code, message });
	}
}

function fmtMb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function validateTheme(opts: ValidateOptions): Promise<ValidationReport> {
	const r = new Report();
	const meta = opts.meta ?? null;
	const taken = new Set(opts.takenSlugs ?? []);

	// ── repo-level ─────────────────────────────────────────────────────────
	if (meta) {
		if (meta.missing) r.error('REPO_MISSING', 'Repository does not exist or is not accessible.');
		if (meta.isPrivate) r.error('REPO_PRIVATE', 'Repository is private.');
		if (meta.isArchived)
			r.warn(
				'REPO_ARCHIVED',
				'Repository is archived; it still installs, but nobody maintains it.'
			);
		if (meta.movedTo)
			r.warn('REPO_MOVED', `Repository has moved to ${meta.movedTo}; update the registry entry.`);
		if (meta.sizeKb * 1024 > LIMITS.repoSizeBytes)
			r.error(
				'REPO_TOO_LARGE',
				`Repository is ${fmtMb(meta.sizeKb * 1024)}; the limit is ${fmtMb(LIMITS.repoSizeBytes)}.`
			);
		if (!meta.topics.includes('omarchy-theme'))
			r.warn('REPO_NO_TOPIC', 'Add the GitHub topic `omarchy-theme` so the theme is discoverable.');
		if (!meta.license) r.warn('REPO_NO_LICENSE', 'GitHub reports no recognised license.');
	}

	// ── slug ───────────────────────────────────────────────────────────────
	const slug = deriveSlug(opts.repoUrl);
	if (!isValidSlug(slug)) {
		r.error(
			'SLUG_INVALID',
			`Repository name gives the install name "${slug}", which Omarchy refuses. It must match ^[a-z0-9_][a-z0-9._+-]*$ (rename the repo).`
		);
	} else {
		if ((BUILTIN_THEMES as readonly string[]).includes(slug))
			r.error(
				'SLUG_BUILTIN',
				`"${slug}" is a built-in Omarchy theme name; a community theme cannot shadow it. Rename the repo.`
			);
		if (taken.has(slug))
			r.error(
				'SLUG_TAKEN',
				`"${slug}" is already claimed by another listed theme (first claim keeps it). Rename the repo so it installs to a different directory.`
			);
		const repoName = basename(opts.repoUrl);
		if (!/^omarchy-.+-theme$/i.test(repoName))
			r.warn(
				'REPO_NAME_CONVENTION',
				`Recommended repo name is omarchy-${slug}-theme (it installs as "${slug}" either way).`
			);
	}

	// ── tree ───────────────────────────────────────────────────────────────
	const tree = await walkTree(opts.dir);
	for (const s of tree.symlinks)
		r.error('SYMLINK', 'Symlinks are dropped on install and not allowed in listed themes.', s);

	const generation = detectGeneration(tree);
	const ignored = ignoredOnInstall(tree).filter((p) => !tree.symlinks.includes(p));
	if (ignored.length)
		r.warn(
			'IGNORED_ON_INSTALL',
			`These files are dropped when the theme is installed from a repo and are regenerated from colors.toml: ${ignored.join(', ')}.`
		);

	// nested layout: no colors.toml at root but one exists deeper
	const nested = tree.files.find((f) => f.path.includes('/') && basename(f.path) === 'colors.toml');
	if (!tree.rootFiles.has('colors.toml') && nested)
		r.error(
			'THEME_NESTED',
			`Theme files must be at the repository root; found ${nested.path}. Omarchy clones the whole repo and looks at the top level only.`,
			nested.path
		);

	// ── palette ────────────────────────────────────────────────────────────
	let palette: PaletteResult | null = null;
	let paletteSource: 'colors.toml' | 'alacritty.toml' | null = null;
	const colorsText = await readRootFile(opts.dir, 'colors.toml');
	if (colorsText !== null) {
		try {
			palette = parseColorsToml(colorsText);
			paletteSource = 'colors.toml';
		} catch (e) {
			r.error(
				'COLORS_PARSE',
				`colors.toml is not valid TOML: ${(e as Error).message}`,
				'colors.toml'
			);
		}
	} else {
		const alacritty = await readRootFile(opts.dir, 'alacritty.toml');
		if (alacritty !== null) {
			try {
				palette = paletteFromAlacritty(alacritty);
				paletteSource = 'alacritty.toml';
				r.warn(
					'PALETTE_LEGACY',
					'No colors.toml; the palette is derived from alacritty.toml the way Omarchy does on install. Add a colors.toml for full control.',
					'alacritty.toml'
				);
			} catch (e) {
				r.error(
					'COLORS_PARSE',
					`alacritty.toml is not valid TOML: ${(e as Error).message}`,
					'alacritty.toml'
				);
			}
		} else {
			r.error(
				'PALETTE_MISSING',
				'No colors.toml (and no legacy alacritty.toml to derive one from). A theme needs a palette.'
			);
		}
	}

	let mode: 'dark' | 'light' | null = null;
	let hue: ReturnType<typeof hueBucket> | null = null;
	let paletteComplete = false;
	if (palette) {
		const missing = missingRequiredKeys(palette.colors);
		if (missing.length)
			r.error(
				'PALETTE_INCOMPLETE',
				`Palette is missing required keys: ${missing.join(', ')}.`,
				paletteSource!
			);
		if (palette.badKeys.length) {
			const required = new Set<string>(PALETTE_REQUIRED_KEYS);
			const bad = palette.badKeys.filter((k) => required.has(PALETTE_LEGACY_ALIASES[k] ?? k));
			const badOptional = palette.badKeys.filter(
				(k) => !required.has(PALETTE_LEGACY_ALIASES[k] ?? k)
			);
			if (bad.length)
				r.error(
					'PALETTE_BAD_VALUE',
					`These keys are not valid colours: ${bad.join(', ')}.`,
					paletteSource!
				);
			if (badOptional.length)
				r.warn(
					'PALETTE_BAD_VALUE',
					`These optional keys are not valid colours and will be ignored: ${badOptional.join(', ')}.`,
					paletteSource!
				);
		}
		if (palette.unknownKeys.length)
			r.warn(
				'PALETTE_UNKNOWN_KEYS',
				`Unknown keys are ignored by Omarchy: ${palette.unknownKeys.join(', ')}.`,
				paletteSource!
			);
		paletteComplete = isCompletePalette(palette.colors);
		if (!paletteComplete && !missing.length)
			r.warn(
				'PALETTE_PARTIAL',
				'Palette is missing optional keys; Omarchy will derive them, but explicit values render better.',
				paletteSource!
			);

		const hasLightMarker = tree.rootFiles.has('light.mode');
		const bg = palette.colors.background;
		const luminanceMode = bg ? modeFromBackground(bg) : null;
		mode = palette.declaredMode ?? (hasLightMarker ? 'light' : luminanceMode);
		if (palette.declaredMode && hasLightMarker && palette.declaredMode !== 'light')
			r.warn(
				'MODE_CONFLICT',
				`colors.toml says mode = "${palette.declaredMode}" but a light.mode marker file is present.`
			);
		if (!palette.declaredMode)
			r.warn(
				'MODE_UNDECLARED',
				`Add mode = "${mode ?? 'dark'}" to colors.toml instead of relying on background luminance.`,
				'colors.toml'
			);
		if (mode && luminanceMode && mode !== luminanceMode)
			r.warn(
				'MODE_LUMINANCE',
				`Declared ${mode} mode but the background ${bg} looks ${luminanceMode}.`
			);

		if (palette.colors.accent) hue = hueBucket(palette.colors.accent);
	}

	// ── backgrounds ────────────────────────────────────────────────────────
	const backgrounds = inspectBackgrounds(tree);
	if (backgrounds.usable.length === 0)
		r.warn(
			'BACKGROUNDS_NONE',
			'No backgrounds/ images found; Omarchy will fall back to a default wallpaper.'
		);
	for (const f of backgrounds.skipped)
		r.warn(
			'BACKGROUND_SKIPPED',
			'Omarchy only picks up supported image/video files directly inside backgrounds/.',
			f.path
		);
	if (backgrounds.hasVideo)
		r.warn(
			'BACKGROUND_VIDEO',
			'Video backgrounds are supported but heavy; make sure the repo stays small.'
		);
	if (backgrounds.totalBytes > THRESHOLDS.backgroundsTotalBytes)
		r.warn(
			'BACKGROUNDS_LARGE',
			`backgrounds/ is ${fmtMb(backgrounds.totalBytes)}; re-encode with: magick in.png -strip -resize '3840>' -quality 82 out.webp`
		);
	for (const f of backgrounds.usable) {
		if (f.bytes > LIMITS.imageBytes)
			r.error(
				'IMAGE_TOO_LARGE',
				`${fmtMb(f.bytes)} exceeds the ${fmtMb(LIMITS.imageBytes)} per-file limit.`,
				f.path
			);
		else if (f.bytes > THRESHOLDS.backgroundBytes)
			r.warn('BACKGROUND_HEAVY', `${fmtMb(f.bytes)}; consider re-encoding as WebP.`, f.path);
		if (/[^\x21-\x7e]/.test(basename(f.path)))
			r.warn(
				'BACKGROUND_FILENAME',
				'Filename has spaces or non-ASCII characters; keep names simple (01-name.webp).',
				f.path
			);
	}

	// ── preview ────────────────────────────────────────────────────────────
	const previewPath = findPreview(tree);
	if (!previewPath) {
		r.error(
			'PREVIEW_MISSING',
			'No preview.png at the repository root. Omarchy shows this file in its theme switcher, so add a 16:9 screenshot of the theme on a real desktop as preview.png.'
		);
	} else {
		const pf = tree.files.find((f) => f.path === previewPath)!;
		if (pf.bytes > LIMITS.imageBytes)
			r.error(
				'IMAGE_TOO_LARGE',
				`${fmtMb(pf.bytes)} exceeds the ${fmtMb(LIMITS.imageBytes)} per-file limit.`,
				previewPath
			);
		if (opts.probeImage) {
			const dims = await opts.probeImage(`${opts.dir}/${previewPath}`);
			if (!dims) r.error('PREVIEW_UNREADABLE', 'Preview image could not be decoded.', previewPath);
			else {
				if (dims.width * dims.height > LIMITS.imagePixels)
					r.error(
						'IMAGE_TOO_MANY_PIXELS',
						`${dims.width}×${dims.height} exceeds the ${LIMITS.imagePixels / 1e6} MP limit.`,
						previewPath
					);
				if (dims.width < LIMITS.previewMinWidth)
					r.error(
						'PREVIEW_TOO_SMALL',
						`Preview is ${dims.width}px wide; at least ${LIMITS.previewMinWidth}px is required.`,
						previewPath
					);
				const ratio = dims.width / dims.height;
				if (Math.abs(ratio - 16 / 9) > 0.08)
					r.warn(
						'PREVIEW_ASPECT',
						`Preview is ${dims.width}×${dims.height}; a 16:9 screenshot fits the gallery best.`,
						previewPath
					);
			}
		}
	}

	// ── misc facts & hygiene ───────────────────────────────────────────────
	const hasReadme = hasRootFileMatching(tree, /^readme(\.|$)/i);
	const hasLicenseFile = hasRootFileMatching(tree, /^(licen[cs]e|copying)(\.|$)/i);
	if (!hasReadme) r.warn('NO_README', 'Add a README with a screenshot and the install command.');
	if (!hasLicenseFile)
		r.warn(
			'NO_LICENSE_FILE',
			'Add a LICENSE file (and credit wallpaper sources if they are not yours).'
		);

	const iconsTheme = (await readRootFile(opts.dir, 'icons.theme'))?.trim() ?? null;
	if (iconsTheme !== null && !/^Yaru(-[a-z]+)?$/.test(iconsTheme))
		r.warn(
			'ICONS_THEME_UNKNOWN',
			`icons.theme is "${iconsTheme}"; Omarchy ships Yaru variants only.`,
			'icons.theme'
		);
	const keyboardRgb = (await readRootFile(opts.dir, 'keyboard.rgb'))?.trim();
	if (keyboardRgb !== undefined && !/^[0-9a-fA-F]{6}$/.test(keyboardRgb))
		r.warn(
			'KEYBOARD_RGB_INVALID',
			'keyboard.rgb should be six hex digits (e.g. ff00ff).',
			'keyboard.rgb'
		);

	const hasUnlock = tree.rootFiles.has('unlock.png') && tree.rootFiles.has('preview-unlock.png');
	if (tree.rootFiles.has('unlock.png') !== tree.rootFiles.has('preview-unlock.png'))
		r.warn('UNLOCK_PAIR', 'unlock.png and preview-unlock.png go together; add the missing one.');

	const vscode = await readRootFile(opts.dir, 'vscode.json');
	if (vscode !== null) {
		try {
			const j = JSON.parse(vscode) as { extension?: string };
			if (j.extension)
				r.warn(
					'VSCODE_EXTENSION',
					`vscode.json names the extension "${j.extension}", which is ignored on repo install anyway.`,
					'vscode.json'
				);
		} catch {
			r.warn('VSCODE_JSON_INVALID', 'vscode.json is not valid JSON.', 'vscode.json');
		}
	}

	for (const p of suspiciousFiles(tree))
		r.warn(
			'NON_THEME_PAYLOAD',
			'Script, launcher or binary. It stays in your repository; a marketplace install does not check it out.',
			p
		);
	const installed = installedFiles(tree);

	for (const f of tree.files) {
		if (f.isSymlink || f.path.startsWith('backgrounds/') || f.path === previewPath) continue;
		if (
			/\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i.test(extname(f.path)) &&
			f.bytes > LIMITS.imageBytes
		)
			r.error(
				'IMAGE_TOO_LARGE',
				`${fmtMb(f.bytes)} exceeds the ${fmtMb(LIMITS.imageBytes)} per-file limit.`,
				f.path
			);
	}
	if (tree.totalBytes > LIMITS.repoSizeBytes)
		r.error(
			'REPO_TOO_LARGE',
			`Checked-out tree is ${fmtMb(tree.totalBytes)}; the limit is ${fmtMb(LIMITS.repoSizeBytes)}.`
		);

	return {
		ok: r.errors.length === 0,
		errors: r.errors,
		warnings: r.warnings,
		facts: {
			slug: isValidSlug(slug) ? slug : null,
			mode,
			hue,
			colors: palette?.colors ?? null,
			palette_source: paletteSource,
			palette_complete: paletteComplete,
			generation: palette ? generation : null,
			ignored_on_install: ignored,
			backgrounds: {
				count: backgrounds.usable.length,
				has_video: backgrounds.hasVideo,
				total_bytes: backgrounds.totalBytes
			},
			preview_path: previewPath,
			installed_files: installed,
			has_readme: hasReadme,
			has_license_file: hasLicenseFile,
			has_unlock: hasUnlock,
			icons_theme: iconsTheme,
			file_count: tree.fileCount,
			total_bytes: tree.totalBytes
		}
	};
}

/** Render a report as Markdown for PR comments and CLI output. */
export function reportToMarkdown(report: ValidationReport, title = 'Validation'): string {
	const lines: string[] = [];
	lines.push(`### ${title}: ${report.ok ? '✅ passed' : '❌ needs changes'}`);
	lines.push('');
	if (report.errors.length) {
		lines.push('**Errors (must fix):**');
		for (const f of report.errors)
			lines.push(`- \`${f.code}\`${f.path ? ` \`${f.path}\`` : ''} — ${f.message}`);
		lines.push('');
	}
	if (report.warnings.length) {
		lines.push('**Warnings:**');
		for (const f of report.warnings)
			lines.push(`- \`${f.code}\`${f.path ? ` \`${f.path}\`` : ''} — ${f.message}`);
		lines.push('');
	}
	const f = report.facts;
	lines.push('**Detected:**');
	lines.push(
		`- slug \`${f.slug ?? '?'}\` · ${f.mode ?? '?'} · hue ${f.hue ?? '?'} · ${f.generation ?? '?'} palette (${f.palette_source ?? 'none'})`
	);
	lines.push(
		`- ${f.backgrounds.count} background(s), ${(f.backgrounds.total_bytes / 1024 / 1024).toFixed(1)} MB · preview \`${f.preview_path ?? 'none'}\` · ${f.file_count} files`
	);
	lines.push(
		`- a marketplace install puts ${f.installed_files.length} of them on your machine: ${f.installed_files.map((p) => `\`${p}\``).join(', ') || 'nothing'}`
	);
	return lines.join('\n');
}
