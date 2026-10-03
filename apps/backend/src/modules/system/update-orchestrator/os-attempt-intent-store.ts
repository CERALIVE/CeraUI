import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import {
	type OsAttemptIntent,
	osAttemptIntentSchema,
} from "./os-attempt-intent.ts";
import { OsStageError } from "./os-stage-error.ts";
import { orchestratorStateFilePath } from "./persistence.ts";

const MAX_BYTES = 65_536;
export const OS_ATTEMPT_INTENT_NAME = "os-attempt-intent.json";
export type OsAttemptIntentStorage = {
	readonly path: string;
	readonly uid: number;
	readonly syncParent?: (path: string) => void;
};

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class OsAttemptIntentStore {
	constructor(readonly storage: OsAttemptIntentStorage) {}

	#parent(): number {
		const fd = openSync(
			dirname(this.storage.path),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			const info = fstatSync(fd);
			if (info.uid !== this.storage.uid || (info.mode & 0o022) !== 0)
				throw new OsStageError("rauc_recovery_unproven");
			return fd;
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	#path(parent: number, name = basename(this.storage.path)): string {
		return `/proc/self/fd/${parent}/${name}`;
	}

	#read(parent: number): OsAttemptIntent | null {
		let fd: number;
		try {
			fd = openSync(
				this.#path(parent),
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
				info.uid !== this.storage.uid ||
				info.nlink !== 1 ||
				(info.mode & 0o7777) !== 0o600 ||
				info.size > MAX_BYTES
			)
				throw new OsStageError("rauc_recovery_unproven");
			const bytes = Buffer.alloc(MAX_BYTES + 1);
			const length = readSync(fd, bytes, 0, bytes.length, 0);
			if (length !== info.size)
				throw new OsStageError("rauc_recovery_unproven");
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, length),
			);
			const intent = osAttemptIntentSchema.parse(JSON.parse(raw));
			if (raw !== JSON.stringify(intent))
				throw new OsStageError("rauc_recovery_unproven");
			return intent;
		} finally {
			closeSync(fd);
		}
	}

	read(): OsAttemptIntent | null {
		let parent: number | undefined;
		try {
			parent = this.#parent();
			return this.#read(parent);
		} catch (cause) {
			if (parent === undefined && missing(cause)) return null;
			throw new OsStageError("rauc_recovery_unproven", { cause });
		} finally {
			if (parent !== undefined) closeSync(parent);
		}
	}

	write(intent: OsAttemptIntent, expected: OsAttemptIntent | null): void {
		let parent: number | undefined;
		let temporary: string | undefined;
		try {
			const value = JSON.stringify(osAttemptIntentSchema.parse(intent));
			if (Buffer.byteLength(value) > MAX_BYTES)
				throw new OsStageError("rauc_recovery_unproven");
			mkdirSync(dirname(this.storage.path), { recursive: true, mode: 0o700 });
			parent = this.#parent();
			if (!isDeepStrictEqual(this.#read(parent), expected))
				throw new OsStageError("rauc_recovery_unproven");
			temporary = this.#path(
				parent,
				`.${basename(this.storage.path)}.${randomUUID()}`,
			);
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
					info.uid !== this.storage.uid ||
					info.nlink !== 1 ||
					(info.mode & 0o7777) !== 0o600
				)
					throw new OsStageError("rauc_recovery_unproven");
				writeFileSync(fd, value);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, this.#path(parent));
			temporary = undefined;
			(this.storage.syncParent ?? syncOrchestratorDirectory)(
				this.#path(parent),
			);
		} catch (cause) {
			throw new OsStageError("rauc_recovery_unproven", { cause });
		} finally {
			try {
				if (temporary !== undefined) unlinkSync(temporary);
			} finally {
				if (parent !== undefined) closeSync(parent);
			}
		}
	}

	synchronize(): void {
		const parent = this.#parent();
		try {
			(this.storage.syncParent ?? syncOrchestratorDirectory)(
				this.#path(parent),
			);
		} catch (cause) {
			throw new OsStageError("rauc_recovery_unproven", { cause });
		} finally {
			closeSync(parent);
		}
	}

	retire(expected: OsAttemptIntent): void {
		const parent = this.#parent();
		try {
			const current = this.#read(parent);
			if (!current) return;
			if (!isDeepStrictEqual(current, expected))
				throw new OsStageError("rauc_recovery_unproven");
			unlinkSync(this.#path(parent));
			(this.storage.syncParent ?? syncOrchestratorDirectory)(
				this.#path(parent),
			);
		} catch (cause) {
			throw new OsStageError("rauc_recovery_unproven", { cause });
		} finally {
			closeSync(parent);
		}
	}
}

export function osAttemptIntentStore(): OsAttemptIntentStore {
	return new OsAttemptIntentStore({
		path: join(dirname(orchestratorStateFilePath()), OS_ATTEMPT_INTENT_NAME),
		uid: process.getuid?.() ?? 0,
	});
}
