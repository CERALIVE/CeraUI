import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeNmcliShim } from './first-ap-nmcli-shim.ts';

for (const selector of [[], ['uuid']]) {
	test(`native activation refusal recognizes ${selector.length ? 'explicit UUID' : 'bare UUID'} selection`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'native-shim-target-'));
		const uuid = crypto.randomUUID();
		const argv = process.argv;
		const code = process.exitCode ?? 0;
		const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
			throw new Error('Blocked UUID reached the real nmcli boundary');
		});
		const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			await writeFile(
				join(root, 'state.json'),
				JSON.stringify({
					secret: crypto.randomUUID(),
					blocked: uuid,
				}),
			);
			process.argv = ['bun', 'shim', 'con', 'up', ...selector, uuid];

			await runNativeNmcliShim(root);

			expect(process.exitCode).toBe(10);
			const event: unknown = JSON.parse(await readFile(join(root, 'events.jsonl'), 'utf8'));
			expect(event).toEqual({
				kind: 'up',
				uuid,
				argvClean: true,
				environmentClean: true,
			});
		} finally {
			process.argv = argv;
			process.exitCode = code;
			stderr.mockRestore();
			spawn.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});
}
