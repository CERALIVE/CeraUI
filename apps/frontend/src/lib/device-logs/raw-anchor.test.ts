import type {
	DeviceEvent,
	EventListInput,
	LogAroundInput,
	LogAroundOutput,
	LogBootInfo,
} from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type EventMatch, locateAround, locateMoment } from "./raw-anchor";

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

const REFUSED: EventMatch = {
	family: "update",
	code: "update_refused",
	id: "txn-1",
};

function updateEvent(seq: number, code: string, id: string): DeviceEvent {
	return {
		id: `event-${seq}`,
		seq,
		bootId: EARLIER,
		at: AT - seq * 1000,
		code,
		family: "update",
		severity: "warning",
		params: { id, reason: "dpkg lock held" },
	};
}

function eventPage(events: DeviceEvent[], nextBeforeSeq: number | null = null) {
	return { events, nextBeforeSeq, headSeq: 20, retainedFromSeq: 1 };
}

function sources(...pages: unknown[]) {
	const list = vi.fn((_input: EventListInput) =>
		Promise.resolve<unknown>(null),
	);
	for (const page of pages) list.mockResolvedValueOnce(page);
	return { logs: logs([running], aroundPage()), events: { list } };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("locateMoment", () => {
	it("opens the exact entry of the newest event the message emitted, in that event's boot", async () => {
		const deps = sources(
			eventPage([
				updateEvent(9, "update_installed", "txn-1"),
				updateEvent(8, "update_refused", "txn-2"),
				updateEvent(7, "update_refused", "txn-1"),
				updateEvent(6, "update_refused", "txn-1"),
			]),
		);

		expect(await locateMoment(deps, { at: AT, event: REFUSED })).toEqual(
			aroundPage(),
		);
		expect(deps.events.list).toHaveBeenCalledExactlyOnceWith({
			families: ["update"],
			limit: 200,
		});
		expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: EARLIER,
			at: AT - 7000,
			eventId: "event-7",
		});
		expect(deps.logs.boots).not.toHaveBeenCalled();
	});

	it.each([
		[14, "attempt-new"],
		[10, "attempt-old"],
	] as const)(
		"opens rollback event %s for its own attempt",
		async (seq, id) => {
			const code = "update_kernel_rolled_back";
			const deps = sources(
				eventPage([
					{
						...updateEvent(14, code, "attempt-new"),
						params: { id: "attempt-new", version: "7.2.0" },
					},
					{
						...updateEvent(12, "update_kernel_succeeded", "attempt-old"),
						params: { id: "attempt-old", version: "7.2.0" },
					},
					{
						...updateEvent(10, code, "attempt-old"),
						params: { id: "attempt-old", version: "7.2.0" },
					},
				]),
			);

			await locateMoment(deps, { event: { family: "update", code, id } });

			expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
				bootId: EARLIER,
				at: AT - seq * 1000,
				eventId: `event-${seq}`,
			});
		},
	);

	it.each([
		["update_failed", { stage: "commit", reason: "dpkg was interrupted" }],
		["update_kernel_rolled_back", { id: "txn-8", version: "7.2.0" }],
		["update_credentials_expired", { id: "previous-credential:expired" }],
	])(
		"leaves the moment unknown when a %s outcome has no identifying id",
		async (code, params) => {
			const deps = sources(
				eventPage([
					updateEvent(9, "update_refused", "txn-1"),
					{ ...updateEvent(8, code, ""), params },
					{ ...updateEvent(4, code, ""), params },
				]),
			);

			expect(
				await locateMoment(deps, { event: { family: "update", code } }),
			).toBeNull();
			expect(deps.logs.around).not.toHaveBeenCalled();
			expect(deps.events.list).not.toHaveBeenCalled();
		},
	);

	it("uses the package attempt instead of newer sync or OS failures with the same code", async () => {
		const code = "update_failed";
		const id = "52fd5e45-627d-4a10-a263-9129880c4330";
		const deps = sources(
			eventPage([
				{
					...updateEvent(12, code, ""),
					params: { stage: "sync", reason: "failed" },
				},
				{
					...updateEvent(10, code, ""),
					params: { stage: "os-staging", reason: "failed" },
				},
				{
					...updateEvent(8, code, id),
					params: { stage: "commit", reason: "failed", id },
				},
			]),
		);

		await locateMoment(deps, { event: { family: "update", code, id } });

		expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: EARLIER,
			at: AT - 8000,
			eventId: "event-8",
		});
	});

	it("reads older pages until it reaches the event", async () => {
		const deps = sources(
			eventPage([updateEvent(12, "update_installed", "txn-1")], 11),
			eventPage([updateEvent(3, "update_refused", "txn-1")]),
		);

		await locateMoment(deps, { event: REFUSED });

		expect(deps.events.list.mock.calls).toEqual([
			[{ families: ["update"], limit: 200 }],
			[{ families: ["update"], limit: 200, beforeSeq: 11 }],
		]);
		expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: EARLIER,
			at: AT - 3000,
			eventId: "event-3",
		});
	});

	it("falls back to the message's own moment when no stored event matches", async () => {
		const deps = sources(
			eventPage([updateEvent(2, "update_refused", "other")]),
		);

		expect(await locateMoment(deps, { at: AT, event: REFUSED })).toEqual(
			aroundPage(),
		);
		expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: RUNNING,
			at: AT,
		});
	});

	it("asks for no window when neither the event nor the message's moment is known", async () => {
		const deps = sources(eventPage([]));

		expect(await locateMoment(deps, { event: REFUSED })).toBeNull();
		expect(deps.logs.boots).not.toHaveBeenCalled();
		expect(deps.logs.around).not.toHaveBeenCalled();
	});

	it("opens a moment without an event as before, without reading events", async () => {
		const deps = sources();

		expect(await locateMoment(deps, { at: AT })).toEqual(aroundPage());
		expect(deps.events.list).not.toHaveBeenCalled();
		expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: RUNNING,
			at: AT,
		});
	});

	it.each([
		["an event list call that throws", new Error("socket closed")],
		["an event list that is not a list", { events: "none" }],
	])(
		"reads %s as a failed read and asks for no entries",
		async (_case, reply) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const deps = sources();
			if (reply instanceof Error) deps.events.list.mockRejectedValueOnce(reply);
			else deps.events.list.mockResolvedValueOnce(reply);

			expect(await locateMoment(deps, { at: AT, event: REFUSED })).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(deps.logs.around).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["the message's own moment", { at: AT }, { bootId: RUNNING, at: AT }],
		["the newest entries", {}, undefined],
	])(
		"falls back to %s once the stored history ends without the event",
		async (_case, own, expected) => {
			const deps = sources(
				eventPage([updateEvent(12, "update_refused", "txn-2")], 11),
				eventPage([updateEvent(5, "update_installed", "txn-1")]),
			);

			const result = await locateMoment(deps, { ...own, event: REFUSED });

			expect(deps.events.list).toHaveBeenCalledTimes(2);
			if (expected === undefined) {
				expect(result).toBeNull();
				expect(deps.logs.around).not.toHaveBeenCalled();
			} else expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith(expected);
		},
	);

	it.each([
		["repeats", 11],
		["moves forward", 15],
	])(
		"stops at an event cursor that %s and reads it as a failed read",
		async (_case, next) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const deps = sources(
				eventPage([updateEvent(12, "update_installed", "txn-1")], 11),
				eventPage([updateEvent(10, "update_installed", "txn-2")], next),
				eventPage([updateEvent(3, "update_refused", "txn-1")]),
			);

			expect(await locateMoment(deps, { at: AT, event: REFUSED })).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(deps.events.list).toHaveBeenCalledTimes(2);
			expect(deps.logs.around).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledTimes(1);
		},
	);

	it("stops reading older events after the lookup deadline and falls back to the message's own moment", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = sources();
		let seq = 1200;
		// Six slow pages of a long history that never holds the event.
		deps.events.list.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(() => {
						seq -= 200;
						resolve(
							eventPage(
								[updateEvent(seq + 1, "update_installed", "txn-1")],
								seq === 0 ? null : seq,
							),
						);
					}, 4000);
				}),
		);

		const lookup = locateMoment(deps, { at: AT, event: REFUSED });
		await vi.advanceTimersByTimeAsync(12_000);
		await lookup;

		expect(deps.events.list).toHaveBeenCalledTimes(3);
		expect(deps.logs.around).toHaveBeenCalledExactlyOnceWith({
			bootId: RUNNING,
			at: AT,
		});
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("discards an event list reply after its request is cancelled", async () => {
		const deps = sources();
		const reply = Promise.withResolvers<unknown>();
		deps.events.list.mockReturnValueOnce(reply.promise);
		const controller = new AbortController();
		const result = locateMoment(
			deps,
			{ at: AT, event: REFUSED },
			controller.signal,
		);

		controller.abort();
		reply.resolve(eventPage([updateEvent(1, "update_refused", "txn-1")]));

		expect(await result).toBeNull();
		expect(deps.logs.around).not.toHaveBeenCalled();
	});

	it("does not wait past the lookup deadline for an in-flight page", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = sources();
		const reply = Promise.withResolvers<unknown>();
		deps.events.list.mockReturnValueOnce(reply.promise);
		const lookup = locateMoment(deps, { event: REFUSED });
		const settled = vi.fn();
		void lookup.then(settled);

		await vi.advanceTimersByTimeAsync(10_000);
		try {
			expect(settled).toHaveBeenCalledExactlyOnceWith(null);
		} finally {
			reply.resolve(eventPage([updateEvent(1, "update_refused", "txn-1")]));
			await lookup;
		}
		expect(deps.logs.around).not.toHaveBeenCalled();
	});
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
