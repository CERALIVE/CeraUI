import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	netIfBuildMsg,
	onNetworkInterfacesChange,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import { resetUsbNetMarkers } from "../modules/network/router-cellular-scan.ts";
import { setup } from "../modules/setup.ts";
import { resetBindMapWriter } from "../modules/streaming/bind-map-writer.ts";
import {
	identityForIface,
	resetBondIdentities,
} from "../modules/streaming/link-registry.ts";
import * as srtla from "../modules/streaming/srtla.ts";
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
