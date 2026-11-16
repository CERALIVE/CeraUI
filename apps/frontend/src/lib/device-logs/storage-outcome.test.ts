import { afterEach, describe, expect, it, vi } from "vitest";

import {
	logStorage,
	MIB,
} from "../../main/system-logs/__fixtures__/log-storage";
import {
	type ActionReply,
	deleteOlderReply,
	fromSuccess,
	saveNote,
	settleAction,
	storageReply,
} from "./storage-outcome";
import { parseStorage } from "./storage-readout";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("settleAction", () => {
	it("hands back an ok reply as its reader read it", async () => {
		const reply = {
			ok: true as const,
			storage: logStorage(),
			bootsBefore: 3,
			bootsAfter: 1,
		};
		expect(
			await settleAction(() => Promise.resolve(reply), deleteOlderReply),
		).toEqual(reply);
	});

	it("names an update in progress a refusal", async () => {
		expect(
			await settleAction(
				() =>
					Promise.resolve({
						ok: false as const,
						error: "UPDATE_IN_PROGRESS" as const,
					}),
				storageReply,
			),
		).toBe("refused");
	});

	it.each(["READ_FAILED", "INVALID_RETENTION", "BUSY"] as const)(
		"names any other error reply (%s) a failure",
		async (error) => {
			expect(
				await settleAction(
					() => Promise.resolve({ ok: false as const, error }),
					storageReply,
				),
			).toBe("failed");
		},
	);

	it("turns a rejected or throwing call into a reported failure", async () => {
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		const rejection = new Error("Request timeout: logs.clearAll");

		expect(
			await settleAction(() => Promise.reject(rejection), storageReply),
		).toBe("failed");
		expect(report).toHaveBeenCalledExactlyOnceWith(
			"System Logs storage action failed:",
			rejection,
		);

		const thrown = new TypeError("rpc.logs is undefined");
		expect(
			await settleAction(() => {
				throw thrown;
			}, storageReply),
		).toBe("failed");
		expect(report).toHaveBeenLastCalledWith(
			"System Logs storage action failed:",
			thrown,
		);
	});

	it("turns a reply its reader rejects into a reported failure", async () => {
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		const malformed = new Error("storage is required");

		expect(
			await settleAction(
				() => Promise.resolve({ ok: true }),
				(): ActionReply => {
					throw malformed;
				},
			),
		).toBe("failed");
		expect(report).toHaveBeenCalledExactlyOnceWith(
			"System Logs storage action failed:",
			malformed,
		);
	});

	it("reports nothing for a reply, refused or not", async () => {
		const report = vi.spyOn(console, "error");
		await settleAction(
			() => Promise.resolve({ ok: true as const, storage: logStorage() }),
			storageReply,
		);
		await settleAction(
			() =>
				Promise.resolve({
					ok: false as const,
					error: "UPDATE_IN_PROGRESS" as const,
				}),
			storageReply,
		);
		expect(report).not.toHaveBeenCalled();
	});
});

describe("fromSuccess", () => {
	it("maps the events RPC's { success } answer onto an ok reply", () => {
		expect(fromSuccess({ success: true })).toEqual({ ok: true });
		expect(fromSuccess({ success: false })).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(fromSuccess({ success: false, error: "DEVICE_BUSY" })).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
	});
});

const storage = logStorage({
	legacyDebugBytes: 5 * MIB,
	lastMaintenance: { at: 2_000, ok: true, targetMet: true },
	lastClearedAt: 1_500,
});

type Member = readonly [path: string, nullable: boolean, wrongType: unknown];

/** Every member of a storage reading: may it be null, and a value of the wrong type for it. */
const STORAGE_MEMBERS: readonly Member[] = [
	["journalBytes", true, "48"],
	["journalDirBytes", true, "48"],
	["legacyDebugBytes", false, "5"],
	["ceiling", true, "256"],
	["ceiling.maxSizeMb", false, "256"],
	["ceiling.maxAgeDays", false, "30"],
	["retention", false, "debug"],
	["retention.maxAgeDays", true, "7"],
	["retention.maxSizeMb", true, "64"],
	["retention.detail", false, 1],
	["oldestEntryTs", true, "2026-11-01"],
	["recentVolume", false, {}],
	["recentVolume.0.source", true, 7],
	["recentVolume.0.entries", false, "900"],
	["recentVolume.0.bytes", false, "90000"],
	["recentSample", false, "3312"],
	["eventsBytes", false, "18432"],
	["lastMaintenance", true, "today"],
	["lastMaintenance.at", false, "now"],
	["lastMaintenance.ok", false, "yes"],
	["lastMaintenance.targetMet", false, "no"],
	["lastClearedAt", true, "never"],
];

