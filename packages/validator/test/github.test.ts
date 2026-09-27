import { describe, expect, it } from 'vitest';
import { GithubClient, type RepoSnapshot } from '../src/github.ts';

const node = (owner: string, name: string, over: Record<string, unknown> = {}) => ({
	databaseId: 7,
	url: `https://github.com/${owner}/${name}`,
	name,
	owner: { login: owner },
	description: 'a theme',
	isPrivate: false,
	isArchived: false,
	isFork: false,
	stargazerCount: 3,
	pushedAt: '2026-09-01T00:00:00Z',
	createdAt: '2026-08-01T00:00:00Z',
	diskUsage: 1636,
	licenseInfo: { spdxId: 'MIT' },
	repositoryTopics: { nodes: [{ topic: { name: 'omarchy-theme' } }] },
	defaultBranchRef: { name: 'main', target: { oid: 'a'.repeat(40) } },
	...over
});

/** A fetch that answers every GraphQL request with `respond(variables)`, recording the calls. */
function fakeGraphql(respond: (variables: Record<string, string>) => unknown, status = 200) {
	const calls: Record<string, string>[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const { variables } = JSON.parse(init.body as string) as { variables: Record<string, string> };
		calls.push(variables);
		return new Response(JSON.stringify(respond(variables)), { status });
	}) as typeof fetch;
	return { client: new GithubClient({ token: 't', fetchImpl }), calls };
}

const snap = (v: RepoSnapshot | Error | undefined) => {
	if (!v || v instanceof Error) throw new Error(`expected a snapshot, got ${String(v)}`);
	return v;
};

describe('GithubClient.repos', () => {
	it('maps each repo to its metadata and default-branch HEAD', async () => {
		const { client } = fakeGraphql(() => ({ data: { r0: node('alice', 'omarchy-x-theme') } }));
		const out = await client.repos(['https://github.com/alice/omarchy-x-theme']);
		const s = snap(out.get('https://github.com/alice/omarchy-x-theme'));
		expect(s.headSha).toBe('a'.repeat(40));
		expect(s.meta).toMatchObject({
			id: 7,
			owner: 'alice',
			defaultBranch: 'main',
			stars: 3,
			sizeKb: 1636,
			license: 'MIT',
			topics: ['omarchy-theme'],
			missing: false,
			movedTo: null
		});
	});

	it('reports a renamed repo as moved', async () => {
		const { client } = fakeGraphql(() => ({ data: { r0: node('bob', 'omarchy-x-theme') } }));
		const out = await client.repos(['https://github.com/old-bob/omarchy-x-theme']);
		expect(snap(out.get('https://github.com/old-bob/omarchy-x-theme')).meta.movedTo).toBe(
			'https://github.com/bob/omarchy-x-theme'
		);
	});

	it('marks a repo GitHub cannot find as missing, not as an error', async () => {
		const { client } = fakeGraphql(() => ({
			data: { r0: null },
			errors: [{ type: 'NOT_FOUND', path: ['r0'], message: 'Could not resolve' }]
		}));
		const out = await client.repos(['https://github.com/x/gone']);
		expect(snap(out.get('https://github.com/x/gone')).meta.missing).toBe(true);
	});

	it('turns a failed request into an Error for every repo in it', async () => {
		const { client } = fakeGraphql(
			() => ({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
			200
		);
		const out = await client.repos(['https://github.com/a/one', 'https://github.com/a/two']);
		expect(out.get('https://github.com/a/one')).toBeInstanceOf(Error);
		expect(out.get('https://github.com/a/two')).toBeInstanceOf(Error);
	});

	it('batches 50 repos per request and passes names as variables', async () => {
		const urls = Array.from({ length: 120 }, (_, i) => `https://github.com/o/r${i}`);
		const { client, calls } = fakeGraphql((v) => ({
			data: Object.fromEntries(
				Object.keys(v)
					.filter((k) => k.startsWith('o'))
					.map((k) => [`r${k.slice(1)}`, node(v[k]!, v[`n${k.slice(1)}`]!)])
			)
		}));
		const out = await client.repos(urls);
		expect(calls).toHaveLength(3);
		expect(calls[2]!.n19).toBe('r119');
		expect(snap(out.get('https://github.com/o/r119')).meta.name).toBe('r119');
	});

	it('gives an empty repo no HEAD', async () => {
		const { client } = fakeGraphql(() => ({
			data: { r0: node('a', 'empty', { defaultBranchRef: null, pushedAt: null }) }
		}));
		const s = snap(
			(await client.repos(['https://github.com/a/empty'])).get('https://github.com/a/empty')
		);
		expect(s.headSha).toBeNull();
		expect(s.meta.pushedAt).toBe('2026-08-01T00:00:00Z');
	});
});
