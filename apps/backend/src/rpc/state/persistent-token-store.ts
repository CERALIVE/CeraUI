/**
 * The remembered-browser token file, with its read state kept.
 *
 * Only a `valid` or `absent` read may seed a whole-file token write.
 * Damaged/unavailable membership is reread, never used for a remembered-login
 * replacement. Only explicit revoke-all/password change may reset it; damaged
 * bytes are revalidated and archived at that boundary. The records object is owned by
 * the caller's module instance, so each import of the auth procedures has its
 * own store. Pending revocations filter every read until a successful save.
 */

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import {
	type AuthTokens,
	authTokensSchema,
} from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import {
	preserveDamagedRecord,
	readPersistentRecordSync,
} from "../../helpers/persistent-record.ts";
import { STORED_STATE_LIMITS } from "../../modules/system/update-orchestrator/stored-state-file.ts";

type StoreState = "absent" | "valid" | "damaged" | "unavailable";

export class PersistentTokenStore {
	readonly records: AuthTokens = {};
	readonly #path: string;
	#state: StoreState = "unavailable";
	#damaged: Buffer | undefined;
	#settling: Promise<void> | undefined;
	#revokeAll = false;
	readonly #revoked = new Set<string>();
	#stopped = false;

	private constructor(path: string) {
		this.#path = path;
	}

	static async open(path: string): Promise<PersistentTokenStore> {
		const store = new PersistentTokenStore(path);
		store.#read();
		return store;
	}

	/** True when a whole-file write may start from `records`. */
	get writable(): boolean {
		return this.#state === "valid" || this.#state === "absent";
	}

	get unavailable(): boolean {
		return this.#state === "unavailable";
	}

	/** Reread authority before an auth operation consults it. */
	settle(): Promise<void> {
		this.#settling ??= this.#settleOnce().finally(() => {
			this.#settling = undefined;
		});
		return this.#settling;
	}

	/**
	 * Revalidate immediately before a synchronous replacement. A remembered login
	 * refuses unknown membership; only explicit revocation may archive/reset it.
	 * Reading alone never archives or rewrites anything.
	 */
	prepareWrite(explicitRevocation = false): boolean {
		this.#read();
		if (this.#revokeAll && !explicitRevocation) return false;
		if (this.writable) return true;
		return explicitRevocation && this.#state === "damaged" && this.#archive();
	}

	/** Replace the file with `records`; callers check {@link prepareWrite} first. */
	save(): void {
		this.#filterRevocations();
		for (const key of Object.keys(this.records))
			if (!/^[0-9a-f]{64}$/.test(key)) delete this.records[key];
		writeFileAtomicSync(this.#path, JSON.stringify(this.records));
		this.#state = "valid";
		this.#revokeAll = false;
		this.#revoked.clear();
	}

	/** Record intent before I/O; a failed write must not re-admit this credential. */
	revoke(record?: string): number {
		const count =
			record === undefined
				? Object.keys(this.records).length
				: Number(this.records[record] === true);
		if (record === undefined) this.#revokeAll = true;
		else this.#revoked.add(record);
		this.#filterRevocations();
		this.#persistRevocations();
		return count;
	}

	stop(): void {
		this.#stopped = true;
	}

	#filterRevocations(): void {
		for (const record of Object.keys(this.records))
			if (this.#revokeAll || this.#revoked.has(record))
				delete this.records[record];
	}

	#persistRevocations(): void {
		if (
			this.prepareWrite(this.#revokeAll) ||
			(this.#revokeAll && this.unavailable)
		)
			this.save();
	}

	#read(): void {
		const read = readPersistentRecordSync(
			this.#path,
			STORED_STATE_LIMITS.packages,
			(json) => authTokensSchema.parse(json),
		);
		this.#state = read.kind;
		for (const record of Object.keys(this.records)) delete this.records[record];
		this.#damaged = undefined;
		if (read.kind === "valid") Object.assign(this.records, read.value);
		if (read.kind === "damaged") this.#damaged = read.bytes;
		this.#filterRevocations();
	}

	async #settleOnce(): Promise<void> {
		this.#read();
		if (!this.#stopped && (this.#revokeAll || this.#revoked.size > 0)) {
			try {
				this.#persistRevocations();
			} catch (error) {
				logger.warn(
					"Auth: revocation not persisted; retained for next operation",
					{ error },
				);
			}
		}
		if (!this.writable)
			logger.warn(
				"Auth: stored token authority unreadable; token login withheld",
				{ state: this.#state },
			);
	}

	#archive(): boolean {
		if (this.#damaged === undefined) return false;
		try {
			const copy = preserveDamagedRecord(this.#path, this.#damaged);
			this.#state = "valid";
			this.#damaged = undefined;
			logger.warn(
				"Auth: damaged stored tokens archived; remembered browsers sign in again",
				{ copy },
			);
			return true;
		} catch (error) {
			logger.error("Auth: damaged stored tokens could not be archived", {
				error,
			});
			return false;
		}
	}
}
