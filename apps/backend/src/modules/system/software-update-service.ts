/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import { classifyPackageLayer } from "./package-layer.ts";
import {
	prepareSoftwareUpdateOutput,
	readSoftwareUpdateAttempt,
	readSoftwareUpdateOutput,
	type SoftwareUpdateAttempt,
	type SoftwareUpdateOutputPaths,
	type SoftwareUpdateOutputRead,
	softwareUpdateOutputPaths,
	UnsafeSoftwareUpdateOutputPathError,
	writeSoftwareUpdateAttempt,
} from "./software-update-output.ts";
import {
	DetachedAptServiceCommandError,
	DetachedAptServiceIdentityError,
	expectedAptAllScript,
	expectedAptUpgradeScript,
	InvalidDetachedAptUpgradeArgumentsError,
	isExpectedAptUpgradeArgv,
	SOFTWARE_UPDATE_DESCRIPTION,
	SOFTWARE_UPDATE_FRAGMENT_PATH,
	SOFTWARE_UPDATE_LOCK,
	SOFTWARE_UPDATE_UNIT,
	STATUS_CHANNEL_SHELL,
	validateDetachedAptServiceFragment,
} from "./software-update-service-contract.ts";
import {
	type DetachedAptServiceState,
	type FinishedDetachedAptServiceState,
	parseDetachedAptServiceProbe,
} from "./software-update-service-state.ts";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";

const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

export type {
	SoftwareUpdateOutputPaths,
	SoftwareUpdateOutputRead,
} from "./software-update-output.ts";
export {
	DetachedAptServiceCommandError,
	DetachedAptServiceIdentityError,
	InvalidDetachedAptUpgradeArgumentsError,
	validateDetachedAptServiceFragment,
	validateDetachedAptServiceIdentity,
} from "./software-update-service-contract.ts";
export type {
	DetachedAptServiceState,
	FinishedDetachedAptServiceState,
} from "./software-update-service-state.ts";
export {
	DetachedAptServiceStateError,
	parseDetachedAptServiceProbe,
	parseDetachedAptServiceState,
} from "./software-update-service-state.ts";

export type DetachedAptServiceDeps = {
	readonly outputPaths: SoftwareUpdateOutputPaths;
	/** `status: false`: the status file could not be made, so it is not read. */
	readonly prepareOutput: () => Promise<
		{ readonly status: boolean } | undefined
	>;
	readonly start: (command: readonly string[]) => Promise<void>;
	readonly inspect: () => Promise<DetachedAptServiceState>;
	readonly cleanup: (state: FinishedDetachedAptServiceState) => Promise<void>;
	readonly readOutput: (
		file: string,
		offset: number,
	) => Promise<SoftwareUpdateOutputRead>;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly now?: () => number;
	/** The exit an observer recorded for the current unit; null until one did. */
	/** The current attempt's durable record; synchronous so admission precedes any publication. */
	readonly readAttempt: () => SoftwareUpdateAttempt | null;
	readonly writeAttempt: (record: SoftwareUpdateAttempt) => void;
	/** Milliseconds since boot; defaults to the host's uptime. */
	readonly uptimeMs?: () => number;
};

function assertTrustedOutputPaths(
	outputPaths: SoftwareUpdateOutputPaths,
): void {
	const trusted = softwareUpdateOutputPaths();
	if (
		outputPaths.stdout !== trusted.stdout ||
		outputPaths.stderr !== trusted.stderr ||
		outputPaths.status !== trusted.status
	) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			outputPaths.stdout,
			"runtime paths are fixed",
		);
	}
}

/** `aptStatus: false`: the pre-channel form, for a launch whose status file could not be made. */
export function buildDetachedAptUpgradeCommand(
	aptArgs: readonly string[],
	outputPaths: SoftwareUpdateOutputPaths,
	aptStatus = true,
): string[] {
	if (!isExpectedAptUpgradeArgv(["/usr/bin/apt-get", ...aptArgs])) {
		throw new InvalidDetachedAptUpgradeArgumentsError();
	}
	const installAt = aptArgs.indexOf("install");
	const packages = installAt < 0 ? [] : aptArgs.slice(installAt + 1);
	if (
		packages.length === 0 ||
		packages.some((name) => classifyPackageLayer(name) !== "app") ||
		packages.some(
			(name, index) => index > 0 && (packages[index - 1] ?? "") > name,
		)
	) {
		throw new InvalidDetachedAptUpgradeArgumentsError();
	}
	assertTrustedOutputPaths(outputPaths);
	return [
		"systemd-run",
		`--unit=${SOFTWARE_UPDATE_UNIT}`,
		`--description=${SOFTWARE_UPDATE_DESCRIPTION}`,
		"--remain-after-exit",
		"--quiet",
		"--service-type=exec",
		"--expand-environment=no",
		`--property=StandardOutput=append:${outputPaths.stdout}`,
		`--property=StandardError=append:${outputPaths.stderr}`,
		"--",
		...(aptStatus
			? [STATUS_CHANNEL_SHELL, "-ec", expectedAptUpgradeScript(aptArgs)]
			: ["/usr/bin/apt-get", ...aptArgs]),
	];
}

