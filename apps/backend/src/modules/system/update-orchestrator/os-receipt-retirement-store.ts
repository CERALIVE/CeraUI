import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import type { OsStageReceipt } from "./os-agent.ts";
import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";

export const CONSUMED_RECEIPT_NAME = "os-staged.consumed.json";

export class ReceiptRetirementDurabilityError extends Error {
	override readonly name = "ReceiptRetirementDurabilityError";
	constructor(
		readonly renamed: boolean,
		cause: unknown,
	) {
		super("Receipt retirement directory acknowledgement pending", { cause });
	}
}

function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function retiredReceiptPresent(dir = OS_UPDATE_STATE_DIR): boolean {
	try {
		return lstatSync(join(dir, CONSUMED_RECEIPT_NAME)).isFile();
	} catch (error) {
		if (absent(error)) return false;
		throw error;
	}
}

export function acknowledgeRetiredReceipt(
	dir = OS_UPDATE_STATE_DIR,
	syncParent = syncOrchestratorDirectory,
): void {
	const consumed = join(dir, CONSUMED_RECEIPT_NAME);
	try {
		const inode = lstatSync(consumed);
		if (!inode.isFile() || inode.nlink !== 1) return;
	} catch (error) {
		if (absent(error)) return;
		throw error;
	}
	try {
		syncParent(consumed);
	} catch (cause) {
		throw new ReceiptRetirementDurabilityError(false, cause);
	}
}

export function retireStagedReceipt(
	judged: OsStageReceipt,
	dir = OS_UPDATE_STATE_DIR,
	syncParent = syncOrchestratorDirectory,
): boolean {
	const live = join(dir, "os-staged.json");
	let fd: number;
	try {
		fd = openSync(
			live,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (!absent(error)) throw error;
		acknowledgeRetiredReceipt(dir, syncParent);
		return false;
	}
	try {
		const inode = fstatSync(fd);
		if (!inode.isFile() || inode.nlink !== 1) return false;
		let current: unknown;
		try {
			current = JSON.parse(readFileSync(fd, "utf8"));
		} catch (error) {
			if (error instanceof SyntaxError) return false;
			throw error;
		}
		if (!isDeepStrictEqual(current, judged)) return false;
		const final = lstatSync(live);
		if (
			final.dev !== inode.dev ||
			final.ino !== inode.ino ||
			final.birthtimeMs !== inode.birthtimeMs
		)
			return false;
		renameSync(live, join(dir, CONSUMED_RECEIPT_NAME));
		try {
			syncParent(live);
		} catch (cause) {
			throw new ReceiptRetirementDurabilityError(true, cause);
		}
		return true;
	} finally {
		closeSync(fd);
	}
}
