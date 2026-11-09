import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun';

const report = join(import.meta.dir, 'bundle-report.mjs');
const version = '2026.11.2';

async function runReport({ build = true, asset, payload, omit } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'ceraui-bundle-report-'));
	try {
		writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
		if (build) {
			const dir = join(root, 'dist/federation', version);
			mkdirSync(dir, { recursive: true });
			const graph = {};
			for (const name of ['audio.js', 'encoder.js', 'server.js', 'frontend.css']) {
				if (name === omit) continue;
				writeFileSync(join(dir, name), name === asset ? payload : 'export {};');
				graph[name] = { file: name };
			}
			if (asset && !(asset in graph)) {
				writeFileSync(join(dir, asset), payload);
				graph.extra = { file: asset };
				graph['audio.js'].imports = ['extra'];
			}
			writeFileSync(join(dir, 'federation-build.json'), JSON.stringify(graph));
		}
		const child = spawn([process.execPath, report, '--federation-only'], {
			cwd: root,
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exit };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('publication checks federation budgets without requiring SPA artifacts', async () => {
	const { exit, stdout, stderr } = await runReport();
	expect(exit, stderr).toBe(0);
	expect(stdout).toContain('federation audio.js');
	expect(stdout).not.toContain('skipped');
});

test('publication fails closed when federation artifacts are absent', async () => {
	const { exit, stderr } = await runReport({ build: false });
	expect(exit).toBe(1);
	expect(stderr).toContain('federation output missing:');
});

test('publication rejects a partial federation build', async () => {
	const { exit, stderr } = await runReport({
		omit: 'audio.js',
	});
	expect(exit).toBe(1);
	expect(stderr).toContain('missing federation entry audio.js');
});

test('publication rejects an executable with no budget baseline', async () => {
	const { exit, stderr } = await runReport({
		asset: 'new-feature-QWERTY12.js',
		payload: 'export {};',
	});
	expect(exit).toBe(1);
	expect(stderr).toContain('no baseline for stem new-feature.js');
});

for (const [asset, bytes] of [
	['toast-host-a_bCdE1-.js', 800_000],
	['audio.js', 9_000],
]) {
	test(`publication rejects ${asset} above its gzip budget`, async () => {
		const payload = createHash('shake256', { outputLength: bytes })
			.update('budget fixture')
			.digest();
		const { exit, stderr } = await runReport({ asset, payload });
		expect(exit).toBe(1);
		expect(stderr).toContain(
			`federation ${asset.startsWith('toast-host-') ? 'toast-host.js' : asset}:`,
		);
		expect(stderr).toContain('exceeds the');
	});
}
