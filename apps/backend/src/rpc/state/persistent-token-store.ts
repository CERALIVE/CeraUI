/**
 * The remembered-browser token file, with its read state kept.
 *
 * Only a `valid` or `absent` read may seed a whole-file token write. An
 * Damaged/unavailable membership is reread, never used for a remembered-login
 * replacement. Only explicit revoke-all/password change may reset it; damaged
 * bytes are revalidated and archived at that boundary. The records object is owned by
 * the caller's module instance, so each import of the auth procedures has its
 * own store.
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
		if (this.writable) return true;
		return explicitRevocation && this.#state === "damaged" && this.#archive();
	}

	/** Replace the file with `records`; callers check {@link prepareWrite} first. */
	save(): void {
		writeFileAtomicSync(this.#path, JSON.stringify(this.records));
		this.#state = "valid";
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
	}

	async #settleOnce(): Promise<void> {
		this.#read();
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
