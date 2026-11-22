import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call } from "@orpc/server";

import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	resetBondOptOutSession,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import { firstSightIfconfig } from "./helpers/bond-first-sight-fixture.ts";
import {
	clearBondNetworkFixture,
	makeRpcContext,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

type Twin = (typeof constructedTwins)[number];

const A = "wwu1u4c2";
const B = "wwu1c2";
const IP: Record<string, string> = { [A]: "100.64.1.1", [B]: "100.64.1.2" };
const SHARED_SERIAL = "syntheticTwinV9";
const PLACEHOLDER_SERIAL = "0123456789ABCDEF";
const twinGroup = mintLinkId(`usb-serial:413c:${SHARED_SERIAL}`);
const placeholderGroup = mintLinkId(`usb-serial:413c:${PLACEHOLDER_SERIAL}`);

function twin(ifname: string, serial = SHARED_SERIAL): Twin {
	const device = constructedTwins.find((d) => d.ifname === ifname);
	if (device === undefined) throw new Error(`missing constructed ${ifname}`);
	return { ...device, serial };
}
const bothTwins = (serial = SHARED_SERIAL) => [
	twin(A, serial),
	twin(B, serial),
];

async function scan(devices: Twin[]): Promise<void> {
	await refreshUsbNetMarkers(
		devices.map((device) => device.ifname),
		{
			...constructedTwinDeps(devices),
			sharedSerials: defaultRouterCellularScanDeps.sharedSerials,
		},
	);
}

function publish(...names: string[]): void {
	processIfconfigOutput(
		names.map((name) => firstSightIfconfig(name, IP[name] ?? "")).join("\n\n"),
	);
}

function configure(name: string, enabled: boolean) {
	return call(
		configureNetworkInterfaceProcedure,
		{ name, ip: IP[name], enabled },
		{ context: makeRpcContext() },
	);
}

async function restart(): Promise<void> {
	resetBondOptOutSession();
	clearBondNetworkFixture();
	resetUsbNetMarkers();
	await loadConfig();
}

async function firstPublicationWith(
	name: string,
	act: () => Promise<void>,
): Promise<ReturnType<typeof netIfBuildMsg> | undefined> {
	let first: ReturnType<typeof netIfBuildMsg> | undefined;
	const unsubscribe = onNetworkInterfacesChange(() => {
		const snapshot = netIfBuildMsg();
		if (snapshot[name] !== undefined) first ??= snapshot;
	});
	try {
		await act();
	} finally {
		unsubscribe();
	}
	return first;
}

describe("an excluded twin group keeps its unplugged twins out", () => {
	let configPath = "";

	beforeEach(async () => {
		resetBondFixture();
		resetUsbNetMarkers();
		configPath = join(mkdtempSync(join(tmpdir(), "bond-twin-")), "config.json");
		writeFileSync(configPath, "{}");
		setConfigFilePath(configPath);
		await loadConfig();
	});

	afterEach(() => {
		resetBondFixture();
		resetUsbNetMarkers();
		setConfigFilePath("config.json");
		rmSync(dirname(configPath), { recursive: true, force: true });
	});

	async function seed(config: object): Promise<void> {
		writeFileSync(configPath, JSON.stringify(config));
		await loadConfig();
	}

	async function enableFirstTwinAlone(): Promise<void> {
		await seed({ bond_opt_out: { [twinGroup]: true } });
		await scan(bothTwins());
		await scan([twin(A)]);
		publish(A);
		expect(netIfBuildMsg()[A]?.enabled).toBe(false);
		expect(await configure(A, true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});
		await restart();
	}

	test("the unplugged twin is excluded in its first publication after a restart", async () => {
		await enableFirstTwinAlone();

		const first = await firstPublicationWith(B, async () => {
			await scan(bothTwins());
			publish(A, B);
		});

		expect(first?.[A]?.enabled).toBe(true);
		expect(first?.[B]?.enabled).toBe(false);
	});

	test("a twin plugged into a port never seen before stays excluded", async () => {
		await enableFirstTwinAlone();
		const moved: Twin = {
			...twin(B),
			readlink: "/sys/devices/platform/fc800000.usb/usb3/3-1/3-1.3/3-1.3:1.0",
			busnum: "3",
			devpath: "1.3",
			udevadm: {
				...twin(B).udevadm,
				ID_PATH: "platform-fc800000.usb-usb-0:1.3:1.0",
			},
		};

		await scan([twin(A), moved]);
		publish(A, B);

		expect(resolveModemPhysicalIdentity(B).legacyLinkId).toBe(twinGroup);
		expect(netIfBuildMsg()[A]?.enabled).toBe(true);
		expect(netIfBuildMsg()[B]?.enabled).toBe(false);
	});

	test("a returning twin without a port path stays out and its enable is refused unsaved", async () => {
		await enableFirstTwinAlone();
		const unlocated: Twin = {
			...twin(B),
			udevadm: { ...twin(B).udevadm, ID_PATH: "" },
		};

		const first = await firstPublicationWith(B, async () => {
			await scan([twin(A), unlocated]);
			publish(A, B);
		});
		expect(resolveModemPhysicalIdentity(B)).toMatchObject({
			anchor: "ifname",
			legacyLinkId: twinGroup,
		});
		expect(first?.[B]?.enabled).toBe(false);

		const saved = readFileSync(configPath, "utf8");
		expect(await configure(B, true)).toEqual({
			success: false,
			error: "bond_identity_unconfirmed",
		});
		expect(readFileSync(configPath, "utf8")).toBe(saved);
		expect(netIfBuildMsg()[B]?.enabled).toBe(false);
	});

	test("an enable made while the twin showed only an unexcluded placeholder does not exempt it from its group", async () => {
		await enableFirstTwinAlone();
		await scan([twin(B, PLACEHOLDER_SERIAL)]);
		publish(B);
		expect(await configure(B, true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});

		await restart();
		await scan(bothTwins());
		publish(A, B);

		expect(netIfBuildMsg()[A]?.enabled).toBe(true);
		expect(netIfBuildMsg()[B]?.enabled).toBe(false);
	});

	test("an exception counts only for the excluded group it was granted under", async () => {
		await seed({
			bond_opt_out: { [twinGroup]: true, [placeholderGroup]: true },
		});
		await scan(bothTwins());
		await scan([twin(A, PLACEHOLDER_SERIAL)]);
		publish(A);
		expect(await configure(A, true)).toMatchObject({ success: true });

		await scan([twin(A)]);
		expect(netIfBuildMsg()[A]?.enabled).toBe(false);
		expect(await configure(A, true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});

		await scan(bothTwins(PLACEHOLDER_SERIAL));
		publish(A, B);
		expect(await configure(B, true)).toMatchObject({
			success: true,
			applied: { enabled: true },
		});

		await restart();
		await scan(bothTwins());
		publish(A, B);
		expect(netIfBuildMsg()[A]?.enabled).toBe(true);
		expect(netIfBuildMsg()[B]?.enabled).toBe(false);
	});

	test("a twin whose shared-serial record was evicted stays out until both twins are seen again", async () => {
		await enableFirstTwinAlone();
		getConfig().usb_serial_shared = Array.from({ length: 64 }, (_, index) =>
			index.toString(16).padStart(64, "0"),
		);
		saveConfig();
		await restart();

		await scan([twin(A)]);
		publish(A);
		expect(resolveModemPhysicalIdentity(A).linkId).toBe(twinGroup);
		expect(netIfBuildMsg()[A]?.enabled).toBe(false);
		expect(await configure(A, true)).toEqual({
			success: false,
			error: "bond_identity_unconfirmed",
		});

		await scan(bothTwins());
		publish(A, B);
		expect(netIfBuildMsg()[A]?.enabled).toBe(true);
		expect(netIfBuildMsg()[B]?.enabled).toBe(false);
	});

	test("an enable while the twin's identity is still pending is refused, not reported saved", async () => {
		await seed({ bond_opt_out: { [twinGroup]: true } });
		await scan(bothTwins());
		await restart();
		processIfconfigOutput(
			firstSightIfconfig(A, IP[A] ?? ""),
			undefined,
			undefined,
			new Map([[A, { result: { kind: "unreadable", code: "EIO" }, seen: 0 }]]),
		);

		expect(await configure(A, true)).toEqual({
			success: false,
			error: "bond_identity_unconfirmed",
		});

		await scan([twin(A)]);
		expect(netIfBuildMsg()[A]?.enabled).toBe(false);
	});
});
