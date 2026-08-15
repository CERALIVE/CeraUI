#!/usr/bin/env node
// Run the TypeScript compiler that the INVOKING package actually depends on.
//
// This workspace deliberately runs two TypeScript majors side by side. TS 7 is the
// compiler for every plain `tsc --noEmit` gate (apps/backend, packages/rpc,
// packages/i18n). TS 6 stays the workspace catalog default because svelte-check
// (apps/frontend) imports the CLASSIC programmatic compiler API, which TS 7.0 does
// not ship (it is expected in 7.1): it refuses to start outright, see
// svelte-check/bin/ts-version-check.js — "TypeScript 7 support currently requires
// both TypeScript 7 and TypeScript 6 installed ... and requires using the --tsgo
// ... flag".
//
// A bare `tsc` resolves through PATH, so whichever copy hoisting happened to leave in
// `node_modules/.bin` wins — silently, and differently on a developer machine than in
// CI. Resolving from the invoking package's own dependency graph makes the choice
// explicit instead. (`bun tsc` is not an option here either: oven-sh/bun#37152.)
//
// `<pkg>/package.json` is the anchor because TS 7 ships an `exports` map that does not
// expose `./bin/tsc`: resolving that subpath directly throws
// ERR_PACKAGE_PATH_NOT_EXPORTED. `./package.json` is exported, and the bin sits beside
// it.
//
// `--compiler-package <name>` selects a differently-named compiler package, for a
// package that must keep a bare `typescript` on a different major than its gate.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);

const compilerPackageIndex = argv.indexOf('--compiler-package');
let compilerPackage = 'typescript';
if (compilerPackageIndex !== -1) {
	const value = argv[compilerPackageIndex + 1];
	if (value === undefined) {
		throw new Error('--compiler-package requires a package name');
	}
	compilerPackage = value;
	argv.splice(compilerPackageIndex, 2);
}

const requireFrom = createRequire(path.join(process.cwd(), 'noop.cjs'));
const tsc = path.join(
	path.dirname(requireFrom.resolve(`${compilerPackage}/package.json`)),
	'bin',
	'tsc',
);

if (argv.includes('--print-resolved-compiler')) {
	// biome-ignore lint/suspicious/noConsole: CLI tool stdout is its result output
	console.log(tsc);
	process.exit(0);
}

const { status, error } = spawnSync(tsc, argv, { stdio: 'inherit' });
if (error) {
	throw error;
}
process.exit(status ?? 1);
