/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import {
	APT_PACKAGE_NAME_RE,
	compareAptPackageNames,
} from "./apt-package-name.ts";
import { softwareUpdateOutputPaths } from "./software-update-output.ts";
import { parseOsStageSystemdProperties } from "./update-orchestrator/os-stage-systemd.ts";

export const SOFTWARE_UPDATE_UNIT = "ceralive-software-update.service";
export const SOFTWARE_UPDATE_DESCRIPTION = "CeraLive software update";
export const SOFTWARE_UPDATE_FRAGMENT_PATH = `/run/systemd/transient/${SOFTWARE_UPDATE_UNIT}`;
export const SOFTWARE_UPDATE_LOCK = "/run/lock/ceralive-update.lock";

const APT_UPGRADE_PREFIX = [
	"/usr/bin/apt-get",
	"-y",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
] as const;

export class DetachedAptServiceCommandError extends Error {
	constructor(
		readonly command: readonly string[],
		readonly exitCode: number,
		readonly stderr: string,
	) {
		super(
			stderr.trim() ||
				`${command[0] ?? "systemd command"} exited with code ${exitCode}`,
		);
		this.name = "DetachedAptServiceCommandError";
	}
}

export class DetachedAptServiceIdentityError extends Error {
	constructor(readonly reason: string) {
		super(`refusing unknown software-update service: ${reason}`);
		this.name = "DetachedAptServiceIdentityError";
	}
}

export class InvalidDetachedAptUpgradeArgumentsError extends Error {
	constructor() {
		super(
			"detached apt transaction arguments do not match the upgrade contract",
		);
		this.name = "InvalidDetachedAptUpgradeArgumentsError";
	}
}

export function isExpectedAptUpgradeArgv(argv: readonly string[]): boolean {
	if (!APT_UPGRADE_PREFIX.every((value, index) => argv[index] === value)) {
		return false;
	}
	let tailStart = APT_UPGRADE_PREFIX.length;
	const forcePair = argv.slice(tailStart, tailStart + 2);
	if (
		forcePair[0] === "-o" &&
		(forcePair[1] === "Acquire::ForceIPv4=true" ||
			forcePair[1] === "Acquire::ForceIPv6=true")
	) {
		tailStart += 2;
	}
	const tail = argv.slice(tailStart);
	return (
		(tail.length === 1 && tail[0] === "dist-upgrade") ||
		(tail[0] === "install" &&
			tail.length > 1 &&
			tail
				.slice(1)
				.every((packageName) => APT_PACKAGE_NAME_RE.test(packageName)))
	);
}

export function isExpectedAptAllInstallArgv(argv: readonly string[]): boolean {
	const prefix = [
		"/usr/bin/apt-get",
		"-y",
		"--no-download",
		"--no-remove",
		"-o",
		"Dpkg::Options::=--force-confdef",
		"-o",
		"Dpkg::Options::=--force-confold",
	];
	if (!prefix.every((item, i) => argv[i] === item)) return false;
	let index = prefix.length;
	if (argv[index] === "-o") {
		if (
			!["Acquire::ForceIPv4=true", "Acquire::ForceIPv6=true"].includes(
				argv[index + 1] ?? "",
			)
		)
			return false;
		index += 2;
	}
	if (argv[index++] !== "install" || index === argv.length) return false;
	let previous = "";
	for (const token of argv.slice(index)) {
		const separator = token.indexOf("=");
		const name = token.slice(0, separator);
		const version = token.slice(separator + 1);
		if (
			separator < 1 ||
			!APT_PACKAGE_NAME_RE.test(name) ||
			!/^[0-9][A-Za-z0-9.+:~-]*$/.test(version) ||
			compareAptPackageNames(name, previous) <= 0
		)
			return false;
		previous = name;
	}
	return true;
}

// Descriptor 3, never 2: apt marks its status descriptor close-on-exec before
// forking dpkg, which would leave DPkg::Post-Invoke hooks without stderr.
const APT_STATUS_OPTION = "-o APT::Status-Fd=3";

/** The status forms need bash: its failed `exec` redirect returns, where sh exits. */
export const STATUS_CHANNEL_SHELL = "/bin/bash";

