import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import {
	abortLogQueries,
	withQuerySlot,
} from "../modules/device-logs/query-admission.ts";
import { getLogState } from "../modules/device-logs/settings.ts";
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
let restoreTimeout: () => void;
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

beforeEach(async () => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([record(1)]));
	sockets = await logsSockets();
	jest.useFakeTimers();
	// Bun's fake clock does not track the native AbortSignal.timeout timer.
	const timer = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const deadline = new AbortController();
		setTimeout(() => deadline.abort(new DOMException("", "TimeoutError")), ms);
		return deadline.signal;
	});
	restoreTimeout = () => timer.mockRestore();
});

afterEach(async () => {
	closeSocketSession(sockets.ws);
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(pending.splice(0));
	restoreTimeout();
	jest.useRealTimers();
	sockets.close();
	fixture.restore();
});

function own<T>(task: Promise<T>): Promise<T> {
	pending.push(Promise.allSettled([task]));
	return task;
}

async function fillSlots() {
	const pages = [latch(), latch()] as const;
	for (const page of pages) {
		releases.push(page.release);
		void own(withQuerySlot({}, page.hold, new AbortController().signal));
	}
	await Promise.all(pages.map((page) => page.entered));
	return pages;
}

function nextTurn() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

test.each(["socket close", "Clear", "request abort"] as const)(
	"Around removes its pending admission timer after %s",
	async (reason) => {
		await fillSlots();
		const request = new AbortController();
		const around = own(
			call(
				aroundLogsProcedure,
				{ bootId, at: 1 },
				{ context: sockets.context, signal: request.signal },
			),
		);
		await nextTurn();
		expect(jest.getTimerCount()).toBe(1);

		switch (reason) {
			case "socket close":
				closeSocketSession(sockets.ws);
				break;
			case "Clear":
				fixture.epoch.mockReturnValue({ ...getLogState(), historyEpoch: 8 });
				void own(abortLogQueries());
				break;
			case "request abort":
				request.abort();
				break;
		}

		expect(await Promise.race([around, nextTurn()])).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(jest.getTimerCount()).toBe(0);
		expect(fixture.scan).not.toHaveBeenCalled();
	},
);

test("Raw removes its admission timer at grant, before the scan completes", async () => {
	const [page] = await fillSlots();
	const scan = latch();
	releases.push(scan.release);
	fixture.scan.mockImplementationOnce(async (input) => {
		await scan.hold();
		return journal([record(1)])(input);
	});
	const raw = own(
		call(queryLogsProcedure, { boot: bootId }, { context: sockets.context }),
	);
	await nextTurn();
	expect(jest.getTimerCount()).toBe(1);

	page.release();
	await scan.entered;

	expect(jest.getTimerCount()).toBe(0);
	scan.release();
	expect(await raw).toMatchObject({ ok: true, entries: [{ cursor: "s=1" }] });
	expect(jest.getTimerCount()).toBe(0);
});

test("Raw expires at 3,100 ms without leaving an admission timer", async () => {
	await fillSlots();
	const raw = own(
		call(queryLogsProcedure, { boot: bootId }, { context: sockets.context }),
	);
	await nextTurn();
	expect(jest.getTimerCount()).toBe(1);

	jest.advanceTimersByTime(3099);
	expect(jest.getTimerCount()).toBe(1);
	jest.advanceTimersByTime(1);

	expect(jest.getTimerCount()).toBe(0);
	expect(await Promise.race([raw, nextTurn()])).toEqual({
		ok: false,
		error: "READ_FAILED",
	});
	expect(fixture.scan).not.toHaveBeenCalled();
});
