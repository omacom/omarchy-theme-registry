import { SLUG_RE } from '@omarchy-themes/schema';

/**
 * Mirrors `bin/omarchy-theme-install`:
 *   REPO_PATH="$REPO_URL"; strip scp-like host prefix
 *   THEME_NAME=$(basename -- "$REPO_PATH" .git | sed -E 's/^omarchy-//; s/-theme$//' | tr '[:upper:]' '[:lower:]')
 */
export function deriveSlug(repoUrl: string): string {
	let path = repoUrl.trim();
	// scp-like: git@github.com:owner/repo.git → owner/repo.git
	if (!path.includes('://') && path.includes(':') && !path.split(':')[0]!.includes('/')) {
		path = path.slice(path.indexOf(':') + 1);
	}
	path = path.replace(/\/+$/, '');
	let base = path.slice(path.lastIndexOf('/') + 1);
	if (base.endsWith('.git')) base = base.slice(0, -4);
	base = base.replace(/^omarchy-/, '').replace(/-theme$/, '');
	return base.toLowerCase();
}

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug);
}

/** Normalize any GitHub URL form to `https://github.com/<owner>/<repo>`. Returns null if not GitHub. */
export function canonicalRepoUrl(input: string): string | null {
	const s = input.trim();
	const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(s);
	if (scp) return `https://github.com/${scp[1]}/${scp[2]}`;
	try {
		const u = new URL(s);
		if (u.hostname.toLowerCase() !== 'github.com' && u.hostname.toLowerCase() !== 'www.github.com')
			return null;
		const parts = u.pathname.split('/').filter(Boolean);
		if (parts.length < 2) return null;
		const owner = parts[0]!;
		const repo = parts[1]!.replace(/\.git$/i, '');
		return `https://github.com/${owner}/${repo}`;
	} catch {
		return null;
	}
}

export function repoOwnerAndName(canonical: string): { owner: string; name: string } {
	const [, , , owner, name] = canonical.split('/');
	return { owner: owner!, name: name! };
}
