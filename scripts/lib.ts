import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Overrides, RegistryEntry, type RegistryEntry as Entry } from '@omarchy-themes/schema';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const THEMES_DIR = join(ROOT, 'themes');
export const OVERRIDES_DIR = join(ROOT, 'overrides');
export const STATE_DIR = join(ROOT, 'state');
export const DIST_DIR = join(ROOT, 'dist');
export const WORK_DIR = join(ROOT, '.work');

export const CDN_BASE_URL = (process.env.CDN_BASE_URL ?? 'https://cdn.themes.omarchy.org').replace(
	/\/$/,
	''
);

export function githubToken(): string | undefined {
	return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
	try {
		return await readJson<T>(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
		throw e;
	}
}

export async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, pretty ? JSON.stringify(value, null, '\t') + '\n' : JSON.stringify(value));
}

/** Load and validate every `themes/<slug>.json`. Throws on any invalid file so CI fails loudly. */
export async function loadRegistry(): Promise<Entry[]> {
	const files = (await readdir(THEMES_DIR)).filter((f) => f.endsWith('.json')).sort();
	const entries: Entry[] = [];
	const problems: string[] = [];
	const seenRepos = new Map<string, string>();
	for (const file of files) {
		const raw = await readJson<unknown>(join(THEMES_DIR, file));
		const parsed = RegistryEntry.safeParse(raw);
		if (!parsed.success) {
			problems.push(
				`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
			);
			continue;
		}
		const entry = parsed.data;
		if (`${entry.slug}.json` !== file)
			problems.push(`${file}: slug "${entry.slug}" does not match filename`);
		const repoKey = entry.repo.toLowerCase();
		const dup = seenRepos.get(repoKey);
		if (dup) problems.push(`${file}: repo already listed by ${dup}.json`);
		seenRepos.set(repoKey, entry.slug);
		entries.push(entry);
	}
	if (problems.length) throw new Error(`Registry problems:\n- ${problems.join('\n- ')}`);
	return entries;
}

export async function loadOverrides(): Promise<Overrides> {
	const featured = await readJsonOr<string[]>(join(OVERRIDES_DIR, 'featured.json'), []);
	const hidden = await readJsonOr<Record<string, string>>(join(OVERRIDES_DIR, 'hidden.json'), {});
	return Overrides.parse({ featured, hidden });
}

export async function probeImage(
	absPath: string
): Promise<{ width: number; height: number } | null> {
	try {
		const m = await sharp(absPath, { limitInputPixels: false }).metadata();
		if (!m.width || !m.height) return null;
		return { width: m.width, height: m.height };
	} catch {
		return null;
	}
}

export interface ProcessedPreview {
	files: { name: string; buffer: Buffer }[];
	width: number;
	height: number;
	placeholder: string;
}

/** 1200×675 and 480×270 WebP covers plus a dominant colour. */
export async function processPreview(input: string | Buffer): Promise<ProcessedPreview> {
	const base = sharp(input, { limitInputPixels: 40_000_000 }).rotate();
	const { dominant } = await base.clone().stats();
	const placeholder =
		'#' + [dominant.r, dominant.g, dominant.b].map((n) => n.toString(16).padStart(2, '0')).join('');
	const make = (w: number, h: number) =>
		base
			.clone()
			.resize(w, h, { fit: 'cover', position: 'centre', withoutEnlargement: false })
			.webp({ quality: 80, effort: 5 })
			.toBuffer();
	const [full, thumb] = await Promise.all([make(1200, 675), make(480, 270)]);
	return {
		files: [
			{ name: '1200.webp', buffer: full },
			{ name: '480.webp', buffer: thumb }
		],
		width: 1200,
		height: 675,
		placeholder
	};
}

/** Run `fn` over `items` with at most `limit` in flight. Preserves order of results. */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]!, i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function log(...args: unknown[]): void {
	console.error(...args);
}
