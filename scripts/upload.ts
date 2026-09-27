/**
 * Sync dist/v1/ to the R2 bucket (S3 API), so the bucket holds only what is live. Only changed
 * objects are uploaded; preview objects live under an immutable per-commit key so they get a
 * long cache lifetime, JSON gets a short one.
 *
 * After uploading, anything under v1/ that this build did not produce is deleted: the files of a
 * theme that left the catalog, and anything no longer published. Every submitted theme stays in
 * themes/ in this repo; only what is live is on the CDN. Previews of older commits of a listed
 * theme are kept, because the "Catalog changes" issue shows them as the "before" image.
 *
 * A build that lists far fewer themes than the bucket does is refused before anything is sent,
 * so a broken build cannot replace the live catalog or empty the bucket.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   node scripts/upload.ts             # upload, then prune
 *   node scripts/upload.ts --dry-run   # say what would change (lists the bucket if the R2_* env is set)
 *   node scripts/upload.ts --force     # publish even though the catalog shrank sharply
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import {
	DeleteObjectsCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { DIST_DIR, log, mapLimit } from './lib.ts';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

/**
 * A build that loses more than this share of the themes already on the bucket, and more than a
 * handful of them, is more likely broken (a GitHub outage, a bad release) than a run of artists
 * breaking their repos at once. It is refused: nothing is uploaded or deleted, and the step fails.
 */
const MAX_SHRINK = 0.1;
const MAX_SHRINK_COUNT = 5;

const R2_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
const missingEnv = R2_ENV.filter((k) => !process.env[k]);
if (missingEnv.length && !dryRun) throw new Error(`Missing env ${missingEnv.join(', ')}`);
const bucket = process.env.R2_BUCKET ?? '';
const client = missingEnv.length
	? null
	: new S3Client({
			region: 'auto',
			maxAttempts: 5,
			endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: process.env.R2_ACCESS_KEY_ID!,
				secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
			}
		});

const CONTENT_TYPES: Record<string, string> = {
	'.json': 'application/json; charset=utf-8',
	'.webp': 'image/webp',
	'.sha256': 'text/plain; charset=utf-8'
};

async function* walk(dir: string): AsyncGenerator<string> {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

// Only v1/ is published; dist/report.json and anything else beside it is for maintainers.
const files: string[] = [];
for await (const f of walk(join(DIST_DIR, 'v1'))) files.push(f);
const keyOf = (abs: string) => relative(DIST_DIR, abs).split('\\').join('/');

// ── what is live now ─────────────────────────────────────────────────────
const built = new Set(files.map(keyOf));
const live = new Set(
	[...built].flatMap((k) => (/^v1\/themes\/[^/]+\.json$/.test(k) ? [k.slice(10, -5)] : []))
);

const existing: string[] = [];
if (client) {
	let token: string | undefined;
	do {
		const page = await client.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: 'v1/', ContinuationToken: token })
		);
		for (const o of page.Contents ?? []) if (o.Key) existing.push(o.Key);
		token = page.NextContinuationToken;
	} while (token);

	const listedBefore = existing.filter((k) => /^v1\/themes\/[^/]+\.json$/.test(k)).length;
	const lost = listedBefore - live.size;
	if (!force && lost > MAX_SHRINK_COUNT && lost > listedBefore * MAX_SHRINK) {
		log(
			`Refusing to publish: this build lists ${live.size} themes, ${lost} fewer than the ${listedBefore} live now. ` +
				'That looks like a broken build rather than artists; the live catalog is left as it is. ' +
				'Run with --force if the drop is intended.'
		);
		process.exit(1);
	}
}

// Previews first, then JSON, so a catalog never references a missing image; the catalog's hash
// last, so it never describes a catalog that is not up yet.
const order = (f: string) => (f.endsWith('.sha256') ? 2 : f.endsWith('.json') ? 1 : 0);
files.sort((a, b) => order(a) - order(b));

let uploaded = 0;
let skipped = 0;
await mapLimit(files, 8, async (abs) => {
	const key = keyOf(abs);
	const body = await readFile(abs);
	const md5 = createHash('md5').update(body).digest('hex');
	const immutable = key.includes('/previews/');
	const cacheControl = immutable
		? 'public, max-age=31536000, immutable'
		: 'public, max-age=300, stale-while-revalidate=3600';
	if (dryRun) {
		const { size } = await stat(abs);
		log(`would upload ${key} (${size} B, ${cacheControl})`);
	} else {
		try {
			const head = await client!.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
			if (head.ETag?.replaceAll('"', '') === md5) {
				skipped++;
				return;
			}
		} catch {
			/* not found → upload */
		}
		await client!.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: body,
				ContentType: CONTENT_TYPES[extname(key)] ?? 'application/octet-stream',
				CacheControl: cacheControl
			})
		);
	}
	uploaded++;
});
log(`${dryRun ? 'Would upload' : 'Uploaded'} ${uploaded}, unchanged ${skipped}`);

// ── prune ────────────────────────────────────────────────────────────────
if (!client) {
	log('Prune skipped: listing the bucket needs the R2_* env.');
	process.exit(0);
}

const stale = existing.filter((key) => {
	if (built.has(key)) return false;
	const preview = /^v1\/previews\/([^/]+)\//.exec(key);
	return !(preview && live.has(preview[1]!));
});

if (dryRun) {
	for (const key of stale) log(`would delete ${key}`);
} else {
	for (let i = 0; i < stale.length; i += 1000) {
		const batch = stale.slice(i, i + 1000);
		const res = await client.send(
			new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
			})
		);
		if (res.Errors?.length)
			throw new Error(
				`Could not delete ${res.Errors.length} objects: ${res.Errors.slice(0, 3)
					.map((e) => `${e.Key} (${e.Message})`)
					.join(', ')}`
			);
	}
}
log(`${dryRun ? 'Would delete' : 'Deleted'} ${stale.length} objects no longer live`);
