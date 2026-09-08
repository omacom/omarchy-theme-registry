import { z } from 'zod';
import {
	CATALOG_SCHEMA_VERSION,
	GENERATIONS,
	HUES,
	MODES,
	PALETTE_KEYS,
	SLUG_RE,
	TAG_RE,
	MAX_TAGS
} from './constants.ts';

export * from './constants.ts';

const hex = z
	.string()
	.regex(/^#[0-9a-f]{6}$/, 'expected #rrggbb (lowercase)')
	.describe('Lowercase #rrggbb');

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime();

export const Slug = z.string().regex(SLUG_RE, 'slug must match ^[a-z0-9_][a-z0-9._+-]*$');
export const RepoUrl = z
	.url()
	.regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/, 'expected https://github.com/<owner>/<repo>')
	.describe('Canonical GitHub repo URL, no trailing slash, no .git');
export const GithubLogin = z.string().regex(/^[A-Za-z0-9-]{1,39}$/);

export const Mode = z.enum(MODES);
export const Hue = z.enum(HUES);
export const Generation = z.enum(GENERATIONS);

/**
 * `themes/<slug>.json` — what a human (or the submission bot) writes. Tiny on purpose:
 * anything derivable from the repo lives in the catalog, not here.
 */
export const RegistryEntry = z.strictObject({
	slug: Slug,
	repo: RepoUrl,
	name: z.string().trim().min(1).max(60),
	submitted_by: z.union([GithubLogin, z.literal('import')]),
	added_at: isoDate,
	tags: z.array(z.string().regex(TAG_RE)).max(MAX_TAGS).optional()
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

/** `overrides/*.json` — curator-only fields that a re-submission can never overwrite. */
export const Overrides = z.strictObject({
	featured: z.array(Slug).default([]),
	hidden: z.record(Slug, z.string().min(1)).default({})
});
export type Overrides = z.infer<typeof Overrides>;

export const Palette = z.object(
	Object.fromEntries(PALETTE_KEYS.map((k) => [k, hex.optional()])) as Record<
		(typeof PALETTE_KEYS)[number],
		z.ZodOptional<typeof hex>
	>
);
export type Palette = z.infer<typeof Palette>;

export const PreviewImage = z.strictObject({
	src: z.url(),
	thumb: z.url(),
	width: z.int().positive(),
	height: z.int().positive(),
	placeholder: hex.describe('dominant colour for a placeholder tile')
});

export const CatalogTheme = z.strictObject({
	slug: Slug,
	name: z.string(),
	repo: RepoUrl,
	author: z.strictObject({ login: GithubLogin, url: z.url() }),
	description: z.string().nullable(),
	license: z.string().nullable().describe('SPDX id from GitHub, or null'),
	mode: Mode,
	hue: Hue,
	colors: Palette,
	generation: Generation,
	ignored_on_install: z.array(z.string()),
	backgrounds: z.strictObject({
		count: z.int().nonnegative(),
		has_video: z.boolean(),
		total_bytes: z.int().nonnegative()
	}),
	preview: PreviewImage,
	commit: z.string().regex(/^[0-9a-f]{40}$/),
	pushed_at: isoDateTime,
	stars: z.int().nonnegative(),
	added_at: isoDate,
	tags: z.array(z.string()),
	featured: z.boolean(),
	warnings: z.array(z.string()),
	install: z.string().describe('the exact command to paste')
});
export type CatalogTheme = z.infer<typeof CatalogTheme>;

export const Catalog = z.strictObject({
	schema_version: z.literal(CATALOG_SCHEMA_VERSION),
	generated_at: isoDateTime,
	omarchy_min: z.string(),
	themes: z.array(CatalogTheme)
});
export type Catalog = z.infer<typeof Catalog>;

/** `catalog.min.json` — first paint for the CLI; a projection of CatalogTheme. */
export const CatalogMinTheme = CatalogTheme.pick({
	slug: true,
	name: true,
	repo: true,
	mode: true,
	hue: true,
	commit: true,
	featured: true,
	install: true
}).extend({
	author: GithubLogin,
	thumb: z.url(),
	accent: hex,
	background: hex
});
export type CatalogMinTheme = z.infer<typeof CatalogMinTheme>;

export const CatalogMin = z.strictObject({
	schema_version: z.literal(CATALOG_SCHEMA_VERSION),
	generated_at: isoDateTime,
	themes: z.array(CatalogMinTheme)
});
export type CatalogMin = z.infer<typeof CatalogMin>;

/** Output of the validator for one repo. */
export const Finding = z.strictObject({
	code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
	message: z.string(),
	path: z.string().optional()
});
export type Finding = z.infer<typeof Finding>;

export const ValidationReport = z.strictObject({
	ok: z.boolean(),
	errors: z.array(Finding),
	warnings: z.array(Finding),
	facts: z.strictObject({
		slug: Slug.nullable(),
		mode: Mode.nullable(),
		hue: Hue.nullable(),
		colors: Palette.nullable(),
		palette_source: z.enum(['colors.toml', 'alacritty.toml']).nullable(),
		palette_complete: z.boolean(),
		generation: Generation.nullable(),
		ignored_on_install: z.array(z.string()),
		backgrounds: z.strictObject({
			count: z.int().nonnegative(),
			has_video: z.boolean(),
			total_bytes: z.int().nonnegative()
		}),
		preview_path: z.string().nullable(),
		has_readme: z.boolean(),
		has_license_file: z.boolean(),
		has_unlock: z.boolean(),
		icons_theme: z.string().nullable(),
		file_count: z.int().nonnegative(),
		total_bytes: z.int().nonnegative()
	})
});
export type ValidationReport = z.infer<typeof ValidationReport>;
