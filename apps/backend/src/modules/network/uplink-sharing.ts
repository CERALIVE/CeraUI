import { open, rename, unlink } from "node:fs/promises";

import { run } from "../../helpers/run.ts";
import {
	SHARE_RULESET_PATH,
	SHARE_SERVICE,
	SteeringUnavailableError,
	UPLINK_MARK_MASK,
} from "./uplink-steering/contracts.ts";

export interface UplinkSharingDeps {
	readonly run: typeof run;
	readonly readFile: (path: string) => Promise<string | undefined>;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly renameFile: (from: string, to: string) => Promise<void>;
	readonly removeFile: (path: string) => Promise<void>;
}

export type SharingServiceAction = "activate" | "deactivate" | "reload";

async function readOptional(path: string): Promise<string | undefined> {
	const file = Bun.file(path);
	if (!(await file.exists())) return undefined;
	return await file.text();
}

async function writeSynced(path: string, contents: string): Promise<void> {
	const handle = await open(path, "w", 0o600);
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function removeOptional(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

const defaultDeps: UplinkSharingDeps = {
	run,
	readFile: readOptional,
	writeFile: writeSynced,
	renameFile: rename,
	removeFile: removeOptional,
};

let tempSequence = 0;

function tempPath(): string {
	tempSequence++;
	return `${SHARE_RULESET_PATH}.${process.pid}.${tempSequence}.tmp`;
}

async function publishRuleset(
	ruleset: string,
	deps: UplinkSharingDeps,
): Promise<void> {
	const temp = tempPath();
	try {
		await deps.writeFile(temp, ruleset);
		await deps.run("nft", ["--check", "--file", temp]);
		await deps.renameFile(temp, SHARE_RULESET_PATH);
	} catch (error) {
		await deps.removeFile(temp);
		throw new SteeringUnavailableError(
			"ruleset_publish_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function applyNftablesRules(
	ruleset: string,
	deps: UplinkSharingDeps = defaultDeps,
	action: SharingServiceAction = "reload",
): Promise<void> {
	if (action === "deactivate") {
		await deps.run("systemctl", ["stop", SHARE_SERVICE]);
		return;
	}
	const previous = await deps.readFile(SHARE_RULESET_PATH);
	await publishRuleset(ruleset, deps);
	try {
		if (action === "activate") {
			await deps.run("systemctl", ["start", SHARE_SERVICE]);
		}
		await deps.run("systemctl", ["reload", SHARE_SERVICE]);
	} catch (error) {
		try {
			if (previous === undefined) {
				await deps.removeFile(SHARE_RULESET_PATH);
				if (action === "activate") {
					await deps.run("systemctl", ["stop", SHARE_SERVICE]);
				}
			} else {
				await publishRuleset(previous, deps);
				await deps.run("systemctl", ["reload", SHARE_SERVICE]);
			}
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"nftables reload and rollback both failed",
			);
		}
		throw new SteeringUnavailableError(
			"ruleset_reload_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function deactivateUplinkSharing(
	deps: UplinkSharingDeps = defaultDeps,
): Promise<void> {
	await applyNftablesRules("", deps, "deactivate");
}

export async function flushConntrack(
	mark: number,
	deps: Pick<UplinkSharingDeps, "run"> = defaultDeps,
): Promise<void> {
	await deps.run("conntrack", [
		"--delete",
		"--mark",
		`${hexMark(mark)}/${hexMark(UPLINK_MARK_MASK)}`,
	]);
}

export async function setIpForwarding(
	enabled: boolean,
	deps: Pick<UplinkSharingDeps, "run"> = defaultDeps,
): Promise<void> {
	await deps.run("sysctl", [
		"-w",
		`net.ipv4.ip_forward=${enabled ? "1" : "0"}`,
	]);
}

export async function applyTrafficControl(
	argv: readonly string[],
	deps: Pick<UplinkSharingDeps, "run"> = defaultDeps,
): Promise<string> {
	return await deps.run("tc", [...argv]);
}

function hexMark(mark: number): string {
	return `0x${(mark >>> 0).toString(16).padStart(8, "0")}`;
}
