import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const sampleSchema = z.object({
	id: z.string(),
	run: z.enum(['r19', 'r20', 'r21']),
	kind: z.enum([
		'nm-add',
		'iw-phy',
		'iw-dev',
		'rfkill',
		'nm-devices',
		'os',
		'environment',
		'permissions',
		'systemd',
		'versions',
		'audit-json',
		'journal',
		'ps',
		'keyfile',
		'cloud-init',
	]),
	file: z.string(),
	origins: z.array(z.string()),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	expected: z.record(z.string(), z.unknown()),
	complete: z.boolean().optional(),
	capturedCharacters: z.number().optional(),
	omittedCharacters: z.number().optional(),
	finalNewlineAdded: z.boolean().optional(),
});
const corpusSchema = z.object({
	schema: z.literal(1),
	base: z.string(),
	captures: z.array(
		z.object({
			file: z.string(),
			origin: z.string(),
			sha256: z.string(),
			sourceSha256: z.string(),
		}),
	),
	samples: z.array(sampleSchema),
});
export type ReplaySample = z.infer<typeof sampleSchema>;
export type ReplayCorpus = {
	readonly manifest: z.infer<typeof corpusSchema>;
	readonly text: ReadonlyMap<string, string>;
};

export async function loadReplayCorpus(): Promise<ReplayCorpus> {
	const root = resolve(import.meta.dir, '../replay-corpus');
	const manifest = corpusSchema.parse(
		JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')),
	);
	const text = new Map<string, string>();
	for (const entry of [...manifest.captures, ...manifest.samples]) {
		const path = resolve(root, entry.file);
		if (!path.startsWith(`${root}/`)) throw new Error('Replay path escapes corpus');
		const data = await readFile(path, 'utf8');
		if (new Bun.CryptoHasher('sha256').update(data).digest('hex') !== entry.sha256)
			throw new Error(`Replay hash mismatch: ${entry.file}`);
		if (
			data.includes('ceratest1234') ||
			data.includes('.omo') ||
			/-----BEGIN (?:[A-Z ]*PRIVATE KEY)/.test(data)
		)
			throw new Error(`Unsafe replay bytes: ${entry.file}`);
		text.set(entry.file, data);
	}
	if (new Set(manifest.samples.map((sample) => sample.id)).size !== manifest.samples.length)
		throw new Error('Duplicate replay sample ID');
	return { manifest, text };
}

export function sampleText(corpus: ReplayCorpus, sample: ReplaySample): string {
	const text = corpus.text.get(sample.file);
	if (text === undefined) throw new Error(`Missing replay sample ${sample.id}`);
	return text;
}

/** Decode the seven real version replies, not the shell transcript as executable code. */
export function versionReplies(text: string): Readonly<
	Record<
		string,
		{
			readonly output: string;
			readonly code: number;
		}
	>
> {
	const rows: Record<string, { output: string; code: number }> = {};
	let output: string[] = [];
	for (const line of text.split('\n')) {
		const marker = /^HWSIM-VERSION: (\w+) exit=(\d+) passed=[01]$/.exec(line);
		if (marker?.[1] && marker[2]) {
			rows[marker[1]] = { output: `${output.join('\n')}\n`, code: Number(marker[2]) };
			output = [];
		} else output.push(line);
	}
	return rows;
}
