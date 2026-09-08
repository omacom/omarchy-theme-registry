import { repoOwnerAndName } from './slug.ts';

export interface RepoMeta {
	owner: string;
	name: string;
	/** canonical https URL (follows renames) */
	htmlUrl: string;
	description: string | null;
	isPrivate: boolean;
	isArchived: boolean;
	isFork: boolean;
	defaultBranch: string;
	stars: number;
	pushedAt: string;
	createdAt: string;
	/** SPDX id or null */
	license: string | null;
	topics: string[];
	sizeKb: number;
	/** true if the API returned 404 / 451 */
	missing: boolean;
	/** repo was renamed/transferred: API's html_url differs from requested */
	movedTo: string | null;
}

export interface GithubClientOptions {
	token?: string | undefined;
	fetchImpl?: typeof fetch;
	userAgent?: string;
}

export class GithubClient {
	#token: string | undefined;
	#fetch: typeof fetch;
	#ua: string;

	constructor(opts: GithubClientOptions = {}) {
		this.#token = opts.token ?? process.env.GITHUB_TOKEN;
		this.#fetch = opts.fetchImpl ?? fetch;
		this.#ua = opts.userAgent ?? 'omarchy-themes-registry';
	}

	async #get(path: string): Promise<Response> {
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			'user-agent': this.#ua,
			'x-github-api-version': '2022-11-28'
		};
		if (this.#token) headers.authorization = `Bearer ${this.#token}`;
		let res: Response | null = null;
		let lastErr: unknown = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
			try {
				res = await this.#fetch(`https://api.github.com${path}`, { headers });
				if (res.status < 500) break; // retry only on 5xx
				lastErr = new Error(`GitHub ${res.status}`);
			} catch (e) {
				lastErr = e; // network error → retry
			}
		}
		if (!res || res.status >= 500) throw lastErr ?? new Error('GitHub request failed');
		if (res.status === 403 || res.status === 429) {
			const reset = res.headers.get('x-ratelimit-reset');
			throw new Error(
				`GitHub rate limit hit (${res.status}); resets at ${reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown'}`
			);
		}
		return res;
	}

	async repo(canonicalUrl: string): Promise<RepoMeta> {
		const { owner, name } = repoOwnerAndName(canonicalUrl);
		const res = await this.#get(`/repos/${owner}/${name}`);
		if (res.status === 404 || res.status === 451) {
			return {
				owner,
				name,
				htmlUrl: canonicalUrl,
				description: null,
				isPrivate: false,
				isArchived: false,
				isFork: false,
				defaultBranch: 'main',
				stars: 0,
				pushedAt: new Date(0).toISOString(),
				createdAt: new Date(0).toISOString(),
				license: null,
				topics: [],
				sizeKb: 0,
				missing: true,
				movedTo: null
			};
		}
		if (!res.ok) throw new Error(`GitHub ${res.status} for ${owner}/${name}`);
		const j = (await res.json()) as {
			html_url: string;
			description: string | null;
			private: boolean;
			archived: boolean;
			fork: boolean;
			default_branch: string;
			stargazers_count: number;
			pushed_at: string;
			created_at: string;
			license: { spdx_id: string } | null;
			topics?: string[];
			size: number;
			owner: { login: string };
			name: string;
		};
		const movedTo = j.html_url.toLowerCase() !== canonicalUrl.toLowerCase() ? j.html_url : null;
		return {
			owner: j.owner.login,
			name: j.name,
			htmlUrl: j.html_url,
			description: j.description,
			isPrivate: j.private,
			isArchived: j.archived,
			isFork: j.fork,
			defaultBranch: j.default_branch,
			stars: j.stargazers_count,
			pushedAt: j.pushed_at,
			createdAt: j.created_at,
			license: j.license && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : null,
			topics: j.topics ?? [],
			sizeKb: j.size,
			missing: false,
			movedTo
		};
	}

	/**
	 * Does `login` control `canonicalUrl`? True for the owning user, or a public member of the
	 * owning org. Private org members come back false (GITHUB_TOKEN cannot see them), so a
	 * false here means "not verified", not "not an owner".
	 */
	async controlsRepo(login: string, meta: RepoMeta): Promise<boolean> {
		if (meta.owner.toLowerCase() === login.toLowerCase()) return true;
		const res = await this.#get(
			`/orgs/${encodeURIComponent(meta.owner)}/public_members/${encodeURIComponent(login)}`
		);
		return res.status === 204;
	}

	/** Latest tag (by commit date) or null. Used to prefer tagged releases when picking a SHA. */
	async latestTag(canonicalUrl: string): Promise<{ name: string; sha: string } | null> {
		const { owner, name } = repoOwnerAndName(canonicalUrl);
		const res = await this.#get(`/repos/${owner}/${name}/tags?per_page=1`);
		if (!res.ok) return null;
		const tags = (await res.json()) as { name: string; commit: { sha: string } }[];
		const t = tags[0];
		return t ? { name: t.name, sha: t.commit.sha } : null;
	}

	async headSha(canonicalUrl: string, branch: string): Promise<string | null> {
		const { owner, name } = repoOwnerAndName(canonicalUrl);
		const res = await this.#get(`/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`);
		if (!res.ok) return null;
		const j = (await res.json()) as { sha: string };
		return j.sha;
	}
}
