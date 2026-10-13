/**
 * The remembered-browser token file, with its read state kept.
 *
 * Only a `valid` or `absent` read may seed a whole-file token write. An
 * `unavailable` file (EIO/EAGAIN, a short or changed read) is reread on the next
 * auth operation and never written over from an empty set; a `damaged` one is
 * archived, at the first write that would replace it, before a fresh record
 * does; reading alone never rewrites it. The records object is owned by
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
	readPersistentRecord,
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
		await store.#read();
		return store;
	}

	/** True when a whole-file write may start from `records`. */
	get writable(): boolean {
		return this.#state === "valid" || this.#state === "absent";
	}

	get unavailable(): boolean {
		return this.#state === "unavailable";
	}

	/** Reread an unavailable store before an auth operation consults it. */
	settle(): Promise<void> {
		this.#settling ??= this.#settleOnce().finally(() => {
			this.#settling = undefined;
		});
		return this.#settling;
	}

	/**
	 * Ready a write derived from `records`. A damaged file is archived first and
	 * the write continues from a fresh record; an unavailable one refuses.
	 * Reading alone never archives or rewrites anything.
	 */
	prepareWrite(): boolean {
		if (this.writable) return true;
		return this.#state === "damaged" && this.#archive();
	}

	/** Replace the file with `records`; callers check {@link prepareWrite} first. */
	save(): void {
		writeFileAtomicSync(this.#path, JSON.stringify(this.records));
		this.#state = "valid";
	}

	async #read(): Promise<void> {
		const read = await readPersistentRecord(
			this.#path,
			STORED_STATE_LIMITS.packages,
			(json) => authTokensSchema.parse(json),
		);
		this.#state = read.kind;
		if (read.kind === "valid") Object.assign(this.records, read.value);
		if (read.kind === "damaged") this.#damaged = read.bytes;
	}

	async #settleOnce(): Promise<void> {
		if (this.#state === "unavailable") await this.#read();
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