// APT appends its records to the status file itself: a regular file never
// blocks it, and no reader can die under it. One it cannot open gives APT
// /dev/null, so the install still runs, without numbers.
function aptStatusRedirect(): string {
	return `{ exec 3>>${softwareUpdateOutputPaths().status}; } 2>/dev/null || exec 3>/dev/null`;
}

export function expectedAptUpgradeScript(aptArgs: readonly string[]): string {
	if (!isExpectedAptUpgradeArgv(["/usr/bin/apt-get", ...aptArgs]))
		throw new InvalidDetachedAptUpgradeArgumentsError();
	return `${aptStatusRedirect()}; exec /usr/bin/apt-get ${APT_STATUS_OPTION} ${aptArgs.join(" ")}`;
}

/** `aptStatus: false` is the pre-channel script, kept only so it stays adoptable. */
export function expectedAptAllScript(
	install: readonly string[],
	family: readonly string[],
	aptStatus = true,
): string {
	if (!isExpectedAptAllInstallArgv(["/usr/bin/apt-get", ...install]))
		throw new InvalidDetachedAptUpgradeArgumentsError();
	if (
		family.length !== 0 &&
		!(
			family.length === 2 &&
			family[0] === "-o" &&
			["Acquire::ForceIPv4=true", "Acquire::ForceIPv6=true"].includes(
				family[1] ?? "",
			)
		)
	)
		throw new InvalidDetachedAptUpgradeArgumentsError();
	if (family.length && !install.includes(family[1] ?? ""))
		throw new InvalidDetachedAptUpgradeArgumentsError();
	const apt = aptStatus
		? `/usr/bin/apt-get ${APT_STATUS_OPTION}`
		: "/usr/bin/apt-get";
	const run = `${apt} -d -y upgrade --with-new-pkgs${family.length ? ` ${family.join(" ")}` : ""} && ${apt} ${install.join(" ")}`;
	return aptStatus ? `${aptStatusRedirect()}; ${run}` : run;
}

const EXEC_START_TAIL =
	/^ ; ignore_errors=no ; start_time=\[[^\]\n]+\] ; stop_time=\[[^\]\n]+\] ; pid=\d+ ; code=(?:\(null\)|exited|killed|dumped) ; status=\d+(?:\/[A-Za-z0-9_-]+)? }$/;

function wrappedScript(execStart: string, argvPrefix: string): string | null {
	const scriptEnd = execStart.indexOf(" ; ignore_errors=", argvPrefix.length);
	return execStart.startsWith(argvPrefix) &&
		scriptEnd >= 0 &&
		EXEC_START_TAIL.test(execStart.slice(scriptEnd))
		? execStart.slice(argvPrefix.length, scriptEnd)
		: null;
}

function canonicalScript(build: () => string): string | null {
	try {
		return build();
	} catch (error) {
		if (error instanceof InvalidDetachedAptUpgradeArgumentsError) return null; // a foreign command is not adoptable
		throw error;
	}
}

