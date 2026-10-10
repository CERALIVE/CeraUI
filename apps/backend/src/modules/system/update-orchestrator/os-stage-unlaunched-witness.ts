import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { osChannelManifestSchema } from "./os-manifest.ts";
import {
	type ReceiptFileIdentity,
	receiptFileIdentitySchema,
} from "./os-receipt-file-identity.ts";
import { OsStageError } from "./os-stage-error.ts";
import { osStageCandidateKey } from "./os-stage-retry.ts";

export const OS_UNLAUNCHED_WITNESS_PATH =
	"/data/ceralive/update-state/os-unlaunched-settlement.json";
export type OsUnlaunchedWitnessInput = {
	readonly attemptId: string;
	readonly manifestJson: string;
	readonly bootId: string;
	readonly baselineInstance: string;
	readonly receiptBaseline?: ReceiptFileIdentity | null;
};
export type OsUnlaunchedWitnessDeps = {
	readonly path: string;
	readonly uid: number;
};
const defaults: OsUnlaunchedWitnessDeps = {
	path: OS_UNLAUNCHED_WITNESS_PATH,
	uid: 0,
};
const MAX_BYTES = 16_384;
const witnessSchema = z
	.object({
		schema: z.literal(1),
		attemptId: z.uuid(),
		manifest: osChannelManifestSchema,
		candidateKey: z.string().min(1),
		bootId: z.uuid(),
		baselineInstance: z.string().regex(/^[1-9][0-9]*:[0-9]+$/),
		receiptBaseline: receiptFileIdentitySchema.nullable().optional(),
		disposition: z.literal("unlaunched-unchanged"),
		completion: z.literal("physically-settled"),
	})
	.strict();
type Witness = Readonly<z.infer<typeof witnessSchema>>;
type Settlement = Pick<
	Witness,
	| "attemptId"
	| "candidateKey"
	| "bootId"
	| "baselineInstance"
	| "disposition"
	| "receiptBaseline"
>;

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function openParent(deps: OsUnlaunchedWitnessDeps): number {
	const fd = openSync(
		dirname(deps.path),
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const info = fstatSync(fd);
		if (info.uid !== deps.uid || (info.mode & 0o022) !== 0)
			throw new OsStageError("rauc_recovery_unproven");
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

// Anchor every entry operation to the validated open directory, not a re-resolved path.
function entryPath(parent: number, name: string): string {
	return `/proc/self/fd/${parent}/${name}`;
}

function readWitness(
	parent: number,
	deps: OsUnlaunchedWitnessDeps,
): Witness | null {
	let fd: number;
	try {
		fd = openSync(
			entryPath(parent, basename(deps.path)),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
	try {
		const info = fstatSync(fd);
		if (
			!info.isFile() ||
			info.uid !== deps.uid ||
			info.nlink !== 1 ||
			(info.mode & 0o7777) !== 0o600 ||
			info.size > MAX_BYTES
		)
			throw new OsStageError("rauc_recovery_unproven");
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length !== info.size) throw new OsStageError("rauc_recovery_unproven");
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, length),
		);
		const witness = witnessSchema.parse(JSON.parse(raw));
		if (
			witness.candidateKey !== osStageCandidateKey(witness.manifest) ||
			raw !== JSON.stringify(witness)
		)
			throw new OsStageError("rauc_recovery_unproven");
		return witness;
	} finally {
		closeSync(fd);
	}
}

export function writeOsUnlaunchedWitness(
	input: OsUnlaunchedWitnessInput,
	deps: OsUnlaunchedWitnessDeps = defaults,
): void {
	try {
		writeWitness(input, deps);
	} catch (error) {
		throw new OsStageError("rauc_recovery_unproven", { cause: error });
	}
}

function writeWitness(
	input: OsUnlaunchedWitnessInput,
	deps: OsUnlaunchedWitnessDeps,
): void {
	let parent: number | undefined;
	let temporary: string | undefined;
	try {
		const manifest = osChannelManifestSchema.parse(
			JSON.parse(input.manifestJson),
		);
		const witness = witnessSchema.parse({
			schema: 1,
			attemptId: input.attemptId,
			manifest,
			candidateKey: osStageCandidateKey(manifest),
			bootId: input.bootId,
			baselineInstance: input.baselineInstance,
			...(input.receiptBaseline !== undefined
				? { receiptBaseline: input.receiptBaseline }
				: {}),
			disposition: "unlaunched-unchanged",
			completion: "physically-settled",
		});
		const value = JSON.stringify(witness);
		if (Buffer.byteLength(value) > MAX_BYTES)
			throw new OsStageError("rauc_recovery_unproven");
		parent = openParent(deps);
		const existing = readWitness(parent, deps);
		if (existing && JSON.stringify(existing) !== value)
			throw new OsStageError("rauc_recovery_unproven");
		temporary = entryPath(parent, `.${basename(deps.path)}.${randomUUID()}`);
		const fd = openSync(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const info = fstatSync(fd);
			if (
				info.uid !== deps.uid ||
				info.nlink !== 1 ||
				(info.mode & 0o7777) !== 0o600
			)
				throw new OsStageError("rauc_recovery_unproven");
			writeFileSync(fd, value);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, entryPath(parent, basename(deps.path)));
		temporary = undefined;
		fsyncSync(parent);
	} finally {
		try {
			if (temporary !== undefined) unlinkSync(temporary);
		} finally {
			if (parent !== undefined) closeSync(parent);
		}
	}
}

export function readOsUnlaunchedWitness(
	deps: OsUnlaunchedWitnessDeps = defaults,
): Settlement | null {
	let parent: number | undefined;
	try {
		parent = openParent(deps);
		const witness = readWitness(parent, deps);
		if (!witness) return null;
		const {
			attemptId,
			candidateKey,
			bootId,
			baselineInstance,
			disposition,
			receiptBaseline,
		} = witness;
		return {
			attemptId,
			candidateKey,
			bootId,
			baselineInstance,
			disposition,
			...(receiptBaseline !== undefined ? { receiptBaseline } : {}),
		};
	} catch (error) {
		if (parent === undefined && missing(error)) return null;
		throw new OsStageError("rauc_recovery_unproven", { cause: error });
	} finally {
		if (parent !== undefined) closeSync(parent);
	}
}

export function consumeOsUnlaunchedWitness(
	attemptId: string,
	deps: OsUnlaunchedWitnessDeps = defaults,
): void {
	let parent: number | undefined;
	try {
		parent = openParent(deps);
		const witness = readWitness(parent, deps);
		if (!witness || witness.attemptId !== attemptId) return;
		unlinkSync(entryPath(parent, basename(deps.path)));
		fsyncSync(parent);
	} catch (error) {
		if (parent === undefined && missing(error)) return;
		throw new OsStageError("rauc_recovery_unproven", { cause: error });
	} finally {
		if (parent !== undefined) closeSync(parent);
	}
}
