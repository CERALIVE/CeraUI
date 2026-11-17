import { existsSync } from 'node:fs';
import { spawn } from 'bun';

const SUBSET = [
	'audio-mixer',
	'layout-designer',
	'live',
	'network',
	'settings',
	'signal-indicator',
].map((name) => `tests/e2e/visual/${name}.visual.spec.ts`);

export function visualSpecs(changedSnapshots) {
	if (
		!Array.isArray(changedSnapshots) ||
		changedSnapshots.some((path) => typeof path !== 'string')
	) {
		throw new Error('CHANGED_SNAPSHOTS must be a JSON array of paths');
	}
	const owners = changedSnapshots
		.map((path) => {
			const match =
				/^apps\/frontend\/(tests\/e2e\/(?:[\w-]+\/)*[\w.-]+\.spec\.ts)-snapshots\/[^/]+\.png$/u.exec(
					path,
				);
			if (!match) throw new Error(`Invalid snapshot path: ${path}`);
			return match[1];
		})
		.filter((path) => existsSync(new URL(`../../apps/frontend/${path}`, import.meta.url)));
	return [...new Set([...SUBSET, ...owners])];
}

if (import.meta.main) {
	const specs = visualSpecs(JSON.parse(process.env.CHANGED_SNAPSHOTS ?? '[]'));
	process.stdout.write(`Visual PR specs:\n${specs.join('\n')}\n`);
	const child = spawn(
		[
			'bun',
			'run',
			'--filter',
			'frontend',
			'test:e2e',
			'--',
			...specs.map((path) => `${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`),
			...process.argv.slice(2),
		],
		{
			cwd: new URL('../../', import.meta.url).pathname,
			env: process.env,
			stdout: 'inherit',
			stderr: 'inherit',
		},
	);
	process.exit(await child.exited);
}
