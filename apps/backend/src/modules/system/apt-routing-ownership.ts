import type { run } from "../../helpers/run.ts";
import {
	type AptRoutingEntry,
	type AptRoutingStore,
	aptRoutingEntrySchema,
	aptRoutingFileStore,
	entryKey,
} from "./apt-routing-journal.ts";

export class AptRoutingRefusal extends Error {
	override readonly name = "AptRoutingRefusal";
	constructor(
		readonly reason:
			| "busy"
			| "cleanup-pending"
			| "unjournaled-state"
			| "operation-failed"
			| "journal-unavailable",
		cause?: unknown,
	) {
		super(`APT routing: ${reason}`, { cause });
	}
}
export type AptRoutingLease = {
	readonly runner: typeof run;
	readonly release: () => void;
};
export type AptRoutingOwnership = {
	readonly acquire: (
		runner: typeof run,
		uid: number,
	) => Promise<AptRoutingLease>;
};
const prefix = (family: 4 | 6): string[] => (family === 6 ? ["-6"] : []);
const absent = (error: unknown): boolean =>
	error instanceof Error &&
	"stderr" in error &&
	typeof error.stderr === "string" &&
	(/^(?:RTNETLINK answers: )?(?:No such file or directory|No such process)$/.test(
		error.stderr.trim(),
	) ||
		/^(?:(?:RTNETLINK answers: |Error: )?(?:ipv[46]: )?)?FIB table does not exist\.?(?:\nDump terminated)?$/.test(
			error.stderr.trim(),
		));

export function createAptRoutingOwnership(
	store: AptRoutingStore = aptRoutingFileStore(),
	now: () => number = () => performance.now(),
): AptRoutingOwnership {
	let busy = false;
	let retained: readonly AptRoutingEntry[] | undefined;
	let dirty = false;
	return {
		async acquire(raw, uid) {
			if (busy) throw new AptRoutingRefusal("busy");
			busy = true;
			let deadline = now() + 10_000;
			const bounded: typeof run = (bin, args, options = {}) => {
				const remaining = deadline - now();
				if (remaining <= 0) throw new AptRoutingRefusal("cleanup-pending");
				return raw(bin, args, {
					...options,
					timeout: Math.min(options.timeout ?? remaining, remaining),
				});
			};
			let entries: readonly AptRoutingEntry[];
			const save = (next: readonly AptRoutingEntry[]) => {
				retained = next;
				dirty = true;
				store.save(next);
				entries = next;
				dirty = false;
			};
			const remove = async (entry: AptRoutingEntry, runner: typeof run) => {
				const args = [...entry.args];
				args[1] = "del";
				try {
					await runner("ip", [...prefix(entry.family), ...args]);
				} catch (error) {
					// Netdev removal already deletes its routes; ip resolves dev before netlink.
					const devIndex = entry.args.indexOf("dev");
					const missingDevice =
						entry.args[0] === "route" &&
						devIndex >= 0 &&
						error instanceof Error &&
						"stderr" in error &&
						typeof error.stderr === "string" &&
						error.stderr.trim() ===
							`Cannot find device "${entry.args[devIndex + 1]}"`;
					if (!absent(error) && !missingDevice) throw error;
				}
				save(entries.filter((row) => entryKey(row) !== entryKey(entry)));
			};
			try {
				entries = retained ?? (await store.read());
				retained = entries;
				if (entries.length || dirty) {
					for (const entry of [...entries].reverse())
						await remove(entry, bounded);
					if (dirty) save(entries);
					throw new AptRoutingRefusal("cleanup-pending");
				}
				for (const family of [4, 6] as const) {
					const rules = await bounded("ip", [
						...prefix(family),
						"rule",
						"show",
					]);
					if (
						rules
							.split("\n")
							.some(
								(line) =>
									/^\s*120:/.test(line) &&
									new RegExp(`\\buidrange ${uid}-${uid}\\b`).test(line),
							)
					)
						throw new AptRoutingRefusal("unjournaled-state");
					let routes = "";
					try {
						routes = await bounded("ip", [
							...prefix(family),
							"route",
							"show",
							"table",
							"100000",
						]);
					} catch (error) {
						if (!absent(error)) throw error;
					}
					if (routes.trim()) throw new AptRoutingRefusal("unjournaled-state");
				}
			} catch (error) {
				busy = false;
				if (error instanceof AptRoutingRefusal) throw error;
				throw new AptRoutingRefusal("journal-unavailable", error);
			}
			let cleaning = false;
			const cleanupRunner: typeof run = (...args) => {
				if (!cleaning) {
					deadline = now() + 10_000;
					cleaning = true;
				}
				return bounded(...args);
			};
			const execute: typeof run = async (bin, args, options) => {
				const family = args[0] === "-6" ? 6 : 4;
				const tokens = args.filter((arg) => arg !== "-6");
				if (bin !== "ip") throw new AptRoutingRefusal("unjournaled-state");
				if (tokens[1] === "add") {
					if (entries.length === 0) cleaning = false;
					const parsed = aptRoutingEntrySchema.safeParse({
						family,
						args: tokens,
					});
					if (!parsed.success)
						throw new AptRoutingRefusal("unjournaled-state", parsed.error);
					const entry = parsed.data;
					if (entries.some((row) => entryKey(row) === entryKey(entry)))
						throw new AptRoutingRefusal("unjournaled-state");
					save([...entries, entry]);
					return raw(bin, args, options);
				}
				if (tokens[1] === "del") {
					const add = [...tokens];
					add[1] = "add";
					const entry = entries.find(
						(row) =>
							row.family === family && row.args.join(" ") === add.join(" "),
					);
					if (entry) await remove(entry, cleanupRunner);
					return "";
				}
				if (tokens[0] === "route" && tokens[1] === "flush") {
					for (const entry of [...entries].reverse())
						if (entry.family === family && entry.args[0] === "route")
							await remove(entry, cleanupRunner);
					return "";
				}
				return raw(bin, args, options);
			};
			return {
				runner: async (...args) => {
					try {
						return await execute(...args);
					} catch (error) {
						if (error instanceof AptRoutingRefusal) throw error;
						throw new AptRoutingRefusal("operation-failed", error);
					}
				},
				release() {
					busy = false;
					if (entries.length || dirty)
						throw new AptRoutingRefusal("cleanup-pending");
					retained = undefined;
				},
			};
		},
	};
}

export const aptRoutingOwnership = createAptRoutingOwnership();
