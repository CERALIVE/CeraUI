/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";
import { softwareUpdateOutputPaths } from "./software-update-output.ts";

export const SOFTWARE_UPDATE_UNIT = "ceralive-software-update.service";
export const SOFTWARE_UPDATE_DESCRIPTION = "CeraLive software update";
export const SOFTWARE_UPDATE_FRAGMENT_PATH = `/run/systemd/transient/${SOFTWARE_UPDATE_UNIT}`;

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
	const tail = argv.slice(APT_UPGRADE_PREFIX.length);
	return (
		(tail.length === 1 && tail[0] === "dist-upgrade") ||
		(tail[0] === "install" &&
			tail.length > 1 &&
			tail
				.slice(1)
				.every((packageName) => APT_PACKAGE_NAME_RE.test(packageName)))
	);
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

export function validateDetachedAptServiceIdentity(output: string): void {
	const properties = parseProperties(output);
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
		["ExecStartPre", ""],
		["ExecStartPost", ""],
	]);
	for (const [name, value] of expected) {
		if (properties.get(name) !== value) {
			throw new DetachedAptServiceIdentityError(`${name} does not match`);
		}
	}

	const execStart = properties.get("ExecStart") ?? "";
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
}

export function validateDetachedAptServiceFragment(fragment: string): void {
	const paths = softwareUpdateOutputPaths();
	const expected = new Map([
		["StandardOutput", `append:${paths.stdout}`],
		["StandardError", `append:${paths.stderr}`],
	]);
	const observed = new Map<string, string>();
	let section = "";
	for (const rawLine of fragment.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1);
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
