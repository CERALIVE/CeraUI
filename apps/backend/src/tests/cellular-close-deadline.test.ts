import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbusTransport } from "@ceralive/modem-control/transport";
import {
	CELLULAR_SUBSYSTEM,
	DBUS_FALLBACK_REASON,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { createDbusCellularBackend } from "../modules/cellular/dbus-backend.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";

interface HeldTimer {
	readonly ms: number;
	readonly fire: () => void;
}

/** Hold every timer long enough to be a deadline; the test fires each by hand. */
function holdDeadlines() {
	const realSetTimeout = globalThis.setTimeout;
	const armed: HeldTimer[] = [];
	const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
		run: () => void,
		ms = 0,
	) => {
		if (ms < 100) return realSetTimeout(run, ms);
		armed.push({ ms, fire: run });
		return realSetTimeout(() => {}, 0);
	}) as typeof setTimeout);
	return { armed, restore: () => spy.mockRestore() };
}

test("an authenticated bus that keeps its half open cannot hold boot in D-Bus shutdown", async () => {
	resetCellularStack();
	resetBootReadiness();
	const root = await mkdtemp(join(tmpdir(), "db-"));
	const path = join(root, "s");
	const silent = Promise.withResolvers<void>();
	const readyWhenClosed = Promise.withResolvers<boolean>();
	const peers = new Set<Socket>();
	const bus = createServer({ allowHalfOpen: true }, (socket) => {
		peers.add(socket);
		let authenticated = false;
		socket.on("data", (data) => {
			// The client is past login, and this bus never answers again.
			if (authenticated) return silent.resolve();
			if (!data.toString("latin1").includes("AUTH")) return;
			authenticated = true;
			socket.write("OK 1234deadbeef\r\n");
		});
		// Receive FIN but deliberately leave the write half open.
		socket.on("end", () => readyWhenClosed.resolve(getCellularStack().ready));
		socket.on("close", () => peers.delete(socket));
	});
	await new Promise<void>((resolve) => bus.listen(path, resolve));
	const deadlines = holdDeadlines();
	const init = initCellularStack({
		backend: "dbus",
		initTimeoutMs: 500,
		createDbusBackend: () =>
			createDbusCellularBackend({
				transport: createDbusTransport({ busAddress: `unix:path=${path}` }),
			}),
	});
	try {
		await silent.promise;
		// Connecting holds timers of its own; the close limit is armed after this one.
		const start = deadlines.armed.find((timer) => timer.ms === 500);
		const earlier = deadlines.armed.length;
		start?.fire();

		// The close is on the wire, its limit is armed, and nothing is announced.
		expect(await readyWhenClosed.promise).toBe(false);
		const limits = deadlines.armed.slice(earlier);
		expect(limits.map((timer) => timer.ms)).toEqual([2_000]);
		expect(getCellularStack().ready).toBe(false);
		expect(getBootReadiness().degradedSubsystems).not.toContain(
			CELLULAR_SUBSYSTEM,
		);

		limits[0]?.fire();
		await init;

		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: true,
			degradedReason: DBUS_FALLBACK_REASON,
		});
		expect(getBootReadiness().degradedSubsystems).toContain(CELLULAR_SUBSYSTEM);
		expect(peers.size).toBe(1);
	} finally {
		deadlines.restore();
		// A failed expectation must not leave boot waiting on a timer held here.
		for (const timer of deadlines.armed) timer.fire();
		for (const peer of peers) peer.destroy();
		await new Promise<void>((resolve) => bus.close(() => resolve()));
		await init;
		resetCellularStack();
		resetBootReadiness();
		await rm(root, { recursive: true, force: true });
	}
});
