#!/usr/bin/env bun

import { resolve } from 'node:path';
import { file, spawn } from 'bun';

export const BUILD_WARNING_PATTERN = /\bwarn(ing)?\b|INEFFECTIVE_DYNAMIC_IMPORT|chunks are larger/i;

export function buildWarningLines(output) {
	return output.split(/\r?\n|\r/).filter((line) => BUILD_WARNING_PATTERN.test(line));
}

async function tee(stream, destination) {
	const decoder = new TextDecoder();
	let output = '';
	for await (const chunk of stream) {
		destination.write(chunk);
		output += decoder.decode(chunk, { stream: true });
	}
	return output + decoder.decode();
}

function rejectWarnings(output) {
	const warnings = buildWarningLines(output);
	if (warnings.length === 0) return false;
	process.stderr.write(
		`Build warning gate rejected ${warnings.length} line(s):\n${warnings.join('\n')}\n`,
	);
	return true;
}

async function main() {
	const scanFileIndex = process.argv.indexOf('--scan-file');
	if (scanFileIndex !== -1) {
		const scanFile = process.argv[scanFileIndex + 1];
		if (scanFile === undefined) throw new Error('--scan-file requires a path');
		const output = await file(resolve(scanFile)).text();
		process.stdout.write(output);
		process.exitCode = rejectWarnings(output) ? 1 : 0;
		return;
	}

	const vite = spawn([process.execPath, 'x', '--bun', 'vite', 'build'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		tee(vite.stdout, process.stdout),
		tee(vite.stderr, process.stderr),
		vite.exited,
	]);
	process.exitCode = exitCode === 0 && !rejectWarnings(`${stdout}\n${stderr}`) ? 0 : 1;
}

if (import.meta.main) await main();
