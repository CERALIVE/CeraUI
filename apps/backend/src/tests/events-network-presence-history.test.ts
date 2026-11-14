import { expect, onTestFinished, test } from "bun:test";
import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import {
	onNetifChange,
	setNetifState,
} from "../modules/network/state/netif-state.ts";
import { resolveUplinkIdentity } from "../modules/network/uplink-identity.ts";
import { recordNetworkEvents } from "./events-network-recording-fixture.ts";

const attrs: Readonly<Record<string, string>> = {
	"/sys/devices/usb/1-1/idVendor": "12d1",
	"/sys/devices/usb/1-1/idProduct": "14dc",
	"/sys/devices/usb/1-1/bDeviceClass": "02",
	"/sys/devices/usb/1-1/manufacturer": "HUAWEI_MOBILE",
	"/sys/devices/usb/1-1/product": "E3372",
	"/sys/devices/usb/1-1/1-1:1.0/bInterfaceClass": "02",
	"/sys/devices/usb/1-1/1-1:1.0/bInterfaceSubClass": "06",
	"/sys/devices/usb/1-1/1-1:1.0/bInterfaceProtocol": "00",
	"/sys/devices/usb/1-1/1-1:1.1/bInterfaceClass": "0a",
	"/sys/devices/usb/1-1/1-1:1.1/bInterfaceSubClass": "06",
	"/sys/devices/usb/1-1/1-1:1.1/bInterfaceProtocol": "00",
};
const usb: RouterCellularScanDeps = {
	sysfsRoot: "/",
	udevDataRoot: "/run/udev/data",
	listDir: async (path) =>
		path === "/sys/devices/usb/1-1" ? ["1-1:1.0", "1-1:1.1"] : [],
	readAttr: async (path) => attrs[path],
	resolveLink: async (path) =>
		path === "/sys/class/net/eth1/device"
			? "/sys/devices/usb/1-1/1-1:1.0"
			: undefined,
	readLinkName: async () => "cdc_ether",
};
const entry = { ip: "192.0.2.2", up: false, tp: 0, txb: 0, error: 0 };

function presence() {
	resetUsbNetMarkers();
	setNetifState({});
	onNetifChange(() => undefined)();
	onTestFinished(() => {
		setNetifState({});
		resetUsbNetMarkers();
	});
	return recordNetworkEvents();
}

test("descriptor retirement preserves the removed down cellular interface's known kind", async () => {
	const h = presence();
	await refreshUsbNetMarkers(["eth1"], usb);
	expect(resolveUplinkIdentity("eth1").kind).toBe("cellular");
	setNetifState({ eth1: entry });
	expect(h.calls).toEqual([
		{ code: "interface_added", params: { iface: "eth1", kind: "cellular" } },
	]);
	h.advance();
	await refreshUsbNetMarkers([], usb);
	expect(resolveUplinkIdentity("eth1").kind).toBe("ethernet");
	setNetifState({});
	h.advance();
	const expected = [
		{ code: "interface_added", params: { iface: "eth1", kind: "cellular" } },
		{ code: "interface_removed", params: { iface: "eth1", kind: "cellular" } },
	];
	expect(h.calls).toEqual(expected);
	expect(h.events()).toEqual(expected);
});

test("kind-only publications refresh removal history without inventing presence changes", async () => {
	const h = presence();
	setNetifState({ eth1: entry });
	const added = {
		code: "interface_added",
		params: { iface: "eth1", kind: "ethernet" },
	};
	expect(h.calls).toEqual([added]);
	h.advance();
	await refreshUsbNetMarkers(["eth1"], usb);
	setNetifState({ eth1: { ...entry } });
	expect(h.calls).toEqual([added]);
	await refreshUsbNetMarkers([], usb);
	setNetifState({});
	h.advance();
	const expected = [
		added,
		{ code: "interface_removed", params: { iface: "eth1", kind: "cellular" } },
	];
	expect(h.calls).toEqual(expected);
	expect(h.events()).toEqual(expected);
});

test("address changes are silent and one snapshot removes every interface in order without a callback", () => {
	const h = presence();
	setNetifState({ wlan0: entry, eth0: entry });
	const added = [
		{ code: "interface_added", params: { iface: "wlan0", kind: "wifi" } },
		{ code: "interface_added", params: { iface: "eth0", kind: "ethernet" } },
	];
	expect(h.calls).toEqual(added);
	h.advance();
	setNetifState({ wlan0: { ...entry, ip: "198.51.100.3" }, eth0: entry });
	expect(h.calls).toEqual(added);
	h.advance();
	expect(h.events()).toEqual(added);
	setNetifState({});
	h.advance();
	const expected = [
		...added,
		{ code: "interface_removed", params: { iface: "wlan0", kind: "wifi" } },
		{ code: "interface_removed", params: { iface: "eth0", kind: "ethernet" } },
	];
	expect(h.calls).toEqual(expected);
	expect(h.events()).toEqual(expected);
});

test("a present interface's new classification replaces older kind history and removed identities are released", async () => {
	const h = presence();
	await refreshUsbNetMarkers(["eth1"], usb);
	setNetifState({ eth1: entry });
	h.advance();
	await refreshUsbNetMarkers([], usb);
	setNetifState({ eth1: { ...entry } });
	expect(h.calls).toHaveLength(1);
	setNetifState({});
	h.advance();
	expect(h.calls).toEqual([
		{ code: "interface_added", params: { iface: "eth1", kind: "cellular" } },
		{ code: "interface_removed", params: { iface: "eth1", kind: "ethernet" } },
	]);
	setNetifState({ eth1: entry });
	h.advance();
	expect(h.calls.at(-1)).toEqual({
		code: "interface_added",
		params: { iface: "eth1", kind: "ethernet" },
	});
});

test("a removal triggered by the publication callback sees the committed kind snapshot", async () => {
	const h = presence();
	await refreshUsbNetMarkers(["eth1"], usb);
	const unsubscribe = onNetifChange((diff) => {
		if (diff.added.length > 0) setNetifState({});
	});
	onTestFinished(unsubscribe);
	setNetifState({ eth1: entry });
	expect(h.calls).toEqual([
		{ code: "interface_added", params: { iface: "eth1", kind: "cellular" } },
		{ code: "interface_removed", params: { iface: "eth1", kind: "cellular" } },
	]);
});

test.each([
	["ip", { ip: "198.51.100.4" }],
	["mac", { mac: "bb:bb:bb:bb:bb:bb" }],
	["up", { up: true }],
	["tp", { tp: 7 }],
	["txb", { txb: 9 }],
	["error", { error: 1 }],
] as const)(
	"a %s update changes the existing diff without creating a presence event",
	(_field, change) => {
		const h = presence();
		const initial = { ...entry, mac: "aa:aa:aa:aa:aa:aa" };
		setNetifState({ eth0: initial });
		const diffs: string[][] = [];
		onTestFinished(
			onNetifChange((diff) => {
				diffs.push(diff.changed.map(({ name }) => name));
			}),
		);
		setNetifState({ eth0: { ...initial, ...change } });
		expect(diffs).toEqual([["eth0"]]);
		expect(h.calls).toEqual([
			{ code: "interface_added", params: { iface: "eth0", kind: "ethernet" } },
		]);
		setNetifState({ eth0: { ...initial, ...change } });
		expect(diffs).toEqual([["eth0"]]);
		expect(h.calls).toHaveLength(1);
	},
);
