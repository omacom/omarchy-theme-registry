import { INSTALLED_NOTICE_FILES, type CatalogTheme } from '@omarchy-themes/schema';

/** What the digest needs from a catalog entry; the previous catalog is read loosely by these. */
export type DigestTheme = Pick<
	CatalogTheme,
	'slug' | 'name' | 'repo' | 'commit' | 'author' | 'preview' | 'installed_files'
>;

export interface FileChange {
	path: string;
	status: string;
	/** set when GitHub reports a rename */
	previous?: string;
}

export interface DigestInput {
	generatedAt: string;
	/** the catalog that was live before this build; null when it could not be read */
	previous: { generated_at: string; themes: DigestTheme[] } | null;
	current: DigestTheme[];
	/** why each theme that left the catalog is no longer in it */
	dropReasons: Record<string, string>;
	/**
	 * For a theme whose commit moved: the changed files a marketplace install checks out, or null
	 * when GitHub could not compare the two commits (history rewritten, or an API error).
	 */
	changes: Record<string, FileChange[] | null>;
	siteUrl: string;
}

/** First line of every digest, so a workflow can tell whether to post it without parsing. */
export const DIGEST_MARKER = (changed: boolean) => `<!-- catalog-digest changed=${changed} -->`;

/** GitHub rejects issue comments over 65,536 characters. */
export const ISSUE_COMMENT_LIMIT = 60_000;
const MAX_FILES_PER_THEME = 12;

/**
 * Of the files GitHub says changed, the ones that change the theme on a machine: files a
 * marketplace install checks out, before or after, other than the README and LICENSE.
 */
export function installedChanges(
	files: FileChange[],
	before: Pick<DigestTheme, 'installed_files'>,
	after: Pick<DigestTheme, 'installed_files'>
): FileChange[] {
	const notice = new Set<string>(INSTALLED_NOTICE_FILES);
	const themed = new Set(
		[...before.installed_files, ...after.installed_files].filter((p) => !notice.has(p))
	);
	return files.filter(
		(f) => themed.has(f.path) || (f.previous !== undefined && themed.has(f.previous))
	);
}

const isPreview = (path: string) => /^preview\.[a-z0-9]+$/i.test(path);

/** `maxLength` caps the Markdown (for an issue comment); leave it out for the full digest. */
export function renderDigest(
	input: DigestInput,
	maxLength = Infinity
): { markdown: string; changed: boolean } {
	const time = (iso: string) => iso.replace('T', ' ').slice(0, 16) + ' UTC';
	const head = [`### Catalog changes · ${time(input.generatedAt)}`, ''];

	if (!input.previous) {
		return {
			changed: false,
			markdown: [
				DIGEST_MARKER(false),
				...head,
				'The previously published catalog could not be read, so there is nothing to compare against.'
			].join('\n')
		};
	}

	const before = new Map(input.previous.themes.map((t) => [t.slug, t]));
	const now = new Map(input.current.map((t) => [t.slug, t]));
	const page = (t: DigestTheme) => `[${t.name}](${input.siteUrl}/themes/${t.slug})`;
	const by = (t: DigestTheme) => `@${t.author.login}`;
	const short = (sha: string) => sha.slice(0, 7);
	const thumb = (t: DigestTheme) => `<img src="${t.preview.thumb}" width="240" alt="${t.slug}">`;

	const added = input.current.filter((t) => !before.has(t.slug));
	const dropped = input.previous.themes.filter((t) => !now.has(t.slug));
	const updated: string[][] = [];
	let quiet = 0;

	for (const t of input.current) {
		const prev = before.get(t.slug);
		if (!prev || prev.commit === t.commit) continue;
		const files = input.changes[t.slug];
		if (files !== undefined && files !== null && files.length === 0) {
			quiet++;
			continue;
		}
		const compare = `${t.repo}/compare/${prev.commit}...${t.commit}`;
		const lines = [
			`#### ${page(t)} · ${by(t)} · [\`${short(prev.commit)}\` → \`${short(t.commit)}\`](${compare})`
		];
		if (files === null || files === undefined) {
			lines.push(
				'',
				'GitHub could not compare the two commits (history was rewritten). Check the repository.'
			);
			if (prev.preview.thumb !== t.preview.thumb) lines.push('', `${thumb(prev)} → ${thumb(t)}`);
		} else {
			if (files.some((f) => isPreview(f.path)) && prev.preview.thumb !== t.preview.thumb)
				lines.push('', `${thumb(prev)} → ${thumb(t)}`);
			lines.push('');
			for (const f of files.slice(0, MAX_FILES_PER_THEME)) {
				const link =
					f.status === 'removed'
						? `\`${f.path}\``
						: `[\`${f.path}\`](${t.repo}/blob/${t.commit}/${f.path})`;
				lines.push(`- ${link} ${f.status}${f.previous ? ` (was \`${f.previous}\`)` : ''}`);
			}
			if (files.length > MAX_FILES_PER_THEME)
				lines.push(`- …and ${files.length - MAX_FILES_PER_THEME} more`);
		}
		updated.push(lines);
	}

	const changed = added.length + dropped.length + updated.length > 0;
	const sections: string[][] = [];
	if (updated.length)
		sections.push(['', `**Updated (${updated.length})**`], ...updated.map((u) => ['', ...u]));
	if (added.length) {
		sections.push(['', `**Newly listed or back (${added.length})**`]);
		for (const t of added)
			sections.push([
				'',
				`#### ${page(t)} · ${by(t)} · [\`${short(t.commit)}\`](${t.repo}/tree/${t.commit})`,
				'',
				thumb(t)
			]);
	}
	if (dropped.length) {
		sections.push(['', `**Dropped (${dropped.length})**`, '']);
		for (const t of dropped)
			sections.push([
				`- ${t.name} (\`${t.slug}\`) · ${by(t)}: ${input.dropReasons[t.slug] ?? 'no longer in the registry'}`
			]);
	}

	const intro = changed
		? `Compared with the catalog published ${time(input.previous.generated_at)}. Only files a marketplace install checks out are listed.`
		: `No listed theme changed since the catalog published ${time(input.previous.generated_at)}.`;
	const tail = quiet
		? [
				'',
				`${quiet} other theme(s) got new commits that touch nothing a marketplace install checks out.`
			]
		: [];

	const out = [DIGEST_MARKER(changed), ...head, intro];
	let length = out.join('\n').length + tail.join('\n').length;
	for (let i = 0; i < sections.length; i++) {
		const block = sections[i]!.join('\n');
		if (length + block.length + 1 > maxLength) {
			out.push(
				'',
				`…truncated: ${sections.length - i} more entries. The full digest is in the build run's summary.`
			);
			break;
		}
		out.push(block);
		length += block.length + 1;
	}
	out.push(...tail);
	return { markdown: out.join('\n'), changed };
}
