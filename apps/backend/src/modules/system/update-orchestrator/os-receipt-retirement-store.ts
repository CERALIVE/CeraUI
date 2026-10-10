import { closeSync, lstatSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import type { JudgedOsReceipt } from "./os-agent.ts";
import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";
import {
	openReceiptDirectory,
	type ReceiptFileIdentity,
	readReceiptEntry,
	receiptEntryPath,
	sameReceiptFile,
} from "./os-receipt-file-identity.ts";

export const CONSUMED_RECEIPT_NAME = "os-staged.consumed.json";

// Only this process's successful directory sync grants an identity acknowledgement.
const acknowledged = new Map<string, ReceiptFileIdentity>();

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
	let parent: number;
	try {
		parent = openReceiptDirectory(dir);
	} catch (error) {
		if (absent(error)) return false;
		throw error;
	}
	try {
		const file = readReceiptEntry(parent, CONSUMED_RECEIPT_NAME);
		return (
			file !== null &&
			!sameReceiptFile(acknowledged.get(resolve(dir)), file.identity)
		);
	} finally {
		closeSync(parent);
	}
}

export function acknowledgeRetiredReceipt(
	dir = OS_UPDATE_STATE_DIR,
	syncParent = syncOrchestratorDirectory,
): void {
	let parent: number;
	try {
		parent = openReceiptDirectory(dir);
	} catch (error) {
		if (absent(error)) return;
		throw error;
	}
	const consumed = receiptEntryPath(parent, CONSUMED_RECEIPT_NAME);
	try {
		const file = readReceiptEntry(parent, CONSUMED_RECEIPT_NAME);
		if (!file || sameReceiptFile(acknowledged.get(resolve(dir)), file.identity))
			return;
		acknowledged.delete(resolve(dir));
		try {
			syncParent(consumed);
		} catch (cause) {
			throw new ReceiptRetirementDurabilityError(false, cause);
		}
		acknowledged.set(resolve(dir), file.identity);
	} finally {
		closeSync(parent);
	}
}

export function retireStagedReceipt(
	judged: JudgedOsReceipt,
	dir = OS_UPDATE_STATE_DIR,
	syncParent = syncOrchestratorDirectory,
): boolean {
	let parent: number;
	try {
		parent = openReceiptDirectory(dir);
	} catch (error) {
		if (!absent(error)) throw error;
		acknowledgeRetiredReceipt(dir, syncParent);
		return false;
	}
	try {
		const file = readReceiptEntry(parent);
		if (!file) {
			acknowledgeRetiredReceipt(dir, syncParent);
			return false;
		}
		if (!sameReceiptFile(judged.identity, file.identity)) return false;
		let current: unknown;
		try {
			current = JSON.parse(file.bytes.toString("utf8"));
		} catch (error) {
			if (error instanceof SyntaxError) return false;
			throw error;
		}
		if (!isDeepStrictEqual(current, judged.receipt)) return false;
		const live = receiptEntryPath(parent, "os-staged.json");
		const final = lstatSync(live, { bigint: true });
		if (
			final.dev.toString() !== judged.identity.dev ||
			final.ino.toString() !== judged.identity.ino ||
			final.size.toString() !== judged.identity.size ||
			final.mtimeNs.toString() !== judged.identity.mtimeNs
		)
			return false;
		// rename has no compare-and-swap: CONTROL must exclude every cooperative writer until sync.
		renameSync(live, receiptEntryPath(parent, CONSUMED_RECEIPT_NAME));
		acknowledged.delete(resolve(dir));
		try {
			syncParent(live);
		} catch (cause) {
			throw new ReceiptRetirementDurabilityError(true, cause);
		}
		acknowledged.set(resolve(dir), file.identity);
		return true;
	} finally {
		closeSync(parent);
	}
}
