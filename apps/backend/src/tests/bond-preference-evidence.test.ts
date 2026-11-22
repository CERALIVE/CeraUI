import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	isBondOptedOut,
	resetSessionBondOptOutForTest,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import {
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { firstSightIfconfig } from "./helpers/bond-first-sight-fixture.ts";
import {
	clearBondNetworkFixture,
	HUAWEI_TWIN_IP,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const a = "wwu1u4c2";
const b = "wwu1c2";
const serial = "syntheticTwinV9";
const group = mintLinkId(`usb-serial:413c:${serial}`);
const twins = constructedTwins.map((device) => ({ ...device, serial }));
const singleton = twins.filter((device) => device.ifname === a);
const noPath = (device: (typeof twins)[number]) => ({
	...device,
	udevadm: { ...device.udevadm, ID_PATH: "" },
});

let dir: string;

beforeEach(async () => {
	resetBondFixture();
	resetUsbNetMarkers();
	dir = mkdtempSync(join(tmpdir(), "bond-preference-evidence-"));
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ bond_opt_out: { [group]: true } }));
	setConfigFilePath(path);
	await loadConfig();
});

afterEach(() => {
	resetBondFixture();
	resetUsbNetMarkers();
	setConfigFilePath("config.json");
	rmSync(dir, { recursive: true, force: true });
});

async function scan(devices: typeof twins): Promise<void> {
	await refreshUsbNetMarkers(
		devices.map((device) => device.ifname),
		{
			...constructedTwinDeps(devices),
			sharedSerials: defaultRouterCellularScanDeps.sharedSerials,
		},
	);
}

async function reload(): Promise<void> {
	resetSessionBondOptOutForTest();
	clearBondNetworkFixture();
	resetUsbNetMarkers();
	await loadConfig();
}

test.each([
	{ label: "gaining ID_PATH", before: false, after: true, disable: false },
	{ label: "losing ID_PATH", before: true, after: false, disable: false },
	{
		label: "disabling with ID_PATH present",
		before: false,
		after: false,
		disable: true,
	},
	{
		label: "disabling with ID_PATH absent",
		before: true,
		after: true,
		disable: true,
	},
])(
	"a trusted serial keeps its latest toggle after $label",
	async ({ before, after, disable }) => {
		await scan(before ? singleton : singleton.map(noPath));
		expect(resolveModemPhysicalIdentity(a).linkId).toBe(group);
		setPersistentBondOptOut(a, false);
		expect(isBondOptedOut(a)).toBe(false);
		if (disable) {
			await scan(before ? singleton.map(noPath) : singleton);
			setPersistentBondOptOut(a, true);
		}

		await reload();
		await scan(after ? singleton : singleton.map(noPath));
		expect(resolveModemPhysicalIdentity(a).linkId).toBe(group);
		processIfconfigOutput(firstSightIfconfig(a, HUAWEI_TWIN_IP));
		expect(netIfBuildMsg()[a]?.enabled).toBe(!disable);

		if (disable) {
			await reload();
			await scan(twins);
			expect(isBondOptedOut(a)).toBe(true);
			expect(isBondOptedOut(b)).toBe(true);
		}
	},
);

test("an unlocated member of a known shared serial is excluded in its first snapshot", async () => {
	await scan(twins);
	await scan(singleton);
	expect(resolveModemPhysicalIdentity(a).legacyLinkId).toBe(group);
	setPersistentBondOptOut(a, false);
	await reload();

	let first: ReturnType<typeof netIfBuildMsg> | undefined;
	const unsubscribe = onNetworkInterfacesChange(() => {
		const snapshot = netIfBuildMsg();
		if (snapshot[b] !== undefined) first ??= snapshot;
	});
	try {
		await scan(
			twins.map((device) => (device.ifname === b ? noPath(device) : device)),
		);
		expect(resolveModemPhysicalIdentity(b).anchor).toBe("ifname");
		expect(resolveModemPhysicalIdentity(b).legacyLinkId).toBe(group);
		processIfconfigOutput(
			`${firstSightIfconfig(a, HUAWEI_TWIN_IP)}\n\n${firstSightIfconfig(b, HUAWEI_TWIN_IP)}`,
		);
		expect(first?.[a]?.enabled).toBe(true);
		expect(first?.[b]?.enabled).toBe(false);
	} finally {
		unsubscribe();
	}
});

test("a migrated twin's explicit port disable survives loss and return of its serial", async () => {
	await scan(twins);
	const port = resolveModemPhysicalIdentity(b).linkId;
	setPersistentBondOptOut(a, false);
	setPersistentBondOptOut(b, false);
	expect(isBondOptedOut(b)).toBe(false);
	setPersistentBondOptOut(b, true);
	await reload();

	const bWithoutSerial = twins
		.filter((device) => device.ifname === b)
		.map((device) => ({ ...device, serial: "" }));
	await scan(bWithoutSerial);
	expect(resolveModemPhysicalIdentity(b).linkId).toBe(port);
	expect(resolveModemPhysicalIdentity(b).legacyLinkId).toBeUndefined();
	processIfconfigOutput(firstSightIfconfig(b, HUAWEI_TWIN_IP));
	expect(netIfBuildMsg()[b]?.enabled).toBe(false);

	await scan(twins);
	expect(isBondOptedOut(b)).toBe(true);
	expect(isBondOptedOut(a)).toBe(false);
});

test("enabling an excluded, already migrated port survives return of its serial", async () => {
	await scan(twins);
	const port = resolveModemPhysicalIdentity(b).linkId;
	setPersistentBondOptOut(a, false);
	expect(isBondOptedOut(b)).toBe(true);

	const bWithoutSerial = twins
		.filter((device) => device.ifname === b)
		.map((device) => ({ ...device, serial: "" }));
	await scan(bWithoutSerial);
	expect(resolveModemPhysicalIdentity(b).linkId).toBe(port);
	setPersistentBondOptOut(b, false);
	expect(isBondOptedOut(b)).toBe(false);

	await reload();
	await scan(twins);
	expect(isBondOptedOut(b)).toBe(false);
});
