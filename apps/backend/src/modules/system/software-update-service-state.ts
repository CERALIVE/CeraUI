/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import {
	DetachedAptServiceCommandError,
	DetachedAptServiceIdentityError,
	validateDetachedAptServiceIdentity,
} from "./software-update-service-contract.ts";

export type DetachedAptServiceState =
	| { readonly kind: "absent" }
	| { readonly kind: "running" }
	| {
			readonly kind: "finished";
			readonly exitCode: number;
			readonly cleanup: "stop" | "reset-failed";
	  };

export type FinishedDetachedAptServiceState = Extract<
	DetachedAptServiceState,
	{ readonly kind: "finished" }
>;

export class DetachedAptServiceStateError extends Error {
	constructor(
		readonly activeState: string,
		readonly subState: string,
	) {
		super(
			`unrecognized detached apt service state: ${activeState}/${subState}`,
		);
		this.name = "DetachedAptServiceStateError";
	}
}

function parseProperties(output: string): Map<string, string> {
	const properties = new Map<string, string>();
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		properties.set(line.slice(0, separator), line.slice(separator + 1));
	}
	return properties;
}

function processExitCode(mainCode: number, mainStatus: number): number {
	if (mainCode === 1) return mainStatus;
	return mainStatus > 0 ? 128 + mainStatus : 1;
}

export function parseDetachedAptServiceState(
	output: string,
): DetachedAptServiceState {
	const properties = parseProperties(output);
	if (properties.get("LoadState") !== "loaded") return { kind: "absent" };

	const activeState = properties.get("ActiveState") ?? "inactive";
	const subState = properties.get("SubState") ?? "dead";
	const mainCode = Number.parseInt(properties.get("ExecMainCode") ?? "0", 10);
	const mainStatus = Number.parseInt(
		properties.get("ExecMainStatus") ?? "0",
		10,
	);

	if (activeState === "failed" || subState === "failed") {
		return {
			kind: "finished",
			exitCode: processExitCode(mainCode, mainStatus),
			cleanup: "reset-failed",
		};
	}
	if (subState === "exited") {
		return { kind: "finished", exitCode: mainStatus, cleanup: "stop" };
	}
	if (
		activeState === "active" ||
		activeState === "activating" ||
		activeState === "reloading" ||
		activeState === "deactivating"
	) {
		return { kind: "running" };
	}
	throw new DetachedAptServiceStateError(activeState, subState);
}

export function parseDetachedAptServiceProbe(
	result: SpawnWithTimeoutResult,
	command: readonly string[],
): DetachedAptServiceState {
	const state = parseDetachedAptServiceState(result.stdout);
	if (result.exitCode !== 0) {
		if (
			state.kind === "absent" &&
			result.stdout.includes("LoadState=not-found")
		) {
			return state;
		}
		throw new DetachedAptServiceCommandError(
			command,
			result.exitCode,
			result.stderr,
		);
	}
	if (state.kind === "absent") {
		if (result.stdout.includes("LoadState=not-found")) return state;
		throw new DetachedAptServiceIdentityError("unit state was not readable");
	}
	validateDetachedAptServiceIdentity(result.stdout);
	return state;
}
