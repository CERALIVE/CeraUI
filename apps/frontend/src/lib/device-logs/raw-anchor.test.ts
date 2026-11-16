import type {
	LogAroundInput,
	LogAroundOutput,
	LogBootInfo,
} from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { locateAround } from "./raw-anchor";

const RUNNING = "66d8d1808694489b8c3a3fb4795cab24";
const EARLIER = "0123456789abcdef0123456789abcdef";
const AT = 1_800_000_000_000;

function boot(patch: Partial<LogBootInfo> = {}): LogBootInfo {
	return {
		bootId: EARLIER,
		index: -1,
		firstTs: AT - 90_000_000,
		lastTs: AT - 80_000_000,
		current: false,
		shutdown: "clean",
		evidence: [],
		logsAvailable: true,
		versions: null,
		...patch,
	};
}

const running = boot({
	bootId: RUNNING,
	index: 0,
	current: true,
	shutdown: "current",
});

function queryPage() {
	return {
		ok: true as const,
		entries: [],
		hasMore: false,
		termination: "end" as const,
		continuation: null,
		historyEpoch: 0,
		bootId: RUNNING,
	};
}

function aroundPage(): Extract<LogAroundOutput, { ok: true }> {
	const filter: Extract<LogAroundOutput, { ok: true }>["olderQuery"] = {
		sources: [],
		levels: ["error", "warning", "info", "debug"],
		boot: RUNNING,
		limit: 50,
		direction: "older",
	};
	return {
		ok: true,
		anchor: null,
		approximate: true,
		older: queryPage(),
		newer: queryPage(),
		olderQuery: {
			...filter,
			direction: "older",
			since: AT - 60_000,
			until: AT,
		},
		newerQuery: {
			...filter,
			direction: "newer",
			since: AT + 1,
			until: AT + 60_000,
		},
	};
}

function logs(boots: unknown, reply: unknown) {
	return {
		boots: vi.fn(() => Promise.resolve(boots)),
		around: vi.fn((_input: LogAroundInput) => Promise.resolve(reply)),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("locateAround", () => {
	for (const edge of ["olderQuery", "newerQuery"] as const) {
		for (const field of [
			"sources",
			"levels",
			"boot",
			"direction",
			"limit",
		] as const) {
			it.each(["absent", "null", "wrong type"] as const)(
				`rejects ${edge}.${field} when %s instead of filling input defaults`,
				async (kind) => {
					vi.spyOn(console, "error").mockImplementation(() => {});
					const page = aroundPage();
					const query = { ...page[edge] };
					switch (kind) {
						case "absent":
							Reflect.deleteProperty(query, field);
							break;
						case "null":
							Reflect.set(query, field, null);
							break;
						case "wrong type":
							Reflect.set(query, field, true);
							break;
						default:
							throw new Error(`Unknown fixture kind: ${kind satisfies never}`);
					}
					const reply = { ...page, [edge]: query };

					expect(
						await locateAround(logs([running], reply), { at: AT }),
					).toEqual({
						ok: false,
						error: "READ_FAILED",
					});
				},
			);
		}
	}

	it("opens the running boot around the moment when the request names no boot", async () => {
		const deps = logs([boot(), running], aroundPage());

		expect(await locateAround(deps, { at: AT })).toEqual(aroundPage());
		expect(deps.boots).toHaveBeenCalledTimes(1);
		expect(deps.around).toHaveBeenCalledExactlyOnceWith({
			bootId: RUNNING,
			at: AT,
		});
	});

	it("opens the boot a request names without listing boots", async () => {
		const deps = logs([running], aroundPage());

		await locateAround(deps, { at: AT, bootId: EARLIER });

		expect(deps.boots).not.toHaveBeenCalled();
		expect(deps.around).toHaveBeenCalledExactlyOnceWith({
			bootId: EARLIER,
			at: AT,
		});
	});

	it("passes a refusal through unchanged", async () => {
		const deps = logs([running], { ok: false, error: "BOOT_UNAVAILABLE" });

		expect(await locateAround(deps, { at: AT })).toEqual({
			ok: false,
			error: "BOOT_UNAVAILABLE",
		});
	});

	it.each([
		["no boot list", null],
		["a boot list that is not a list", { boots: [running] }],
		["a boot without its id", [{ ...running, bootId: undefined }]],
		[
			"a boot id in the kernel's hyphenated form",
			[{ ...running, bootId: "66d8d180-8694-489b-8c3a-3fb4795cab24" }],
		],
		["a current flag that is not a boolean", [{ ...running, current: "yes" }]],
		["a list without the running boot", [boot()]],
	])(
		"reads %s as a failed read and asks for no entries",
		async (_case, reply) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const deps = logs(reply, aroundPage());

			expect(await locateAround(deps, { at: AT })).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(deps.around).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["no reply", undefined],
		["a page without its older entries", { ...aroundPage(), older: undefined }],
		["a null newer page", { ...aroundPage(), newer: null }],
		[
			"an approximate flag that is not a boolean",
			{ ...aroundPage(), approximate: "yes" },
		],
		[
			"an anchor that is not an entry",
			{ ...aroundPage(), anchor: { cursor: 5 } },
		],
		["an unknown member", { ...aroundPage(), extra: true }],
		["an unknown refusal code", { ok: false, error: "NOPE" }],
	])("reads %s as a failed read", async (_case, reply) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await locateAround(logs([running], reply), { at: AT })).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(error).toHaveBeenCalledTimes(1);
	});

	it.each(["boots", "around"] as const)(
		"reads a %s call that throws as a failed read",
		async (call) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const deps = logs([running], aroundPage());
			deps[call].mockRejectedValueOnce(new Error("socket closed"));

			expect(await locateAround(deps, { at: AT })).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(error).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["boots", "around"] as const)(
		"discards a %s reply after its request is cancelled",
		async (call) => {
			const deps = logs([running], aroundPage());
			const reply = Promise.withResolvers<unknown>();
			deps[call].mockReturnValueOnce(reply.promise);
			const controller = new AbortController();
			const result = locateAround(
				deps,
				{
					at: AT,
					...(call === "around" ? { bootId: RUNNING } : {}),
				},
				controller.signal,
			);

			controller.abort();
			reply.resolve(call === "boots" ? [running] : aroundPage());

			expect(await result).toBeNull();
			if (call === "boots") expect(deps.around).not.toHaveBeenCalled();
		},
	);

	it("discards a rejection after cancellation without reporting a current failure", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = logs([running], aroundPage());
		const reply = Promise.withResolvers<unknown>();
		deps.around.mockReturnValueOnce(reply.promise);
		const controller = new AbortController();
		const result = locateAround(
			deps,
			{ at: AT, bootId: RUNNING },
			controller.signal,
		);
		controller.abort();
		reply.reject(new Error("closed socket"));

		expect(await result).toBeNull();
		expect(error).not.toHaveBeenCalled();
	});
});