export function buildDetachedAptAllCommand(
	installArgs: readonly string[],
	verdict: "any" | "force_ipv4" | "force_ipv6",
	outputPaths: SoftwareUpdateOutputPaths,
	aptStatus = true,
): string[] {
	const family =
		verdict === "any"
			? []
			: ["-o", `Acquire::ForceIPv${verdict === "force_ipv4" ? "4" : "6"}=true`];
	const script = expectedAptAllScript(installArgs, family, aptStatus);
	assertTrustedOutputPaths(outputPaths);
	return [
		"systemd-run",
		`--unit=${SOFTWARE_UPDATE_UNIT}`,
		`--description=${SOFTWARE_UPDATE_DESCRIPTION}`,
		"--remain-after-exit",
		"--quiet",
		"--service-type=exec",
		"--expand-environment=no",
		`--property=StandardOutput=append:${outputPaths.stdout}`,
		`--property=StandardError=append:${outputPaths.stderr}`,
		"--",
		"/usr/bin/flock",
		"-x",
		SOFTWARE_UPDATE_LOCK,
		aptStatus ? STATUS_CHANNEL_SHELL : "/bin/sh",
		"-ec",
		script,
	];
}

async function requireSuccessfulCommand(command: string[]): Promise<string> {
	const result = await spawnWithTimeout(command, {
		timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new DetachedAptServiceCommandError(
			command,
			result.exitCode,
			result.stderr,
		);
	}
	return result.stdout;
}

async function inspectService(): Promise<DetachedAptServiceState> {
	const command = [
		"systemctl",
		"show",
		SOFTWARE_UPDATE_UNIT,
		"--property=Id,InvocationID,FragmentPath,Description,LoadState,ActiveState,SubState,Transient,Type,RemainAfterExit,User,ExecMainCode,ExecMainStatus,ExecStart,ExecStartPre,ExecStartPost,StandardOutput,StandardError",
		"--no-pager",
	];
	const result = await spawnWithTimeout(command, {
		timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS,
	});
	const state = parseDetachedAptServiceProbe(result, command);
	if (state.kind !== "absent") {
		const fragment = await readStoredStateFile(
			SOFTWARE_UPDATE_FRAGMENT_PATH,
			STORED_STATE_LIMITS.intent,
		);
		if (fragment === null)
			throw new DetachedAptServiceIdentityError("unit fragment absent");
		validateDetachedAptServiceFragment(fragment);
	}
	return state;
}

let detachedAptServiceDepsForTest: DetachedAptServiceDeps | null = null;

/** Tests running real backend processes give them a unit that outlives each one. */
export function setDetachedAptServiceDepsForTest(
	deps: DetachedAptServiceDeps | null,
): void {
	detachedAptServiceDepsForTest = deps;
}

export function defaultDetachedAptServiceDeps(): DetachedAptServiceDeps {
	if (detachedAptServiceDepsForTest) return detachedAptServiceDepsForTest;
	const paths = softwareUpdateOutputPaths();
	return {
		outputPaths: paths,
		prepareOutput: () => prepareSoftwareUpdateOutput(paths),
		start: async (command) => {
			await requireSuccessfulCommand([...command]);
		},
		inspect: inspectService,
		cleanup: async (state) => {
			await requireSuccessfulCommand([
				"systemctl",
				state.cleanup,
				SOFTWARE_UPDATE_UNIT,
			]);
		},
		readOutput: readSoftwareUpdateOutput,
		sleep: Bun.sleep,
		readAttempt: () => readSoftwareUpdateAttempt(paths),
		writeAttempt: (record) => writeSoftwareUpdateAttempt(paths, record),
	};
}
