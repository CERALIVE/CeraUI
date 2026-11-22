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
import {
	parseOsStageSystemdProperties,
	parseSystemdExitFields,
} from "./update-orchestrator/os-stage-systemd.ts";

export type DetachedAptServiceState =
	| { readonly kind: "absent" }
	| {
			readonly kind: "running";
			readonly invocation?: string;
			readonly packages?: readonly InstalledPair[];
	  }
	| {
			readonly kind: "finished";
			readonly exitCode: number;
			readonly cleanup: "stop" | "reset-failed";
			/** systemd's InvocationID: tells this run from another of the same unit. */
			readonly invocation?: string;
			/** The package/version pairs its ExecStart installs (the pinned script only). */
			readonly packages?: readonly InstalledPair[];
	  };

export type InstalledPair = { readonly name: string; readonly version: string };

// The released pinned script ends `... install <name>=<version> ...`; a plain
// upgrade names packages without versions and so has no pairs.
function installedPairs(
	execStart: string | undefined,
): readonly InstalledPair[] | undefined {
	const install = / install ([^;]+?) ;/.exec(execStart ?? "")?.[1];
	const pairs = install?.split(" ").map((token) => {
		const at = token.indexOf("=");
		return at > 0
			? { name: token.slice(0, at), version: token.slice(at + 1) }
			: undefined;
	});
	return pairs?.length && pairs.every((pair) => pair && pair.version)
		? (pairs as InstalledPair[])
		: undefined;
}

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

function parseProperties(output: string): ReadonlyMap<string, string> {
	const properties = parseOsStageSystemdProperties(output);
	if (!properties)
		throw new DetachedAptServiceIdentityError("unit properties contradictory");
	return properties;
}

// Exported for reuse by update-orchestrator/lock.ts: the same raw
// ExecMainCode/ExecMainStatus -> shell-style exit code conversion applies to
// ANY systemd unit's `systemctl show` probe, not just the apt transaction's —
// reused rather than re-derived so the two probes can never silently disagree
// on what a given (code, status) pair means.
export function processExitCode(mainCode: number, mainStatus: number): number {
	if (mainCode === 1) return mainStatus;
	return mainStatus > 0 ? 128 + mainStatus : 1;
}

export function parseDetachedAptServiceState(
	output: string,
): DetachedAptServiceState {
	const properties = parseProperties(output);
	if (properties.get("LoadState") === "not-found") return { kind: "absent" };
	if (properties.get("LoadState") !== "loaded")
		throw new DetachedAptServiceIdentityError("unit state was not readable");

	const activeState = properties.get("ActiveState") ?? "inactive";
	const subState = properties.get("SubState") ?? "dead";
	const exit = parseSystemdExitFields(properties);
	const invocation = properties.get("InvocationID");
	const packages = installedPairs(properties.get("ExecStart"));
	const run = {
		...(invocation ? { invocation } : {}),
		...(packages ? { packages } : {}),
	};

	if (activeState === "failed" || subState === "failed") {
		if (
			!exit ||
			activeState !== "failed" ||
			subState !== "failed" ||
			exit.mainStatus === 0
		)
			return { kind: "running", ...run };
		return {
			kind: "finished",
			exitCode: processExitCode(exit.mainCode, exit.mainStatus),
			cleanup: "reset-failed",
			...run,
		};
	}
	if (subState === "exited") {
		if (!exit || activeState !== "active" || exit.mainCode !== 1)
			return { kind: "running", ...run };
		return {
			kind: "finished",
			exitCode: exit.mainStatus,
			cleanup: "stop",
			...run,
		};
	}
	if (
		activeState === "active" ||
		activeState === "activating" ||
		activeState === "reloading" ||
		activeState === "deactivating"
	) {
		return { kind: "running", ...run };
	}
	throw new DetachedAptServiceStateError(activeState, subState);
}

export function parseDetachedAptServiceProbe(
	result: SpawnWithTimeoutResult,
	command: readonly string[],
): DetachedAptServiceState {
	const state = parseDetachedAptServiceState(result.stdout);
	if (result.exitCode !== 0) {
		if (state.kind === "absent") {
			return state;
		}
		throw new DetachedAptServiceCommandError(
			command,
			result.exitCode,
			result.stderr,
		);
	}
	if (state.kind === "absent") {
		return state;
	}
	validateDetachedAptServiceIdentity(result.stdout);
	return state;
}