/** Returns true when the unit writes APT status records to the status file. */
export function validateDetachedAptServiceIdentity(output: string): boolean {
	if (
		output.split("\n").filter((line) => line.startsWith("ExecStart="))
			.length !== 1
	) {
		throw new DetachedAptServiceIdentityError(
			"expected exactly one ExecStart property",
		);
	}
	const properties = parseOsStageSystemdProperties(output);
	if (!properties)
		throw new DetachedAptServiceIdentityError("unit properties contradictory");
	const expected = new Map([
		["Id", SOFTWARE_UPDATE_UNIT],
		["FragmentPath", SOFTWARE_UPDATE_FRAGMENT_PATH],
		["Description", SOFTWARE_UPDATE_DESCRIPTION],
		["Transient", "yes"],
		["Type", "exec"],
		["RemainAfterExit", "yes"],
		["StandardOutput", "append"],
		["StandardError", "append"],
		["User", ""],
	]);
	for (const [name, value] of expected) {
		if (properties.get(name) !== value) {
			throw new DetachedAptServiceIdentityError(`${name} does not match`);
		}
	}
	for (const hook of ["ExecStartPre", "ExecStartPost"] as const) {
		if ((properties.get(hook) ?? "") !== "") {
			throw new DetachedAptServiceIdentityError(`${hook} does not match`);
		}
	}

	const execStart = properties.get("ExecStart") ?? "";
	if (execStart.startsWith("{ path=/usr/bin/flock ; ")) {
		const flock = `{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x ${SOFTWARE_UPDATE_LOCK} `;
		const status = wrappedScript(
			execStart,
			`${flock}${STATUS_CHANNEL_SHELL} -ec `,
		);
		const script = status ?? wrappedScript(execStart, `${flock}/bin/sh -ec `);
		const aptStatus = status !== null;
		const prefix = `${aptStatusRedirect()}; `;
		const match =
			/^\/usr\/bin\/apt-get(?: -o APT::Status-Fd=3)? -d -y upgrade --with-new-pkgs(?<family> -o Acquire::ForceIPv[46]=true)? && \/usr\/bin\/apt-get(?: -o APT::Status-Fd=3)? (?<install>.+)$/.exec(
				aptStatus && script?.startsWith(prefix)
					? script.slice(prefix.length)
					: (script ?? ""),
			);
		const family = match?.groups?.family?.trim().split(" ") ?? [];
		const install = match?.groups?.install?.split(" ") ?? [];
		if (
			script === null ||
			canonicalScript(() =>
				expectedAptAllScript(install, family, aptStatus),
			) !== script
		) {
			throw new DetachedAptServiceIdentityError("flock wrapper does not match");
		}
		return aptStatus;
	}
	if (execStart.startsWith(`{ path=${STATUS_CHANNEL_SHELL} ; `)) {
		const script = wrappedScript(
			execStart,
			`{ path=${STATUS_CHANNEL_SHELL} ; argv[]=${STATUS_CHANNEL_SHELL} -ec `,
		);
		const prefix = `${aptStatusRedirect()}; exec /usr/bin/apt-get ${APT_STATUS_OPTION} `;
		const args = script?.startsWith(prefix)
			? script.slice(prefix.length).split(" ")
			: [];
		if (
			script === null ||
			canonicalScript(() => expectedAptUpgradeScript(args)) !== script
		) {
			throw new DetachedAptServiceIdentityError(
				"status wrapper does not match",
			);
		}
		return true;
	}
	const argvMarker = "argv[]=";
	const argvStart = execStart.indexOf(argvMarker);
	const argvEnd = execStart.indexOf(" ;", argvStart);
	if (
		!execStart.startsWith("{ path=/usr/bin/apt-get ; ") ||
		argvStart < 0 ||
		argvEnd < 0
	) {
		throw new DetachedAptServiceIdentityError("ExecStart is not apt-get");
	}
	const argv = execStart
		.slice(argvStart + argvMarker.length, argvEnd)
		.trim()
		.split(/\s+/);
	if (!isExpectedAptUpgradeArgv(argv)) {
		throw new DetachedAptServiceIdentityError(
			"apt-get operation does not match",
		);
	}
	return false;
}

export function validateDetachedAptServiceFragment(fragment: string): void {
	const paths = softwareUpdateOutputPaths();
	const expected = new Map([
		["StandardOutput", `append:${paths.stdout}`],
		["StandardError", `append:${paths.stderr}`],
	]);
	const observed = new Map<string, string>();
	let section = "";
	let serviceSeen = false;
	for (const rawLine of fragment.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1);
			if (section === "Service") {
				if (serviceSeen)
					throw new DetachedAptServiceIdentityError(
						"Service section is duplicated",
					);
				serviceSeen = true;
			}
			continue;
		}
		if (section !== "Service") continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const name = line.slice(0, separator);
		if (!expected.has(name)) continue;
		if (observed.has(name)) {
			throw new DetachedAptServiceIdentityError(`${name} is duplicated`);
		}
		observed.set(name, line.slice(separator + 1));
	}
	for (const [name, value] of expected) {
		if (observed.get(name) !== value) {
			throw new DetachedAptServiceIdentityError(`${name} path does not match`);
		}
	}
}
