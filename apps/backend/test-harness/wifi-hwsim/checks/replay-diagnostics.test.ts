import { expect, spyOn, test } from 'bun:test';
import { AssertionError } from 'node:assert';
import { loadReplayCorpus, sampleText } from './replay-corpus.ts';
import { runFirstAp } from './first-ap-diagnostics.ts';

test('the actual first-AP diagnostic boundary reports recorded data shapes without dumping values', async () => {
	const corpus = await loadReplayCorpus();
	const phy = corpus.manifest.samples.find((row) => row.kind === 'iw-phy');
	const state = corpus.manifest.captures.find((row) => row.file.endsWith('native.json'));
	const journal = corpus.manifest.samples.find((row) => row.kind === 'journal');
	if (!phy || !state || !journal) throw new Error('Missing recorded diagnostic shapes');
	const native: unknown = JSON.parse(corpus.text.get(state.file) ?? '');
	const entry: unknown = JSON.parse(sampleText(corpus, journal).split('\n')[0] ?? '');
	const values: readonly { readonly value: unknown; readonly shape: unknown }[] = [
		{ value: sampleText(corpus, phy), shape: { kind: 'string' } },
		{ value: native, shape: { kind: 'array', length: Array.isArray(native) ? native.length : 0 } },
		{ value: entry, shape: { kind: 'object' } },
	];
	for (const row of values) {
		const error = spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await runFirstAp(async () => {
				throw new AssertionError({ actual: row.value, expected: true, operator: 'strictEqual' });
			});
			expect(result).toBe(false);
			expect(error.mock.calls).toEqual([
				[
					'first-ap: FAIL',
					{
						phase: 'preflight',
						check: 'vm-preconditions',
						kind: 'assertion',
						actual: row.shape,
						expected: { kind: 'boolean' },
					},
				],
			]);
		} finally {
			error.mockRestore();
		}
	}
});
