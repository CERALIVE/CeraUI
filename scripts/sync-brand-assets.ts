import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { parseArgs } from 'node:util';

class SyncError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

function fail(code: number, message: string): never {
	throw new SyncError(code, message);
}

function safePath(path: string): boolean {
	return !!path && !win32.isAbsolute(path) && !/(^|\/)\.\.(\/|$)|[\\\0]/.test(path);
}

function sha256(path: string): string {
	return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

function record(value: unknown): value is {
	readonly [K in
		| 'schema'
		| 'files'
		| 'postSync'
		| 'from'
		| 'to'
		| 'sha256'
		| 'version'
		| 'commit']?: unknown;
} {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapping(value: unknown): value is { from: string; to: string; sha256: string } {
	return (
		record(value) &&
		typeof value.from === 'string' &&
		typeof value.to === 'string' &&
		typeof value.sha256 === 'string'
	);
}

function argv(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((part: unknown) => typeof part === 'string')
	);
}

function stat(path: string) {
	return fs.lstatSync(path, { throwIfNoEntry: false });
}

function execute(args: string[], code: number, message: string, inherit = false): string {
	try {
		const result = Bun.spawnSync(args, {
			cwd: process.cwd(),
			stdin: 'inherit',
			stdout: inherit ? 'inherit' : 'pipe',
			stderr: inherit ? 'inherit' : 'pipe',
			env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
			...(code === 3 ? { timeout: 30_000, killSignal: 'SIGKILL' } : {}),
		});
		if (result.exitCode !== 0) fail(code, message);
		return result.stdout?.toString() ?? '';
	} catch (error) {
		if (error instanceof SyncError) throw error;
		fail(code, message);
	}
}

function write(path: string, bytes: string): void {
	fs.rmSync(path, { force: true });
	fs.writeFileSync(path, bytes);
}

function destination(root: string, path: string): string {
	if (!safePath(path)) fail(5, `Unsafe destination: ${path}`);
	const target = resolve(root, path);
	let current = root;
	let deepest = root;
	for (const part of relative(root, target).split(sep)) {
		current = join(current, part);
		const info = stat(current);
		if (!info) continue;
		if (
			info.isSymbolicLink() ||
			(current !== target && !info.isDirectory()) ||
			(current === target && !info.isFile())
		)
			fail(5, `Unsafe destination: ${path}`);
		deepest = current;
	}
	const real = relative(root, fs.realpathSync(deepest));
	if (isAbsolute(real) || real === '..' || real.startsWith(`..${sep}`)) {
		fail(5, `Destination escapes consumer: ${path}`);
	}
	return target;
}

function run(): void {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			tag: { type: 'string' },
			repo: { type: 'string', default: 'CERALIVE/ceralive-brand' },
			tarball: { type: 'string' },
			'sha256-file': { type: 'string' },
		},
	});
	const tag = values.tag;
	if (!tag || !/^v\d{4}\.\d{1,2}\.\d+$/.test(tag)) fail(2, 'Invalid --tag');
	if (Boolean(values.tarball) !== Boolean(values['sha256-file'])) {
		fail(2, '--tarball and --sha256-file must be given together');
	}
	const root = fs.realpathSync(process.cwd());
	const lockPath = destination(root, 'brand-assets.lock.json');
	const noticePath = destination(root, 'BRAND-ASSETS-NOTICE.md');
	const lock: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
	if (
		!record(lock) ||
		lock.schema !== 1 ||
		!Array.isArray(lock.files) ||
		!lock.files.every(mapping)
	)
		fail(2, 'Invalid schema-1 brand-assets.lock.json');
	const postSync = lock.postSync === undefined ? [] : lock.postSync;
	if (!Array.isArray(postSync) || !postSync.every(argv)) {
		fail(2, 'Invalid postSync argv arrays');
	}
	const temp = fs.mkdtempSync(join(tmpdir(), 'brand-assets-sync-'));
	try {
		let tarball = values.tarball ? resolve(values.tarball) : '';
		let checksum = values['sha256-file'] ? resolve(values['sha256-file']) : '';
		if (!tarball) {
			execute(
				[
					'gh',
					'release',
					'download',
					tag,
					'--repo',
					values.repo,
					'--pattern',
					'ceralive-brand-*.tar.gz',
					'--pattern',
					'ceralive-brand-*.tar.gz.sha256',
					'--dir',
					temp,
				],
				3,
				'gh release download failed (are you authenticated with access to CERALIVE/ceralive-brand?)',
				true,
			);
			const archives = fs.readdirSync(temp).filter((name) => name.endsWith('.tar.gz'));
			if (archives.length !== 1 || !archives[0]) fail(3, 'Expected one release tarball');
			tarball = join(temp, archives[0]);
			checksum = `${tarball}.sha256`;
		}
		const digest = sha256(tarball);
		const expected = fs.readFileSync(checksum, 'utf8').trim().split(/\s+/)[0];
		if (!expected || !/^[a-fA-F0-9]{64}$/.test(expected) || digest !== expected.toLowerCase())
			fail(4, 'Tarball sha256 mismatch');
		const listing = execute(
			['tar', '-tvzf', tarball, '--absolute-names', '--numeric-owner', '--quoting-style=escape'],
			6,
			'Cannot inspect archive',
		);
		for (const line of listing.trimEnd().split('\n')) {
			const member = /^([-d])\S*\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
			if (!member?.[2] || !safePath(member[2])) fail(6, `Unsafe archive member: ${line}`);
		}
		const extracted = join(temp, 'x');
		fs.mkdirSync(extracted);
		execute(
			['tar', '-xzf', tarball, '-C', extracted, '--no-same-owner', '--no-same-permissions'],
			6,
			'Archive extraction failed',
		);
		const release: unknown = JSON.parse(
			fs.readFileSync(join(extracted, 'release-info.json'), 'utf8'),
		);
		if (
			!record(release) ||
			release.version !== tag.slice(1) ||
			typeof release.commit !== 'string' ||
			!/^[a-fA-F0-9]{40}$/.test(release.commit)
		) {
			fail(2, 'Invalid release-info version or commit');
		}
		const targets = new Set([lockPath, noticePath]);
		const prepared = lock.files.map((file) => {
			if (!safePath(file.from)) fail(5, `Unsafe source: ${file.from}`);
			const source = join(extracted, file.from);
			if (!stat(source)?.isFile()) fail(5, `Missing or non-regular source: ${file.from}`);
			const target = destination(root, file.to);
			if (targets.has(target)) fail(5, `Duplicate or reserved destination: ${file.to}`);
			targets.add(target);
			return { ...file, source, target, sha256: sha256(source) };
		});
		for (const target of targets) {
			let parent = dirname(target);
			while (parent !== root) {
				if (targets.has(parent)) fail(5, `Conflicting destinations: ${target}`);
				parent = dirname(parent);
			}
		}
		const counts = { changed: 0, unchanged: 0, new: 0 };
		for (const file of prepared) {
			if (!stat(file.target)) counts.new++;
			else if (sha256(file.target) === file.sha256) counts.unchanged++;
			else counts.changed++;
			fs.mkdirSync(dirname(file.target), { recursive: true });
			fs.rmSync(file.target, { force: true });
			fs.copyFileSync(file.source, file.target);
		}
		const sorted = prepared
			.map(({ from, to, sha256 }) => ({ from, to, sha256 }))
			.sort((a, b) => a.to.localeCompare(b.to, 'en'));
		const updated = {
			...lock,
			tag,
			commit: release.commit,
			tarball: basename(tarball),
			tarballSha256: digest,
			files: sorted,
		};
		write(lockPath, `${JSON.stringify(updated, null, '\t')}\n`);
		const sync = sorted.find((file) => file.from === 'consumer-kit/sync-brand-assets.ts');
		const refresh = sync
			? `\`bun ${sync.to} --tag ${tag}\``
			: `\`bun <ceralive-brand checkout>/consumer-kit/sync-brand-assets.ts --tag ${tag}\`, run from this repository's root`;
		write(
			noticePath,
			`# Brand assets notice\n\nThe CeraLive name, logo and icon files listed below are brand assets of the CeraLive project, vendored from the private \`CERALIVE/ceralive-brand\` repository at ${tag} (${release.commit}). They are not covered by this repository's license; all rights reserved. Do not edit them by hand. Maintainers with access to the brand repository refresh them with ${refresh}.\n\n${sorted.map((file) => `- ${file.to}`).join('\n')}\n`,
		);
		process.stdout.write(
			`Brand assets: ${counts.changed} changed, ${counts.unchanged} unchanged, ${counts.new} new\n`,
		);
		for (const command of postSync) {
			process.stdout.write(`postSync: ${JSON.stringify(command)}\n`);
			execute(command, 7, `postSync failed: ${JSON.stringify(command)}`, true);
		}
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}

try {
	run();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = error instanceof SyncError ? error.code : 2;
}
