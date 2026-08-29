/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import {
	prepareSoftwareUpdateOutput,
	readSoftwareUpdateOutput,
	type SoftwareUpdateOutputPaths,
	type SoftwareUpdateOutputRead,
	softwareUpdateOutputPaths,
	UnsafeSoftwareUpdateOutputPathError,
} from "./software-update-output.ts";
import {
	DetachedAptServiceCommandError,
	InvalidDetachedAptUpgradeArgumentsError,
	isExpectedAptUpgradeArgv,
	SOFTWARE_UPDATE_DESCRIPTION,
	SOFTWARE_UPDATE_FRAGMENT_PATH,
	SOFTWARE_UPDATE_UNIT,
	validateDetachedAptServiceFragment,
} from "./software-update-service-contract.ts";
import {
	type DetachedAptServiceState,
	type FinishedDetachedAptServiceState,
	parseDetachedAptServiceProbe,
} from "./software-update-service-state.ts";

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
	readonly prepareOutput: () => Promise<void>;
	readonly start: (command: readonly string[]) => Promise<void>;
	readonly inspect: () => Promise<DetachedAptServiceState>;
	readonly cleanup: (state: FinishedDetachedAptServiceState) => Promise<void>;
	readonly readOutput: (
		file: string,
		offset: number,
	) => Promise<SoftwareUpdateOutputRead>;
	readonly sleep: (milliseconds: number) => Promise<void>;
};

export function buildDetachedAptUpgradeCommand(
	aptArgs: readonly string[],
	outputPaths: SoftwareUpdateOutputPaths,
): string[] {
	if (!isExpectedAptUpgradeArgv(["/usr/bin/apt-get", ...aptArgs])) {
		throw new InvalidDetachedAptUpgradeArgumentsError();
	}
	const trustedPaths = softwareUpdateOutputPaths();
	if (
		outputPaths.stdout !== trustedPaths.stdout ||
		outputPaths.stderr !== trustedPaths.stderr
	) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			outputPaths.stdout,
			"runtime paths are fixed",
		);
	}
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
		"/usr/bin/apt-get",
		...aptArgs,
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
		"--property=Id,FragmentPath,Description,LoadState,ActiveState,SubState,Transient,Type,RemainAfterExit,User,ExecMainCode,ExecMainStatus,ExecStart,ExecStartPre,ExecStartPost,StandardOutput,StandardError",
		"--no-pager",
	];
	const result = await spawnWithTimeout(command, {
		timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS,
	});
	const state = parseDetachedAptServiceProbe(result, command);
	if (state.kind !== "absent") {
		validateDetachedAptServiceFragment(
			await Bun.file(SOFTWARE_UPDATE_FRAGMENT_PATH).text(),
		);
	}
	return state;
}

export function defaultDetachedAptServiceDeps(): DetachedAptServiceDeps {
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
	};
}
