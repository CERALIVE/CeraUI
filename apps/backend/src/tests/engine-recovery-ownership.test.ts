import { afterEach, expect, spyOn, test } from "bun:test";
import {
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	clearCapabilitiesCache,
	MINIMAL_SAFE_CAPABILITIES,
} from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	cerastreamBackend,
} from "../modules/streaming/cerastream-backend.ts";
import * as recovery from "../modules/streaming/engine-reconnect.ts";
import * as sources from "../modules/streaming/sources.ts";
import * as session from "../modules/streaming/stream-session-orchestrator.ts";
import * as compat from "../rpc/compat.ts";

function recoveryClock() {
	const pending = new Map<
		ReturnType<typeof setTimeout>,
		{ callback: () => void; delay: number }
	>();
	return {
		setTimer(callback: () => void, delay: number) {
			const handle = setTimeout(callback, 0);
			clearTimeout(handle);
			pending.set(handle, { callback, delay });
			return handle;
		},
		clearTimer(handle: ReturnType<typeof setTimeout>) {
			pending.delete(handle);
		},
		nextCallback: () => pending.values().next().value?.callback,
		async fire() {
			const next = pending.entries().next();
			if (next.done) return;
			const [handle, { callback }] = next.value;
			pending.delete(handle);
			callback();
			await recovery.settleEngineReconnect();
		},
		pending: () => pending.size,
		delays: () => Array.from(pending.values(), ({ delay }) => delay),
	};
}

function reportLoss() {
	const report: unknown = Reflect.get(recovery, "rearmEngineReconnect");
	if (typeof report === "function") report("fixture");
}

afterEach(recovery.stopEngineReconnect);

test("an older boot completion does not settle the successor's recovery", async () => {
	const firstClock = recoveryClock();
	const nextClock = recoveryClock();
	const firstRefresh = Promise.withResolvers<void>();
	const slow = recovery.initEngineConnection({
		...firstClock,
		refreshCapabilities: () => firstRefresh.promise,
		isEngineReachable: () => true,
	});
	await recovery.initEngineConnection({
		...nextClock,
		refreshCapabilities: async () => {},
		isEngineReachable: () => false,
	});
	firstRefresh.resolve();
	await slow;
	await nextClock.fire();
	expect(nextClock.pending()).toBe(1);
	expect(firstClock.pending()).toBe(0);
});

test("a dequeued retry from an old recovery cannot refresh the successor", async () => {
	const firstClock = recoveryClock();
	const nextClock = recoveryClock();
	const reads: string[] = [];
	await recovery.initEngineConnection({
		...firstClock,
		refreshCapabilities: async () => {
			reads.push("old");
		},
		isEngineReachable: () => false,
	});
	const dequeued = firstClock.nextCallback();
	if (dequeued === undefined) throw new Error("Expected a retry callback");

	await recovery.initEngineConnection({
		...nextClock,
		refreshCapabilities: async () => {
			reads.push("replacement");
		},
		isEngineReachable: () => false,
	});
	dequeued();
	await recovery.settleEngineReconnect();
	expect(reads).toEqual(["old", "replacement"]);

	await nextClock.fire();
	expect(reads).toEqual(["old", "replacement", "replacement"]);
});

test("a dequeued idle monitor cannot dial after the same owner re-arms", async () => {
	const clock = recoveryClock();
	const reads: string[] = [];
	await recovery.initEngineConnection({
		...clock,
		refreshCapabilities: async () => {
			reads.push("refresh");
		},
		isEngineReachable: () => true,
		publishEngineAvailability: () => {},
		monitorControl: async () => {
			reads.push("monitor");
			return true;
		},
	});
	const dequeued = clock.nextCallback();
	if (dequeued === undefined) throw new Error("Expected an idle monitor");

	reportLoss();
	dequeued();
	await recovery.settleEngineReconnect();
	expect(reads).toEqual(["refresh"]);

	await clock.fire();
	expect(reads).toEqual(["refresh", "refresh"]);
	await clock.fire();
	expect(reads).toEqual(["refresh", "refresh", "monitor"]);
});

