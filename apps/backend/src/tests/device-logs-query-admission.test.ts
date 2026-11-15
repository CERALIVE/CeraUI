import { afterEach, beforeEach, expect, test } from "bun:test";
import { abortLogQueries, queryLogs } from "../modules/device-logs/query.ts";
import { withQuerySlot } from "../modules/device-logs/query-admission.ts";
import { bootId, queryFixture, socket } from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());
test("two occupied scans refuse a third; replacement waits for the same socket to retire", async () => {
	const started = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	const release = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	let index = 0;
	fixture.scan.mockImplementation(async (input) => {
		const n = index++;
		started[n]?.resolve();
		await release[n]?.promise;
		return {
			status: input.signal?.aborted ? "stopped" : "eof",
			exitCode: 0,
			skippedRecords: 0,
		};
	});
	const a = socket(),
		b = socket();
	const first = queryLogs(a, { boot: bootId });
	await started[0]?.promise;
	const second = queryLogs(b, { boot: bootId });
	await started[1]?.promise;
	expect(await queryLogs(socket(), { boot: bootId })).toEqual({
		ok: false,
		error: "BUSY",
	});
	const replacement = queryLogs(a, { boot: bootId });
	expect(fixture.scan.mock.calls[0]?.[0].signal?.aborted).toBe(true);
	expect(fixture.scan).toHaveBeenCalledTimes(2);
	release[0]?.resolve();
	expect(await first).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await replacement).ok).toBe(true);
	release[1]?.resolve();
	expect((await second).ok).toBe(true);
});
test("clear aborts and joins occupied queries before returning", async () => {
	const started = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async (input) => {
		started.resolve();
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	const pending = queryLogs(socket(), { boot: bootId });
	await started.promise;
	await abortLogQueries();
	expect(await pending).toEqual({ ok: false, error: "READ_FAILED" });
});
test("clear joins the owned retirement rather than only sending abort", async () => {
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const reaped = Promise.withResolvers<void>();
	let retired = false;
	let joined = false;
	const pending = withQuerySlot(socket(), async (signal) => {
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		started.resolve();
		await reaped.promise;
		retired = true;
		return "finished";
	}).catch((error: unknown) => error);
	await started.promise;
	const stopped = abortLogQueries().then(() => {
		joined = true;
	});
	await aborted.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	const joinedBeforeRetirement = joined;
	reaped.resolve();
	await stopped;
	expect(joinedBeforeRetirement).toBe(false);
	expect(retired).toBe(true);
	expect(await pending).toMatchObject({ code: "READ_FAILED" });
});
test("same-socket replacement waits for all concurrent replacement owners", async () => {
	const conn = socket();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	const run = async () => {
		active++;
		peak = Math.max(peak, active);
		started.resolve();
		await release.promise;
		active--;
		return "done";
	};
	const a = withQuerySlot(conn, run).catch((error: unknown) => error);
	await started.promise;
	const b = withQuerySlot(conn, run).catch((error: unknown) => error);
	const c = withQuerySlot(conn, run).catch((error: unknown) => error);
	release.resolve();
	await Promise.all([a, b, c]);
	expect(peak).toBe(1);
});
