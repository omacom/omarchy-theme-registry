/**
 * Sync dist/ to the R2 bucket (S3 API). Only changed objects are uploaded; preview objects live
 * under an immutable per-commit key so they get a long cache lifetime, JSON gets a short one.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   node scripts/upload.ts            # upload
 *   node scripts/upload.ts --dry-run
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DIST_DIR, log, mapLimit } from './lib.ts';

const dryRun = process.argv.includes('--dry-run');
const env = (k: string) => {
	const v = process.env[k];
	if (!v && !dryRun) throw new Error(`Missing env ${k}`);
	return v ?? '';
};
const bucket = env('R2_BUCKET');
const client = dryRun
	? null
	: new S3Client({
			region: 'auto',
			maxAttempts: 5,
			endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: env('R2_ACCESS_KEY_ID'),
				secretAccessKey: env('R2_SECRET_ACCESS_KEY')
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

const files: string[] = [];
for await (const f of walk(DIST_DIR)) files.push(f);

// Upload previews first, then JSON last, so a catalog never references a missing image.
files.sort((a, b) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')));

let uploaded = 0;
let skipped = 0;
await mapLimit(files, 8, async (abs) => {
	const key = relative(DIST_DIR, abs).split('\\').join('/');
	const body = await readFile(abs);
	const md5 = createHash('md5').update(body).digest('hex');
	const immutable = key.includes('/previews/');
	const cacheControl = immutable
		? 'public, max-age=31536000, immutable'
		: 'public, max-age=300, stale-while-revalidate=3600';
	if (client) {
		try {
			const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
			if (head.ETag?.replaceAll('"', '') === md5) {
				skipped++;
				return;
			}
		} catch {
			/* not found → upload */
		}
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: body,
				ContentType: CONTENT_TYPES[extname(key)] ?? 'application/octet-stream',
				CacheControl: cacheControl
			})
		);
	} else {
		const { size } = await stat(abs);
		log(`would upload ${key} (${size} B, ${cacheControl})`);
	}
	uploaded++;
});
log(`Uploaded ${uploaded}, unchanged ${skipped}`);