test("an obsolete liveness probe cannot report the replacement recovery offline", async () => {
	const firstClock = recoveryClock();
	const nextClock = recoveryClock();
	const query = Promise.withResolvers<boolean>();
	const probes: string[] = [];
	const sent = spyOn(compat, "broadcastMsg");
	const options = {
		capabilities: {
			fetchEngineCapabilities: async () => ({
				caps: MINIMAL_SAFE_CAPABILITIES,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		},
		sources: { fetchEngineDevices: async () => ({ devices: [] }) },
	};
	clearCapabilitiesCache();
	let obsolete: Promise<void> | undefined;
	const oldMonitor = {
		monitorControl: () => {
			probes.push("old");
			return query.promise;
		},
	};
	const replacementMonitor = {
		monitorControl: async () => {
			probes.push("replacement");
			return true;
		},
	};
	try {
		await recovery.initEngineConnection({
			...options,
			...firstClock,
			...oldMonitor,
		});
		obsolete = firstClock.fire();
		await recovery.initEngineConnection({
			...options,
			...nextClock,
			...replacementMonitor,
		});

		query.resolve(false);
		await obsolete;
		expect(
			sent.mock.calls.filter(([topic]) => topic === "capabilities"),
		).toEqual([]);
		await nextClock.fire();
		expect(probes).toEqual(["old", "replacement"]);
	} finally {
		query.resolve(false);
		await obsolete;
		recovery.stopEngineReconnect();
		sent.mockRestore();
		clearCapabilitiesCache();
	}
});

test("a partially published heal reopens offline delivery", async () => {
	const clock = recoveryClock();
	let engineUp = true;
	const events: string[] = [];
	const options = {
		...clock,
		refreshCapabilities: async () => {},
		isEngineReachable: () => engineUp,
		publishEngineAvailability: () => {
			events.push("available");
			throw new Error("source refresh failed");
		},
		broadcastEngineOffline: () => {
			events.push("offline");
		},
	};
	await recovery.initEngineConnection(options);
	engineUp = false;
	reportLoss();
	engineUp = true;
	await clock.fire();
	engineUp = false;
	await clock.fire();
	expect(events).toEqual(["offline", "available", "offline"]);
});

test("a failed offline delivery is retried", async () => {
	const clock = recoveryClock();
	let engineUp = true;
	let failSend = true;
	const events: string[] = [];
	const options = {
		...clock,
		refreshCapabilities: async () => {},
		isEngineReachable: () => engineUp,
		broadcastEngineOffline: () => {
			if (failSend) throw new Error("send failed");
			events.push("offline");
		},
	};
	await recovery.initEngineConnection(options);
	engineUp = false;
	reportLoss();
	failSend = false;
	await clock.fire();
	expect(events).toEqual(["offline"]);
});

test("deferred work from a settled heal has no authority in the next outage", async () => {
	const clock = recoveryClock();
	let engineUp = true;
	const released = Promise.withResolvers<void>();
	let deferred = Promise.resolve();
	const writes: string[] = [];
	const options = {
		...clock,
		refreshCapabilities: async () => {},
		isEngineReachable: () => engineUp,
		publishEngineAvailability: (current: () => boolean) => {
			writes.push("available");
			deferred = released.promise.then(() => {
				if (current()) writes.push("stale audio");
			});
		},
		broadcastEngineOffline: () => {
			writes.push("offline");
		},
	};
	await recovery.initEngineConnection(options);
	engineUp = false;
	reportLoss();
	engineUp = true;
	await clock.fire();
	engineUp = false;
	reportLoss();
	released.resolve();
	await deferred;
	expect(writes).toEqual(["offline", "available", "offline"]);
});

test("an open idle page receives offline and then available without a Start", async () => {
	const clock = recoveryClock();
	let failure: Error = new CerastreamTimeoutError("hello", 1000);
	const engine = new CerastreamBackend({
		connect: async () => {
			throw failure;
		},
	});
	const check = spyOn(cerastreamBackend, "probeEngine").mockImplementation(
		engine.probeEngine.bind(engine),
	);
	const refresh = spyOn(
		sources,
		"refreshAndBroadcastSources",
	).mockResolvedValue(undefined);
	const sent = spyOn(compat, "broadcastMsg");
	const availability = () =>
		sent.mock.calls.flatMap(([topic, data]) =>
			topic === "capabilities" &&
			data &&
			typeof data === "object" &&
			"engineUnavailable" in data
				? [data.engineUnavailable]
				: [],
		);
	clearCapabilitiesCache();
	try {
		await recovery.initEngineConnection({
			...clock,
			capabilities: {
				fetchEngineCapabilities: async () => ({
					caps: MINIMAL_SAFE_CAPABILITIES,
					schemaVersion: SCHEMA_VERSION,
				}),
				fetchEngineDevices: async () => ({ devices: [] }),
			},
		});
		await clock.fire();
		expect(availability()).toEqual([]);
		expect(clock.delays()).toEqual([15_000]);
		failure = new CerastreamRpcError(
			-32000,
			"Unsupported protocol",
			undefined,
			1,
		);
		await clock.fire();
		expect(availability()).toEqual([]);
		failure = new CerastreamConnectionError("control socket disconnected");
		await clock.fire();
		check.mockResolvedValue({ status: "compatible" });
		await clock.fire();
		expect(availability()).toEqual([true, false]);
	} finally {
		sent.mockRestore();
		refresh.mockRestore();
		check.mockRestore();
		clearCapabilitiesCache();
	}
});

test("after a loss, availability alone cannot admit Start but late Idle can", async () => {
	const clock = recoveryClock();
	const query = spyOn(
		cerastreamBackend,
		"reconcileRuntimeState",
	).mockResolvedValue("idle");
	const monitor = spyOn(cerastreamBackend, "probeEngine").mockResolvedValue({
		status: "compatible",
	});
	const refresh = spyOn(
		sources,
		"refreshAndBroadcastSources",
	).mockResolvedValue(undefined);
	const stop = spyOn(cerastreamBackend, "stop").mockReturnValue(false);
	const confirmStop = spyOn(cerastreamBackend, "confirmStop").mockResolvedValue(
		undefined,
	);
	let launches = 0;
	const start = () =>
		session.startStreamSession({
			origin: "ui",
			launch: async () => {
				launches++;
			},
		});
	try {
		await session.reconcileStreamSession();
		expect(await start()).toMatchObject({ result: "started" });
		await recovery.initEngineConnection({
			...clock,
			capabilities: {
				fetchEngineCapabilities: async () => ({
					caps: MINIMAL_SAFE_CAPABILITIES,
					schemaVersion: SCHEMA_VERSION,
				}),
				fetchEngineDevices: async () => ({ devices: [] }),
			},
		});
		query.mockResolvedValue("unknown");
		const retire: unknown = Reflect.get(session, "retireLostStreamSession");
		if (typeof retire === "function") await retire();
		reportLoss();
		await clock.fire();
		expect(session.streamLiveness()).toBe("unknown");
		expect(await start()).toMatchObject({ result: "busy" });
		query.mockResolvedValue("idle");
		await clock.fire();
		expect(session.streamLiveness()).toBe("idle");
		expect(launches).toBe(1);
		expect(stop).not.toHaveBeenCalled();
		expect(confirmStop).not.toHaveBeenCalled();
		expect(await start()).toMatchObject({ result: "started" });
	} finally {
		query.mockResolvedValue("idle");
		await session.reconcileStreamSession();
		stop.mockRestore();
		confirmStop.mockRestore();
		query.mockRestore();
		monitor.mockRestore();
		refresh.mockRestore();
		clearCapabilitiesCache();
	}
});
