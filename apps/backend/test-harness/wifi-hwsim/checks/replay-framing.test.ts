import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadReplayCorpus } from './replay-corpus.ts';
import { nativeStartConfirmation } from './native-terminal.ts';
import { stateSchema } from './hybrid-observations.ts';
import { parseNmcliFields } from '../../../src/modules/network/network-manager-output.ts';

test('the unchanged framing byte verifier rejects loss of the value LF', async () => {
	const source = await readFile(resolve(import.meta.dir, '../framing.sh'), 'utf8');
	const python = source.split("<<'FRAMING'\n")[1]?.split('\nFRAMING\n')[0];
	if (!python) throw new Error('Missing live framing verifier');
	const corpus = await loadReplayCorpus();
	const name = corpus.manifest.samples.find((row) => row.kind === 'nm-add')?.expected.name;
	if (typeof name !== 'string') throw new Error('Missing captured connection name');
	const root = await mkdtemp(join(tmpdir(), 'native-framing-replay-'));
	try {
		// Derived protocol controls: the guest never retained raw named-field stdout.
		const plain = `connection.id:${name}\nconnection.autoconnect:no\n`;
		expect(
			parseNmcliFields(plain, ['connection.id', 'connection.autoconnect'])?.get('connection.id'),
		).toBe(name);
		expect(
			parseNmcliFields(`connection.id:${name}\n\nconnection.autoconnect:no\n`, [
				'connection.id',
				'connection.autoconnect',
			])?.get('connection.id'),
		).toBe(`${name}\n`);
		await writeFile(join(root, 'plain'), plain);
		await writeFile(
			join(root, 'trailing-lf'),
			`connection.id:${name}\n\nconnection.autoconnect:no\n`,
		);
		const run = async () => {
			const child = Bun.spawn(['python3', '-c', python, root, name], {
				env: process.env,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 3000,
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, code };
		};
		expect((await run()).code).toBe(0);
		await writeFile(join(root, 'trailing-lf'), plain);
		const rejected = await run();
		expect(rejected.code).toBe(69);
		expect(rejected.stdout).toContain('B7_FRAMING_PROBE_CONTRACT=FAIL case=trailing-lf');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the actual terminal decoder rejects unrelated real journal frames', async () => {
	const corpus = await loadReplayCorpus();
	for (const sample of corpus.manifest.samples.filter((row) => row.kind === 'journal')) {
		const text = corpus.text.get(sample.file);
		if (!text) throw new Error('Missing captured journal');
		for (const line of text.trim().split('\n')) {
			expect(nativeStartConfirmation(line, 0)).toBeUndefined();
			expect(stateSchema.safeParse(JSON.parse(line)).success).toBe(false);
		}
	}
	// No native terminal broadcast was captured; these are schema/selection controls.
	const terminal = { device: 0, success: true };
	expect(
		nativeStartConfirmation(JSON.stringify({ wifi: { hotspot: { start: terminal } } }), 0),
	).toEqual({ success: true });
	expect(
		nativeStartConfirmation(JSON.stringify({ wifi: { hotspot: { start: terminal } } }), 1),
	).toBeUndefined();
	expect(
		nativeStartConfirmation(
			JSON.stringify({ wifi: { hotspot: { start: { ...terminal, accepted: true } } } }),
			0,
		),
	).toBeUndefined();
});
