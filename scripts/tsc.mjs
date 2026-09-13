#!/usr/bin/env node
// Run the TypeScript compiler that the INVOKING package actually depends on.
//
// The workspace catalog provides TypeScript 6.0.3 to every package. A bare `tsc`
// resolves through PATH, so a hoisted compiler could silently differ between a
// developer machine and CI. Resolving from the invoking package's dependency graph
// keeps the selected compiler explicit. `bun tsc` remains banned: only this wrapper
// guarantees package-local compiler selection (oven-sh/bun#37152).
//
// `<pkg>/package.json` is the anchor because TypeScript's exports map does not expose
// `./bin/tsc`. The package metadata is exported, and the bin sits beside it.
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
