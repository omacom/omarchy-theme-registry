import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Checkout {
	dir: string;
	sha: string;
	cleanup: () => Promise<void>;
}

/**
 * Clone a repo into a temp dir. If `sha` is given, fetch and check out exactly that commit;
 * otherwise a depth-1 clone of the default branch. Never runs hooks or reads repo config
 * (`-c core.hooksPath=/dev/null`, no submodules).
 */
export async function cloneRepo(
	repoUrl: string,
	opts: { sha?: string | undefined; baseDir?: string | undefined; timeoutMs?: number } = {}
): Promise<Checkout> {
	const base = opts.baseDir ?? (await mkdtemp(join(tmpdir(), 'omarchy-theme-')));
	const dir = opts.baseDir ? base : base;
	const timeout = opts.timeoutMs ?? 120_000;
	const git = (args: string[], cwd?: string) =>
		exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], {
			cwd,
			timeout,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
		});

	if (opts.sha) {
		await git(['init', '-q', dir]);
		await git(['remote', 'add', 'origin', repoUrl], dir);
		await git(['fetch', '-q', '--depth', '1', 'origin', opts.sha], dir);
		await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
	} else {
		await git(['clone', '-q', '--depth', '1', '--no-tags', '--', repoUrl, dir]);
	}
	const { stdout } = await git(['rev-parse', 'HEAD'], dir);
	return {
		dir,
		sha: stdout.trim(),
		cleanup: () => rm(base, { recursive: true, force: true })
	};
}
