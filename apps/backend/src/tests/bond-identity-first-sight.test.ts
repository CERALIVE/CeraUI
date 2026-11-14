import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { getConfig } from "../modules/config.ts";
import {
	readModemCredential,
	resetModemCredentialsForTest,
	writeModemCredential,
} from "../modules/modems/modem-credentials.ts";
import { resetPhysicalIdentityRegistry } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	hasNetifSnapshot,
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
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
	resetModemCredentialsForTest();
	resetBindMapWriter();
	resetBondIdentities();
	directory = await mkdtemp(join(tmpdir(), "bond-first-sight-"));
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
	resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	resetBondIdentities();
	resetBindMapWriter();
	srtla.resetPublishedBond();
	setup.ips_file = savedIps;
	setup.bind_map_file = savedSidecar;
	await rm(directory, { recursive: true, force: true });
});

test("(a) a persisted physical opt-out excludes the modem on its first boot publication", async () => {
	getConfig().bond_opt_out = { [firstSightPhysicalDevice().linkId]: true };
	const scan = firstSightScan(firstSightIfconfig(MODEM, IP));
	const observed: boolean[] = [];
	const unsubscribe = onNetworkInterfacesChange(() => {
		if (getNetworkInterfaces()[MODEM])
			observed.push(netIfBuildMsg()[MODEM]?.enabled ?? true);
	});
	const publication = updateNetif();
	try {
		await scan.entered;
		scan.release();
		await publication;
		expect(observed).toEqual([false]);
		expect(srtla.genSrtlaBondEntries()).toEqual([]);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
		unsubscribe();
	}
});

test("(b) the first bind-map and registry id belong to the physical port", async () => {
	const expected = firstSightPhysicalDevice();
	const scan = firstSightScan(firstSightIfconfig(MODEM, IP));
	const publications: ReturnType<typeof srtla.publishSrtlaBond>[] = [];
	const unsubscribe = onNetworkInterfacesChange(() => {
		publications.push(srtla.publishSrtlaBond(srtla.genSrtlaBondEntries()));
	});
	const publication = updateNetif();
	try {
		await scan.entered;
		scan.release();
		await publication;
		await Promise.all(publications);
		const document: unknown = await Bun.file(setup.bind_map_file ?? "").json();
		expect(document).toMatchObject({
			links: [{ link_id: expected.linkId, iface: MODEM, ip: IP }],
		});
		expect(identityForIface(MODEM)).toMatchObject({
			linkId: expected.linkId,
			identityState: "resolved",
			idPath: expected.idPath,
		});
	} finally {
		scan.release();
		await publication;
		await scan.settle();
		unsubscribe();
	}
});

test("(c) stored router credentials resolve at the first netif sighting", async () => {
	const expected = firstSightPhysicalDevice();
	writeModemCredential(expected, {
		username: "constructed-user",
		password: "constructed-password",
	});
	const scan = firstSightScan(firstSightIfconfig(MODEM, IP));
	const observed: ReturnType<typeof readModemCredential>[] = [];
	const unsubscribe = onNetworkInterfacesChange(() => {
		if (getNetworkInterfaces()[MODEM])
			observed.push(readModemCredential(resolveModemPhysicalIdentity(MODEM)));
	});
	const publication = updateNetif();
	try {
		await scan.entered;
		scan.release();
		await publication;
		expect(observed).toEqual([
			{ username: "constructed-user", password: "constructed-password" },
		]);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
		unsubscribe();
	}
});

test("(d) coverage after stream start admits the modem with exactly one sender restart", async () => {
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
	const pending: ReturnType<typeof preparation.prepareSrtlaIpAddresses>[] = [];
	const prepare = preparation.prepareSrtlaIpAddresses;
	spyOn(preparation, "prepareSrtlaIpAddresses").mockImplementation(
		(address) => {
			const result = prepare(address);
			pending.push(result);
			return result;
		},
	);
	const restart = spyOn(srtla, "restartSrtla").mockImplementation(() => {});
	const socket = WebSocket.prototype;
	let publication: ReturnType<typeof updateNetif>;
	try {
		expect(await session.start(socket, {}, 18)).toEqual({ success: true });
		live = true;
		publication = updateNetif();
		await scan.entered;
		jest.advanceTimersByTime(2_000);
		await publication;
		await Promise.all(pending);
		// The name is visible, but a stream must not acquire a temporary link id.
		expect(hasNetifSnapshot()).toBe(true);
		expect(getNetworkInterfaces()[MODEM]).toBeDefined();
		expect(identityForIface(MODEM)).toBeUndefined();
		expect(restart).toHaveBeenCalledTimes(0);
		scan.release();
		await scan.settle();
		await Promise.all(pending);
		expect(identityForIface(MODEM)?.linkId).toBe(
			firstSightPhysicalDevice().linkId,
		);
		expect(restart).toHaveBeenCalledTimes(1);
		// Identical OS and scan snapshots must not restart the sender again.
		await updateNetif();
		await scan.settle();
		await Promise.all(pending);
		expect(restart).toHaveBeenCalledTimes(1);
	} finally {
		scan.release();
		await publication;
		await scan.settle();
		await Promise.all(pending);
		spyOn(getStreamingBackend(), "stop").mockImplementation((done) => {
			done();
			return true;
		});
		await session.stopGeneration(18);
	}
});
