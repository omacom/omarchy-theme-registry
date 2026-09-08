import { MAX_TAGS, TAG_DENYLIST, TAG_DENY_PATTERN, TAG_RE } from '@omarchy-themes/schema';

/**
 * Catalog tags for a theme: curator tags from the registry entry first, then the repo's
 * GitHub topics with the boilerplate removed (`omarchy-theme`, `hyprland`, `dark`…), the
 * `omarchy-` prefix / `-theme` suffix stripped, and anything that just repeats the slug dropped.
 */
export function deriveTags(opts: {
	topics: readonly string[];
	entryTags?: readonly string[] | undefined;
	slug: string;
}): string[] {
	const out: string[] = [];
	const push = (raw: string) => {
		const tag = normalizeTag(raw);
		if (!tag || out.includes(tag)) return;
		if (TAG_DENYLIST.has(tag) || TAG_DENY_PATTERN.test(tag)) return;
		if (tag === opts.slug || tag.replaceAll('-', '') === opts.slug.replaceAll('-', '')) return;
		if (out.length < MAX_TAGS) out.push(tag);
	};
	for (const t of opts.entryTags ?? []) push(t);
	for (const t of opts.topics) push(t);
	return out;
}

export function normalizeTag(raw: string): string | null {
	let tag = raw
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
	tag = tag.replace(/^omarchy-/, '').replace(/-themes?$/, '');
	return TAG_RE.test(tag) ? tag : null;
}
