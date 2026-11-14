import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { logger } from "../helpers/logger.ts";
import {
	getNetworkInterfaces,
	hasNetifSnapshot,
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
let savedSidecar: typeof setup.bind_map_file;

beforeEach(async () => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBindMapWriter();
	resetBondIdentities();
	directory = await mkdtemp(join(tmpdir(), "bond-first-sight-session-"));
	savedIps = setup.ips_file;
	savedSidecar = setup.bind_map_file;
	setup.ips_file = join(directory, "ips");
	setup.bind_map_file = join(directory, "bindmap.json");
});

afterEach(async () => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetBondOptOut();
	resetBondIdentities();
	resetBindMapWriter();
	srtla.resetPublishedBond();
	setup.ips_file = savedIps;
	setup.bind_map_file = savedSidecar;
	await rm(directory, { recursive: true, force: true });
});

for (const rejectFirst of [false, true]) {
	test(`(d) concurrent late-coverage events restart the sender once (first refresh rejects: ${rejectFirst})`, async () => {
		jest.useFakeTimers();
		const scan = firstSightScan(
			[
				firstSightIfconfig("eth9", "192.0.2.2"),
				firstSightIfconfig(MODEM, IP),
			].join("\n\n"),
		);
		await refreshUsbNetMarkers(["eth9"]);
		processIfconfigOutput(firstSightIfconfig("eth9", "192.0.2.2"));
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
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const pending: ReturnType<typeof preparation.prepareSrtlaIpAddresses>[] =
			[];
		const prepare = preparation.prepareSrtlaIpAddresses;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		let overlap = false;
		let calls = 0;
		let completions = 0;
		spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(
			(address) => {
				if (!overlap) {
					const result = prepare(address);
					pending.push(result);
					return result;
				}
				const ordinal = ++calls;
				entered.resolve();
				const result = gate.promise.then(() => {
					if (rejectFirst && ordinal === 1)
						throw new Error("constructed first refresh failure");
					return prepare(address);
				});
				const settled = () => {
					if (++completions === 3) completed.resolve();
				};
				void result.then(settled, settled);
				pending.push(result);
				return result;
			},
		);
		const restart = spyOn(srtla, "restartSrtla").mockImplementation(() => {});
		let publication: ReturnType<typeof updateNetif>;
		try {
			expect(await session.start(WebSocket.prototype, {}, 18)).toEqual({
				success: true,
			});
			live = true;
			publication = updateNetif();
			await scan.entered;
			jest.advanceTimersByTime(2_000);
			await publication;
			await Promise.all(pending);
			expect(hasNetifSnapshot()).toBe(true);
			expect(getNetworkInterfaces()[MODEM]).toBeDefined();
			expect(identityForIface(MODEM)).toBeUndefined();
			expect(restart).toHaveBeenCalledTimes(0);
			overlap = true;
			scan.release();
			await scan.settle();
			await entered.promise;
			triggerNetworkInterfacesChange();
			triggerNetworkInterfacesChange();
			gate.resolve();
			await completed.promise;
			await Promise.allSettled(pending);
			expect(calls).toBe(3);
			expect(identityForIface(MODEM)?.linkId).toBe(
				firstSightPhysicalDevice().linkId,
			);
			expect(restart).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledTimes(rejectFirst ? 1 : 0);
			overlap = false;
			await updateNetif();
			await scan.settle();
			await Promise.allSettled(pending);
			expect(restart).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
			scan.release();
			await publication;
			await scan.settle();
			await Promise.allSettled(pending);
			spyOn(getStreamingBackend(), "stop").mockImplementation((done) => {
				done();
				return true;
			});
			await session.stopGeneration(18);
		}
	});
}