const within = (prefix: string): Member[] =>
	STORAGE_MEMBERS.map(([path, nullable, wrong]) => [
		prefix + path,
		nullable,
		wrong,
	]);

/** Every successful reply the Storage section reads, with its reader and every member it requires. */
const REPLIES: readonly [
	name: string,
	read: (reply: unknown) => unknown,
	reply: unknown,
	members: readonly Member[],
][] = [
	["logs.getStorage", parseStorage, storage, within("")],
	[
		"logs.setRetention, deleteLegacyDebug and clearAll",
		storageReply,
		{ ok: true, storage },
		[
			["ok", false, "true"],
			["storage", false, "storage"],
			...within("storage."),
		],
	],
	[
		"logs.deleteOlderFiles",
		deleteOlderReply,
		{ ok: true, storage, bootsBefore: 17, bootsAfter: 4 },
		[
			["ok", false, "true"],
			["storage", false, "storage"],
			["bootsBefore", false, "17"],
			["bootsAfter", false, "4"],
			...within("storage."),
		],
	],
	["events.clear", fromSuccess, { success: true }, [["success", false, "yes"]]],
];

type Shape = "absent" | "null" | "of the wrong type";

function reshaped(reply: unknown, path: string, shape: Shape, wrong: unknown) {
	const copy = structuredClone(reply) as Record<string, unknown>;
	const keys = path.split(".");
	const last = keys.pop() as string;
	const parent = keys.reduce<Record<string, unknown>>(
		(node, key) => node[key] as Record<string, unknown>,
		copy,
	);
	if (shape === "absent") delete parent[last];
	else parent[last] = shape === "null" ? null : wrong;
	return copy;
}

const CASES = REPLIES.flatMap(([name, read, reply, members]) =>
	members.flatMap(([path, nullable, wrong]) =>
		(["absent", "null", "of the wrong type"] as const).map((shape) => ({
			name,
			read,
			path,
			shape,
			reply: reshaped(reply, path, shape, wrong),
			valid: shape === "null" && nullable,
		})),
	),
);

describe("successful replies: every required member, absent, null or of the wrong type", () => {
	const schemaError = expect.objectContaining({ name: "ZodError" });

	it.each(CASES.filter((c) => !c.valid))(
		"rejects $name with $path $shape",
		({ read, reply }) => {
			expect(() => read(reply)).toThrow(schemaError);
		},
	);

	it.each(CASES.filter((c) => c.valid))(
		"reads $name with $path null, which its contract allows",
		({ read, reply }) => {
			expect(read(reply)).toEqual(reply);
		},
	);

	it.each(CASES.filter((c) => !c.valid && c.read !== parseStorage))(
		"settles $name with $path $shape as a reported failure",
		async ({ read, reply }) => {
			const report = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(
				await settleAction(
					() => Promise.resolve(reply),
					read as (reply: unknown) => ActionReply,
				),
			).toBe("failed");
			expect(report).toHaveBeenCalledOnce();
		},
	);

	it("still reads a reply that carries fields a newer device adds", () => {
		const reply = { ok: true, storage, bootsBefore: 17, bootsAfter: 4 };
		expect(
			deleteOlderReply({
				...reply,
				addedLater: 1,
				storage: { ...storage, alsoAddedLater: 2 },
			}),
		).toEqual(reply);
	});
});

describe("saveNote", () => {
	const earlier = { at: 1_000, ok: true, targetMet: false };

	it("is a plain save when no cleanup ran for it", () => {
		expect(saveNote(null, null)).toBe("saved");
		expect(saveNote(earlier, earlier)).toBe("saved");
		expect(saveNote(earlier, { ...earlier })).toBe("saved");
	});

	it("reports the cleanup this save ran", () => {
		expect(saveNote(null, { at: 2_000, ok: true, targetMet: true })).toBe(
			"saved",
		);
		expect(saveNote(earlier, { at: 2_000, ok: true, targetMet: true })).toBe(
			"saved",
		);
		expect(saveNote(earlier, { at: 2_000, ok: true, targetMet: false })).toBe(
			"targetNotMet",
		);
		expect(saveNote(null, { at: 2_000, ok: false, targetMet: false })).toBe(
			"maintenanceFailed",
		);
		expect(saveNote(earlier, { at: 2_000, ok: false, targetMet: true })).toBe(
			"maintenanceFailed",
		);
	});
});
