/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import {
	buildDetachedAptUpgradeCommand,
	type DetachedAptServiceDeps,
	type DetachedAptServiceState,
	defaultDetachedAptServiceDeps,
	type SoftwareUpdateOutputPaths,
} from "./software-update-service.ts";

export type { SoftwareUpdateOutputPaths } from "./software-update-service.ts";
export { buildDetachedAptUpgradeCommand } from "./software-update-service.ts";

const OUTPUT_POLL_INTERVAL_MS = 250;
const FINAL_DRAIN_MAX_FAILURES = 20;

export type SoftwareUpdateOutputHandlers = {
	readonly onStdout: (chunk: string) => void;
	readonly onStderr: (chunk: string) => void;
	readonly onAttached?: () => void;
	readonly onObserverError?: (error: unknown) => void;
};

export type DetachedAptUpgradeDeps = DetachedAptServiceDeps;

export type RecoveredDetachedAptUpgrade = {
	readonly completion: Promise<number>;
};

type OutputCursor = {
	readonly path: string;
	readonly offset: number;
	readonly decoder: TextDecoder;
	readonly emit: (chunk: string) => void;
};

export class DetachedAptServiceVanishedError extends Error {
	constructor() {
		super("software-update transient service vanished after launch");
		this.name = "DetachedAptServiceVanishedError";
	}
}

export class DetachedAptServiceAlreadyExistsError extends Error {
	constructor() {
		super("a detached apt transaction already exists");
		this.name = "DetachedAptServiceAlreadyExistsError";
	}
}

export class DetachedAptServiceCleanupError extends Error {
	constructor(
		readonly transactionExitCode: number,
		readonly cleanupError: unknown,
	) {
		super("apt transaction finished, but its transient service cleanup failed");
		this.name = "DetachedAptServiceCleanupError";
	}
}

export class DetachedAptOutputUnavailableError extends Error {
	constructor() {
		super(
			"detached apt output remained unreadable after the transaction finished",
		);
		this.name = "DetachedAptOutputUnavailableError";
	}
}

function reportObserverError(
	handlers: SoftwareUpdateOutputHandlers,
	error: unknown,
): void {
	handlers.onObserverError?.(error);
}

async function drainOutputCursor(
	cursor: OutputCursor,
	read: DetachedAptUpgradeDeps["readOutput"],
): Promise<OutputCursor> {
	const next = await read(cursor.path, cursor.offset);
	if (next.bytes.byteLength > 0) {
		const text = cursor.decoder.decode(next.bytes, { stream: true });
		if (text.length > 0) cursor.emit(text);
	}
	return { ...cursor, offset: next.nextOffset };
}

async function drainAvailableOutput(
	stdoutCursor: OutputCursor,
	stderrCursor: OutputCursor,
	handlers: SoftwareUpdateOutputHandlers,
	readOutput: DetachedAptUpgradeDeps["readOutput"],
): Promise<{
	readonly stdout: OutputCursor;
	readonly stderr: OutputCursor;
	readonly complete: boolean;
}> {
	const [stdoutResult, stderrResult] = await Promise.allSettled([
		drainOutputCursor(stdoutCursor, readOutput),
		drainOutputCursor(stderrCursor, readOutput),
	]);
	if (stdoutResult.status === "rejected") {
		reportObserverError(handlers, stdoutResult.reason);
	}
	if (stderrResult.status === "rejected") {
		reportObserverError(handlers, stderrResult.reason);
	}
	return {
		stdout:
			stdoutResult.status === "fulfilled" ? stdoutResult.value : stdoutCursor,
		stderr:
			stderrResult.status === "fulfilled" ? stderrResult.value : stderrCursor,
		complete:
			stdoutResult.status === "fulfilled" &&
			stderrResult.status === "fulfilled",
	};
}

function createOutputCursors(
	paths: SoftwareUpdateOutputPaths,
	handlers: SoftwareUpdateOutputHandlers,
): readonly [OutputCursor, OutputCursor] {
	return [
		{
			path: paths.stdout,
			offset: 0,
			decoder: new TextDecoder(),
			emit: handlers.onStdout,
		},
		{
			path: paths.stderr,
			offset: 0,
			decoder: new TextDecoder(),
			emit: handlers.onStderr,
		},
	];
}

async function observeDetachedAptUpgrade(
	initialState: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<number> {
	let state: DetachedAptServiceState = initialState;
	let [stdoutCursor, stderrCursor] = createOutputCursors(
		deps.outputPaths,
		handlers,
	);

	while (state.kind === "running") {
		const drained = await drainAvailableOutput(
			stdoutCursor,
			stderrCursor,
			handlers,
			deps.readOutput,
		);
		stdoutCursor = drained.stdout;
		stderrCursor = drained.stderr;
		await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		try {
			state = await deps.inspect();
		} catch (error) {
			reportObserverError(handlers, error);
			continue;
		}
		if (state.kind === "absent") throw new DetachedAptServiceVanishedError();
	}
	if (state.kind !== "finished") throw new DetachedAptServiceVanishedError();

	let finalDrainComplete = false;
	let finalDrainFailures = 0;
	while (!finalDrainComplete) {
		const drained = await drainAvailableOutput(
			stdoutCursor,
			stderrCursor,
			handlers,
			deps.readOutput,
		);
		stdoutCursor = drained.stdout;
		stderrCursor = drained.stderr;
		finalDrainComplete = drained.complete;
		if (!finalDrainComplete) {
			finalDrainFailures++;
			if (finalDrainFailures >= FINAL_DRAIN_MAX_FAILURES) {
				throw new DetachedAptOutputUnavailableError();
			}
			await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
	const stdoutTail = stdoutCursor.decoder.decode();
	if (stdoutTail.length > 0) handlers.onStdout(stdoutTail);
	const stderrTail = stderrCursor.decoder.decode();
	if (stderrTail.length > 0) handlers.onStderr(stderrTail);
	try {
		await deps.cleanup(state);
	} catch (error) {
		throw new DetachedAptServiceCleanupError(state.exitCode, error);
	}
	return state.exitCode;
}

export async function runDetachedAptUpgrade(
	aptArgs: readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<number> {
	const existing = await deps.inspect();
	if (existing.kind !== "absent") {
		throw new DetachedAptServiceAlreadyExistsError();
	}
	await deps.prepareOutput();
	await deps.start(buildDetachedAptUpgradeCommand(aptArgs, deps.outputPaths));
	return observeDetachedAptUpgrade({ kind: "running" }, handlers, deps);
}

export async function recoverDetachedAptUpgrade(
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<RecoveredDetachedAptUpgrade | null> {
	const state = await deps.inspect();
	if (state.kind === "absent") return null;
	handlers.onAttached?.();
	return {
		completion: observeDetachedAptUpgrade(state, handlers, deps),
	};
}
