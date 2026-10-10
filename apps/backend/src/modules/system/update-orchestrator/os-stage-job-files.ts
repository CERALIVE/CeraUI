import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	openSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { receiptFileIdentitySchema } from "./os-receipt-file-identity.ts";
import { OsStageError } from "./os-stage-error.ts";

export const OS_STAGE_JOB_DIR = "/run/ceralive/os-stage";
export const OS_STAGE_GUARD_UNIT = "ceralive-os-stage-guard.service";
export const OS_STAGE_GUARD_HELPER =
	"/usr/libexec/ceralive/ceralive-os-stage-guard";
const snapshotSchema = z
	.object({
		instance: z.string().min(1),
		active: z.boolean(),
		operation: z.string().nullable(),
		processes: z.array(z.string()).readonly(),
		resources: z.array(z.string()).readonly(),
		bootId: z.string().min(1),
		bootPrimary: z.string().min(1).nullable().default(null),
		bootedSlot: z.string().min(1),
		bootedDevice: z.string().min(1),
		bootedHealthy: z.boolean(),
		targetSlot: z.string().min(1),
		targetDevice: z.string().min(1),
		targetInactive: z.boolean(),
		activationArmed: z.boolean(),
	})
	.strict();
export const osStageJobSchema = z
	.object({
		schema: z.literal(1),
		attemptId: z.uuid(),
		candidateKey: z.string().min(1),
		bundleUrl: z.url(),
		baseline: snapshotSchema,
		receiptBaseline: receiptFileIdentitySchema.nullable().optional(),
		processes: z.array(z.string()),
		resources: z.array(z.string()),
		launched: z.boolean(),
		cliSettled: z.boolean(),
		requireNewInstance: z.boolean(),
		lifecycle: z.enum(["acquiring", "held", "releasing"]).optional(),
		pair: z.string().optional(),
	})
	.strict();
export type OsStageJobRecord = z.infer<typeof osStageJobSchema>;

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readOsJobFile(
	name: "token" | "ready" | "release" | "job.json",
	directory = OS_STAGE_JOB_DIR,
	uid = 0,
): Promise<string | null> {
	const dir = await lstat(directory).catch((error: unknown) => {
		if (missing(error)) return null;
		throw error;
	});
	if (!dir) return null;
	if (
		!dir.isDirectory() ||
		dir.isSymbolicLink() ||
		dir.uid !== uid ||
		(dir.mode & 0o777) !== 0o700
	)
		throw new OsStageError("rauc_recovery_unproven");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			join(directory, name),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
	try {
		const file = await handle.stat();
		if (
			!file.isFile() ||
			file.uid !== uid ||
			file.nlink !== 1 ||
			(file.mode & 0o777) !== 0o600 ||
			file.size > 262144
		)
			throw new OsStageError("rauc_recovery_unproven");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export async function prepareOsStageJob(
	record: OsStageJobRecord,
	directory = OS_STAGE_JOB_DIR,
	uid = 0,
): Promise<void> {
	const parent = join(directory, "..");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const owner = await lstat(parent);
	if (
		!owner.isDirectory() ||
		owner.isSymbolicLink() ||
		owner.uid !== uid ||
		owner.mode & 0o022
	)
		throw new OsStageError("rauc_recovery_unproven");
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST")
			throw new OsStageError("os_update_lock_held", { cause: error });
		throw error;
	}
	await chmod(directory, 0o700);
	writePrivateOsJobFile("token", `${record.attemptId}\n`, directory);
	writeOsStageJob(record, directory);
}

export function writeOsStageJob(
	record: OsStageJobRecord,
	directory = OS_STAGE_JOB_DIR,
): void {
	writePrivateOsJobFile(
		"job.json",
		JSON.stringify(osStageJobSchema.parse(record)),
		directory,
	);
}

export function writePrivateOsJobFile(
	name: "token" | "release" | "job.json",
	value: string,
	directory = OS_STAGE_JOB_DIR,
): void {
	const temporary = join(directory, `.${name}.${randomUUID()}`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, value);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, join(directory, name));
	const parent = openSync(
		directory,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}

export async function readOsStageJob(
	directory = OS_STAGE_JOB_DIR,
	uid = 0,
): Promise<OsStageJobRecord | null> {
	const raw = await readOsJobFile("job.json", directory, uid);
	if (raw === null) return null;
	const record = osStageJobSchema.parse(JSON.parse(raw));
	if (
		(await readOsJobFile("token", directory, uid)) !== `${record.attemptId}\n`
	)
		throw new OsStageError("rauc_recovery_unproven");
	return record;
}

export async function retireOsStageJob(
	directory = OS_STAGE_JOB_DIR,
): Promise<void> {
	await rm(directory, { recursive: true });
}
