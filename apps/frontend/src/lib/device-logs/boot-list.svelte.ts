/**
 * One boot picker's copy of `logs.boots()`. A failed read keeps the last good
 * list on screen behind the failure, and only the newest read may settle, so a
 * slow earlier reply never replaces a fresher list.
 */
import type { LogBootInfo } from "@ceraui/rpc/schemas";

import { isMissingProcedure } from "./viewer-availability";

/**
 * Whether the header boot button can be offered: its copy must load, and only a
 * device without the boot list (an older backend) withholds it. Any other read
 * failure still offers it, because the picker it opens can retry.
 */
export async function canListBoots(
	loadCopy: () => Promise<void>,
	read: () => Promise<unknown>,
): Promise<boolean> {
	const missing = Promise.resolve()
		.then(read)
		.then(() => false, isMissingProcedure);
	try {
		await loadCopy();
	} catch (error) {
		console.error("System Logs boot picker could not load its copy:", error);
		return false;
	}
	return !(await missing);
}

export class BootList {
	boots = $state.raw<readonly LogBootInfo[] | null>(null);
	failed = $state(false);
	#latest: object | undefined;
	readonly #read: () => Promise<LogBootInfo[]>;

	constructor(read: () => Promise<LogBootInfo[]>) {
		this.#read = read;
	}

	load(): Promise<void> {
		const read = {};
		this.#latest = read;
		this.failed = false;
		return Promise.resolve()
			.then(this.#read)
			.then(
				(boots) => {
					if (read === this.#latest) this.boots = boots;
				},
				(error: unknown) => {
					if (read !== this.#latest) return;
					console.error("System Logs boot list failed to load:", error);
					this.failed = true;
				},
			);
	}
}
