import { repoOwnerAndName } from './slug.ts';

export interface RepoMeta {
	/** GitHub's numeric repository id: survives renames and transfers, never reused */
	id: number;
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

	#get(path: string): Promise<Response> {
		return this.#request(path);
	}

	async #request(path: string, body?: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			'user-agent': this.#ua,
			'x-github-api-version': '2022-11-28'
		};
		if (this.#token) headers.authorization = `Bearer ${this.#token}`;
		const init: RequestInit =
			body === undefined
				? { headers }
				: {
						method: 'POST',
						headers: { ...headers, 'content-type': 'application/json' },
						body: JSON.stringify(body)
					};
		let res: Response | null = null;
		let lastErr: unknown = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
			try {
				res = await this.#fetch(`https://api.github.com${path}`, init);
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
		if (res.status === 404 || res.status === 451) return missingMeta(canonicalUrl);
		if (!res.ok) throw new Error(`GitHub ${res.status} for ${owner}/${name}`);
		const j = (await res.json()) as {
			id: number;
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
			id: j.id,
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

	/**
	 * Metadata and default-branch HEAD for many repos, keyed by the URL asked for: one GraphQL
	 * request per {@link REPOS_PER_QUERY} repos instead of two REST calls each. A repo GitHub cannot
	 * find comes back `missing`, like {@link repo}; an Error means GitHub could not be asked (rate
	 * limit, outage) and says nothing about the repo. GraphQL needs a token, so without one this
	 * falls back to REST.
	 */
	async repos(canonicalUrls: string[]): Promise<Map<string, RepoSnapshot | Error>> {
		const out = new Map<string, RepoSnapshot | Error>();
		const urls = [...new Set(canonicalUrls)];
		for (let i = 0; i < urls.length; i += REPOS_PER_QUERY) {
			const chunk = urls.slice(i, i + REPOS_PER_QUERY);
			if (!this.#token) {
				for (const url of chunk) out.set(url, await this.#restSnapshot(url).catch(toError));
				continue;
			}
			try {
				for (const [url, snap] of await this.#graphqlSnapshots(chunk)) out.set(url, snap);
			} catch (e) {
				for (const url of chunk) out.set(url, toError(e));
			}
		}
		return out;
	}

	async #restSnapshot(url: string): Promise<RepoSnapshot> {
		const meta = await this.repo(url);
		if (meta.missing) return { meta, headSha: null };
		return { meta, headSha: await this.headSha(meta.htmlUrl, meta.defaultBranch) };
	}

	async #graphqlSnapshots(urls: string[]): Promise<Map<string, RepoSnapshot | Error>> {
		const variables: Record<string, string> = {};
		const params: string[] = [];
		const fields: string[] = [];
		urls.forEach((url, i) => {
			const { owner, name } = repoOwnerAndName(url);
			variables[`o${i}`] = owner;
			variables[`n${i}`] = name;
			params.push(`$o${i}: String!, $n${i}: String!`);
			fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...Repo }`);
		});
		const query = `query(${params.join(', ')}) { ${fields.join(' ')} }\n${REPO_FRAGMENT}`;
		const res = await this.#request('/graphql', { query, variables });
		if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
		const j = (await res.json()) as {
			data?: Record<string, GraphqlRepo | null> | null;
			errors?: { type?: string; path?: (string | number)[]; message: string }[];
		};
		const errorFor = new Map<string, { type?: string; message: string }>();
		for (const e of j.errors ?? []) {
			const alias = e.path?.[0];
			if (typeof alias === 'string') errorFor.set(alias, e);
			// an error tied to no repo (rate limit, bad query) fails the whole request
			else throw new Error(`GitHub GraphQL: ${e.message}`);
		}
		if (!j.data) throw new Error('GitHub GraphQL returned no data');

		const out = new Map<string, RepoSnapshot | Error>();
		urls.forEach((url, i) => {
			const node = j.data![`r${i}`];
			const error = errorFor.get(`r${i}`);
			if (node) out.set(url, snapshotFromGraphql(url, node));
			else if (!error || error.type === 'NOT_FOUND')
				out.set(url, { meta: missingMeta(url), headSha: null });
			else out.set(url, new Error(`GitHub GraphQL: ${error.message}`));
		});
		return out;
	}

	/**
	 * Files changed between two commits, or null when GitHub cannot compare them (a commit is gone
	 * after a force-push, or the request failed). GitHub lists at most 300 files.
	 */
	async compare(
		canonicalUrl: string,
		base: string,
		head: string
	): Promise<{ path: string; status: string; previous?: string }[] | null> {
		const { owner, name } = repoOwnerAndName(canonicalUrl);
		const res = await this.#get(`/repos/${owner}/${name}/compare/${base}...${head}?per_page=300`);
		if (!res.ok) return null;
		const j = (await res.json()) as {
			files?: { filename: string; status: string; previous_filename?: string }[];
		};
		return (j.files ?? []).map((f) =>
			f.previous_filename
				? { path: f.filename, status: f.status, previous: f.previous_filename }
				: { path: f.filename, status: f.status }
		);
	}

	async headSha(canonicalUrl: string, branch: string): Promise<string | null> {
		const { owner, name } = repoOwnerAndName(canonicalUrl);
		const res = await this.#get(`/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`);
		if (!res.ok) return null;
		const j = (await res.json()) as { sha: string };
		return j.sha;
	}
}

/** Repos per GraphQL request; each costs GitHub about one rate-limit point. */
const REPOS_PER_QUERY = 50;

const REPO_FRAGMENT = `fragment Repo on Repository {
	databaseId url name owner { login } description isPrivate isArchived isFork
	stargazerCount pushedAt createdAt diskUsage licenseInfo { spdxId }
	repositoryTopics(first: 20) { nodes { topic { name } } }
	defaultBranchRef { name target { oid } }
}`;

interface GraphqlRepo {
	databaseId: number;
	url: string;
	name: string;
	owner: { login: string };
	description: string | null;
	isPrivate: boolean;
	isArchived: boolean;
	isFork: boolean;
	stargazerCount: number;
	pushedAt: string | null;
	createdAt: string;
	diskUsage: number | null;
	licenseInfo: { spdxId: string | null } | null;
	repositoryTopics: { nodes: { topic: { name: string } }[] };
	defaultBranchRef: { name: string; target: { oid: string } | null } | null;
}

export interface RepoSnapshot {
	meta: RepoMeta;
	/** HEAD of the default branch (what `omarchy theme install` checks out); null for an empty repo */
	headSha: string | null;
}

function snapshotFromGraphql(requested: string, r: GraphqlRepo): RepoSnapshot {
	const spdx = r.licenseInfo?.spdxId ?? null;
	return {
		meta: {
			id: r.databaseId,
			owner: r.owner.login,
			name: r.name,
			htmlUrl: r.url,
			description: r.description,
			isPrivate: r.isPrivate,
			isArchived: r.isArchived,
			isFork: r.isFork,
			defaultBranch: r.defaultBranchRef?.name ?? 'main',
			stars: r.stargazerCount,
			pushedAt: r.pushedAt ?? r.createdAt,
			createdAt: r.createdAt,
			license: spdx && spdx !== 'NOASSERTION' ? spdx : null,
			topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
			sizeKb: r.diskUsage ?? 0,
			missing: false,
			movedTo: r.url.toLowerCase() !== requested.toLowerCase() ? r.url : null
		},
		headSha: r.defaultBranchRef?.target?.oid ?? null
	};
}

function missingMeta(canonicalUrl: string): RepoMeta {
	const { owner, name } = repoOwnerAndName(canonicalUrl);
	return {
		id: 0,
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

function toError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}
