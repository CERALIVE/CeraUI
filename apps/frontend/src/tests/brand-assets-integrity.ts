import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

function record(value: unknown): value is {
	readonly [K in
		| 'schema'
		| 'files'
		| 'tag'
		| 'commit'
		| 'tarballSha256'
		| 'to'
		| 'sha256']?: unknown;
} {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function verifyBrandAssets(repoRoot: string): string[] {
	const problems: string[] = [];
	const root = resolve(repoRoot);
	let lock: unknown;
	try {
		lock = JSON.parse(readFileSync(join(root, 'brand-assets.lock.json'), 'utf8'));
	} catch (error) {
		return [
			`Cannot read brand-assets.lock.json: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
	if (!record(lock) || lock.schema !== 1 || !Array.isArray(lock.files)) {
		return ['Invalid schema-1 brand-assets.lock.json'];
	}
	for (const [key, pattern] of [
		['tag', /^v\d{4}\.\d{1,2}\.\d+$/],
		['commit', /^[a-fA-F0-9]{40}$/],
		['tarballSha256', /^[a-fA-F0-9]{64}$/],
	] as const) {
		if (typeof lock[key] !== 'string' || !pattern.test(lock[key]))
			problems.push(`Invalid lock ${key}`);
	}
	let notice = new Set<string>();
	try {
		notice = new Set(readFileSync(join(root, 'BRAND-ASSETS-NOTICE.md'), 'utf8').split(/\r?\n/));
	} catch (error) {
		problems.push(
			`Cannot read BRAND-ASSETS-NOTICE.md: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const locked = new Set<string>();
	const brandDirs = new Set<string>();
	for (const entry of lock.files) {
		if (!record(entry) || typeof entry.to !== 'string') {
			problems.push('Invalid lock file entry');
			continue;
		}
		const to = entry.to;
		if (
			!to ||
			isAbsolute(to) ||
			win32.isAbsolute(to) ||
			to.includes('\\') ||
			to.includes('\0') ||
			to.split('/').includes('..')
		) {
			problems.push(`Unsafe lock destination: ${to}`);
			continue;
		}
		const path = resolve(root, to);
		locked.add(path);
		if (`/${relative(root, path)}`.includes('/brand/')) brandDirs.add(dirname(path));
		if (!notice.has(`- ${to}`)) problems.push(`Missing notice entry: ${to}`);
		try {
			if (!lstatSync(path).isFile()) {
				problems.push(`Non-regular brand asset: ${to}`);
				continue;
			}
			const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
			if (hash !== entry.sha256) problems.push(`sha256 mismatch: ${to}`);
		} catch (error) {
			problems.push(`Cannot read ${to}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const directory of brandDirs) {
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (!entry.isDirectory() && !locked.has(path)) {
					problems.push(`Orphan brand asset: ${relative(root, path)}`);
				}
			}
		} catch (error) {
			problems.push(
				`Cannot scan ${relative(root, directory)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return problems;
}
