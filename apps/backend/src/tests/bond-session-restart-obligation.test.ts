import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { logger } from "../helpers/logger.ts";
import {
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	triggerNetworkInterfacesChange,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { setup } from "../modules/setup.ts";
import { resetBindMapWriter } from "../modules/streaming/bind-map-writer.ts";
import {
	identityForIface,
	resetBondIdentities,
} from "../modules/streaming/link-registry.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import { getStreamingBackend } from "../modules/streaming/streaming-engine.ts";
import * as session from "../modules/streaming/streamloop/session.ts";
import * as preparation from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import * as launch from "../modules/streaming/streamloop/start-stream.ts";
import {
	firstSightIfconfig,
	firstSightPhysicalDevice,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";

let directory = "";
let savedIps: typeof setup.ips_file;
let savedMap: typeof setup.bind_map_file;
let unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => {
	unhandled.push(error);
};
const GENERATION = 183;

function resetOwners() {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBindMapWriter();
	resetBondIdentities();
	srtla.resetPublishedBond();
}

beforeEach(async () => {
	resetOwners();
	directory = await mkdtemp(join(tmpdir(), "bond-session-restart-"));
	savedIps = setup.ips_file;
	savedMap = setup.bind_map_file;
	setup.ips_file = join(directory, "ips");
	setup.bind_map_file = join(directory, "map.json");
	unhandled = [];
	process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
	spyOn(getStreamingBackend(), "stop").mockImplementation((complete) => {
		complete();
		return true;
	});
	await session.stopGeneration(GENERATION);
	await new Promise<void>((resolve) => setImmediate(resolve));
	process.off("unhandledRejection", onUnhandled);
	console.log("SESSION_UNHANDLED", unhandled.length);
	expect(unhandled).toEqual([]);
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetOwners();
	setup.ips_file = savedIps;
	setup.bind_map_file = savedMap;
	await rm(directory, { recursive: true, force: true });
});

async function startLive() {
	let live = false;
	spyOn(streaming, "getIsStreaming").mockImplementation(() => live);
	spyOn(streaming, "updateConfig").mockResolvedValue({
		pipeline: {
			source: "hdmi",
			name: "Constructed",
			hardware: "generic",
			description: "Constructed",
			supportsAudio: false,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
			audio_kind: "none",
		},
		srtlaAddr: "203.0.113.1",
		srtlaPort: 5000,
		streamid: "constructed",
	});
	spyOn(launch, "startStream").mockResolvedValue({ success: true });
	const restart = spyOn(srtla, "restartSrtla").mockImplementation(() => {});
	expect(await session.start(WebSocket.prototype, {}, GENERATION)).toEqual({
		success: true,
	});
	live = true;
	return restart;
}

for (const mode of ["normal", "thrown", "ips_write_failed"] as const) {
	test(`A1 overlapping refreshes restart once after ${mode} preparation`, async () => {
		const eth9 = firstSightIfconfig("eth9", "192.0.2.2");
		const both = `${eth9}\n\n${firstSightIfconfig("eth10", "198.51.100.2")}`;
		firstSightScan(both);
		await refreshUsbNetMarkers(["eth9", "eth10"]);
		processIfconfigOutput(eth9);
		const restart = await startLive();
		restart.mockClear();
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const realPrepare = preparation.prepareSrtlaIpAddresses;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		const pending: Promise<unknown>[] = [];
		let calls = 0;
		let completions = 0;
		spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(
			(address) => {
				const ordinal = ++calls;
				let result: ReturnType<typeof realPrepare>;
				if (ordinal === 1) {
					entered.resolve();
					result = gate.promise.then(() => {
						if (mode === "thrown") throw new Error("first preparation failure");
						if (mode !== "ips_write_failed") return realPrepare(address);
						const good = setup.ips_file;
						setup.ips_file = join(directory, "missing", "ips");
						try {
							return realPrepare(address);
						} finally {
							setup.ips_file = good;
						}
					});
				} else result = realPrepare(address);
				pending.push(result);
				void result.then(
					() => {
						if (++completions === 3) done.resolve();
					},
					() => {
						if (++completions === 3) done.resolve();
					},
				);
				return result;
			},
		);
		try {
			processIfconfigOutput(both);
			await entered.promise;
			triggerNetworkInterfacesChange();
			triggerNetworkInterfacesChange();
			gate.resolve();
			await done.promise;
			await Promise.allSettled(pending);
			await new Promise<void>((resolve) => setImmediate(resolve));
			console.log(
				"A1",
				JSON.stringify({
					mode,
					calls,
					completions,
					restarts: restart.mock.calls.length,
					warns: warn.mock.calls.length,
					unhandled: unhandled.length,
				}),
			);
			expect(calls).toBe(3);
			expect(warn).toHaveBeenCalledTimes(mode === "thrown" ? 1 : 0);
			expect(unhandled).toEqual([]);
			expect(restart).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
			await Promise.allSettled(pending);
		}
	});
}

test("A2 a scan commit alone publishes the physical identity and restarts once", async () => {
	jest.useFakeTimers();
	const eth9 = firstSightIfconfig("eth9", "192.0.2.2");
	const scan = firstSightScan(`${eth9}\n\n${firstSightIfconfig(MODEM, IP)}`);
	await refreshUsbNetMarkers(["eth9"]);
	processIfconfigOutput(eth9);
	const restart = await startLive();
	const realPrepare = preparation.prepareSrtlaIpAddresses;
	const pending: ReturnType<typeof realPrepare>[] = [];
	spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(
		(address) => {
			const result = realPrepare(address);
			pending.push(result);
			return result;
		},
	);
	const publication = updateNetif();
	try {
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		await Promise.allSettled(pending);
		expect(restart).toHaveBeenCalledTimes(1);
		restart.mockClear();
		scan.release();
		await scan.settle();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.allSettled(pending);
		await new Promise<void>((resolve) => setImmediate(resolve));
		console.log(
			"A2",
			JSON.stringify({
				restarts: restart.mock.calls.length,
				identity: identityForIface(MODEM)?.linkId,
				unhandled: unhandled.length,
			}),
		);
		expect(identityForIface(MODEM)?.linkId).toBe(
			firstSightPhysicalDevice().linkId,
		);
		expect(restart).toHaveBeenCalledTimes(1);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
		await Promise.allSettled(pending);
	}
});

test("A3 unchanged Ethernet identity owes no restart after scan and netif refreshes", async () => {
	const eth9 = firstSightIfconfig("eth9", "192.0.2.2");
	firstSightScan(eth9);
	await refreshUsbNetMarkers(["eth9"]);
	processIfconfigOutput(eth9);
	const restart = await startLive();
	const original = identityForIface("eth9");
	const realPrepare = preparation.prepareSrtlaIpAddresses;
	const pending: ReturnType<typeof realPrepare>[] = [];
	spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(
		(address) => {
			const result = realPrepare(address);
			pending.push(result);
			return result;
		},
	);
	await refreshUsbNetMarkers(["eth9", "eth10"]);
	triggerNetworkInterfacesChange();
	triggerNetworkInterfacesChange();
	let seen = -1;
	while (seen !== pending.length) {
		seen = pending.length;
		await Promise.allSettled(pending);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	console.log(
		"A3",
		JSON.stringify({
			refreshes: pending.length,
			restarts: restart.mock.calls.length,
			identity: identityForIface("eth9"),
			unhandled: unhandled.length,
		}),
	);
	expect(restart).toHaveBeenCalledTimes(0);
	expect(identityForIface("eth9")).toEqual(original);
});
