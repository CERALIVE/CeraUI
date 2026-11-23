import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	spyOn,
	test,
} from "bun:test";
import { call } from "@orpc/server";
import { withQuerySlot } from "../modules/device-logs/query-admission.ts";
import { closeSocketSession } from "../rpc/context.ts";
import {
	aroundLogsProcedure,
	queryLogsProcedure,
} from "../rpc/procedures/logs.procedure.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";
import { latch } from "./helpers/history-clear.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

let fixture: ReturnType<typeof queryFixture>;
let sockets: Awaited<ReturnType<typeof logsSockets>>;
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

beforeEach(async () => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([record(1)]));
	sockets = await logsSockets();
	jest.useFakeTimers();
});

afterEach(async () => {
	closeSocketSession(sockets.ws);
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(pending.splice(0));
	jest.useRealTimers();
	sockets.close();
	fixture.restore();
});

function own<T extends Promise<unknown>>(task: T): T {
	pending.push(Promise.allSettled([task]));
	return task;
}

async function holdSlot(kind: "viewer" | "download") {
	const page = latch();
	const signal = new AbortController().signal;
	releases.push(page.release);
	void own(
		withQuerySlot(
			{},
			page.hold,
			kind === "viewer" ? { interactive: signal } : signal,
		),
	);
	await page.entered;
	return page;
}

function nextTurn() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

const reads = {
	Raw: (signal?: AbortSignal) =>
		call(
			queryLogsProcedure,
			{ boot: bootId },
			{ context: sockets.context, signal },
		),
	Around: (signal?: AbortSignal) =>
		call(
			aroundLogsProcedure,
			{ bootId, at: 1 },
			{ context: sockets.context, signal },
		),
};

const callerTimeout = new DOMException(
	"Journal slot wait timed out",
	"TimeoutError",
);
const cancellations = [
	["caller TimeoutError", callerTimeout, false],
	["caller AbortError", new DOMException("Canceled", "AbortError"), false],
	["caller Error", new Error("Canceled"), false],
	["caller custom reason", { code: "canceled" }, false],
	["already-aborted caller signal", callerTimeout, true],
] as const;

const preAbortedReasons = [
	["TimeoutError", callerTimeout],
	["AbortError", new DOMException("Canceled", "AbortError")],
	["Error", new Error("Canceled")],
] as const;

for (const [name, read] of Object.entries(reads)) {
	describe(name, () => {
		test.each(cancellations)(
			"returns READ_FAILED for %s without waiting for its deadline",
			async (_label, reason, alreadyAborted) => {
				await holdSlot("viewer");
				const download = await holdSlot("download");
				const request = new AbortController();
				if (alreadyAborted) request.abort(reason);
				const result = own(read(request.signal));

				if (!alreadyAborted) {
					await nextTurn();
					expect(jest.getTimerCount()).toBe(1);
					request.abort(reason);
				}

				expect(await Promise.race([result, nextTurn()])).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
				expect(jest.getTimerCount()).toBe(0);
				expect(fixture.scan).not.toHaveBeenCalled();

				// A fresh read must wait for real capacity, then pass the canceled waiter.
				const next = own(reads.Raw());
				expect(await Promise.race([next, nextTurn()])).toBeUndefined();
				expect(fixture.scan).not.toHaveBeenCalled();
				download.release();
				expect(await Promise.race([next, nextTurn()])).toMatchObject({
					ok: true,
					entries: [{ cursor: "s=1" }],
				});
				expect(jest.getTimerCount()).toBe(0);
			},
		);

		for (const capacity of ["both slots held", "one slot free"] as const) {
			test.each(preAbortedReasons)(
				`does not touch the admission queue for an already-aborted %s (${capacity})`,
				async (_label, reason) => {
					await holdSlot("viewer");
					if (capacity === "both slots held") await holdSlot("download");

					// Observe transient operations for this socket without exposing the
					// scheduler's queues or replacing their behavior.
					const add = spyOn(Set.prototype, "add");
					const remove = spyOn(Set.prototype, "delete");
					const timer = spyOn(globalThis, "setTimeout");
					const forSocket = ([value]: [unknown]) =>
						typeof value === "object" &&
						value !== null &&
						"conn" in value &&
						value.conn === sockets.ws;
					try {
						const result = own(read(AbortSignal.abort(reason)));
						expect(await Promise.race([result, nextTurn()])).toEqual({
							ok: false,
							error: "READ_FAILED",
						});
						expect(timer).not.toHaveBeenCalled();
						expect(jest.getTimerCount()).toBe(0);
						expect(fixture.scan).not.toHaveBeenCalled();

						const queueOperations = [
							...add.mock.calls.filter(forSocket).map(() => "add"),
							...remove.mock.calls.filter(forSocket).map(() => "delete"),
						];
						expect(queueOperations).toEqual([]);
					} finally {
						timer.mockRestore();
						remove.mockRestore();
						add.mockRestore();
					}

					if (capacity === "one slot free") {
						const live = own(read(new AbortController().signal));
						expect(await Promise.race([live, nextTurn()])).toMatchObject({
							ok: true,
						});
					}
				},
			);
		}
	});
}

test.each([
	["viewer", "BUSY"],
	["download", "READ_FAILED"],
] as const)(
	"Raw expires at 3,100 ms with a %s and a download: %s",
	async (holder, error) => {
		await holdSlot(holder);
		await holdSlot("download");
		const result = own(reads.Raw());
		await nextTurn();

		jest.advanceTimersByTime(3099);
		expect(await Promise.race([result, nextTurn()])).toBeUndefined();
		expect(jest.getTimerCount()).toBe(1);
		jest.advanceTimersByTime(1);

		expect(await Promise.race([result, nextTurn()])).toEqual({
			ok: false,
			error,
		});
		expect(jest.getTimerCount()).toBe(0);
		expect(fixture.scan).not.toHaveBeenCalled();
	},
);
