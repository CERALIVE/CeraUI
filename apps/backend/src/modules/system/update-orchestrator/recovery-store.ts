import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const RECOVERY_DIR = "/data/ceralive/update-state";
export const AGENT_FILE = join(RECOVERY_DIR, "agent.json");
export const PLAN_FILE = join(RECOVERY_DIR, "pending-packages.json");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryIdentitySchema = z
	.object({
		agentSha256: hashSchema,
		planSha256: hashSchema,
		bootId: z.uuid(),
		slot: z.string().regex(/^rootfs\.[01]$/),
		compatible: z.literal("ceralive-rock-5b-plus"),
		osVersion: z.string().regex(/^[0-9]{4}\.[0-9]+\.[0-9]+$/),
	})
	.strict();
export type RecoveryIdentity = z.infer<typeof recoveryIdentitySchema>;
export const recoveryReceiptSchema = z
	.object({
		schema: z.literal(1),
		id: hashSchema,
		decision: z.literal("historical_outcome_unresolved_current_slot_unapplied"),
		identity: recoveryIdentitySchema,
		agentBase64: z.string().min(1),
		planBase64: z.string().min(1),
		clearedAgentSha256: hashSchema,
		decidedAt: z.number().int().nonnegative(),
	})
	.strict();
export type RecoveryReceipt = z.infer<typeof recoveryReceiptSchema>;

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface RecoveryStore {
	read(path: string): Promise<Buffer | null>;
	list(path: string): Promise<readonly string[]>;
	readReceipt(id: string): Promise<RecoveryReceipt | null>;
	writeReceipt(receipt: RecoveryReceipt): Promise<void>;
	archivePlan(): Promise<void>;
	writeState(bytes: Buffer): Promise<void>;
}

async function readOptional(path: string): Promise<Buffer | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	try {
		if (!(await handle.stat()).isFile())
			throw new RecoveryStoreError("not_regular_file");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function durableReplace(path: string, bytes: Buffer): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.recovery-${randomUUID()}.tmp`);
	const handle = await open(
		temp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, path);
	await syncDirectory(dir);
}

export class RecoveryStoreError extends Error {
	override readonly name = "RecoveryStoreError";
	constructor(readonly reason: string) {
		super(reason);
	}
}

export function fileRecoveryStore(dir = RECOVERY_DIR): RecoveryStore {
	const receiptPath = (id: string) =>
		join(dir, `recovery-${hashSchema.parse(id)}.json`);
	return {
		read: (path) => readOptional(join(dir, basename(path))),
		list: async (path) => readdir(path),
		readReceipt: async (id) => {
			const bytes = await readOptional(receiptPath(id));
			if (bytes) await syncDirectory(dir);
			return bytes
				? recoveryReceiptSchema.parse(JSON.parse(bytes.toString("utf8")))
				: null;
		},
		writeReceipt: async (receipt) => {
			if (await readOptional(receiptPath(receipt.id)))
				throw new RecoveryStoreError("receipt_exists");
			await durableReplace(
				receiptPath(receipt.id),
				Buffer.from(JSON.stringify(recoveryReceiptSchema.parse(receipt))),
			);
		},
		archivePlan: async () => {
			if (await readOptional(join(dir, "pending-packages.json")))
				await unlink(join(dir, "pending-packages.json"));
			await syncDirectory(dir);
		},
		writeState: (bytes) => durableReplace(join(dir, "agent.json"), bytes),
	};
}
