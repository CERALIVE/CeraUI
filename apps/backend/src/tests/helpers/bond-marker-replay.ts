import { expect } from "bun:test";
import {
	refreshDongleMetadata,
	resetDongleMetadata,
} from "../../modules/network/dongle-metadata.ts";
import {
	resetDongleMarkerTracking,
	resetModemNetTracking,
	resetRouterCellularTracking,
} from "../../modules/network/network-interfaces.ts";
import {
	invalidateUsbNetReading,
	refreshUsbNetMarkers,
} from "../../modules/network/router-cellular-scan.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./constructed-usb-twins.ts";

export const markerRows = [
	{ name: "wwu-router", key: "router_cellular" },
	{ name: "wwu-modem", key: "usb_modem_net" },
	{ name: "dg0h", key: "dongle" },
] as const;

export async function primeBondMarkers() {
	const [router, modem] = constructedTwins;
	if (!router || !modem) throw new Error("Expected two USB fixtures");
	const devices = [
		{ ...router, ifname: "wwu-router", idVendor: "12d1", idProduct: "14dc" },
		{ ...modem, ifname: "wwu-modem" },
	];
	const deps = constructedTwinDeps(devices);
	const rndis = {
		bInterfaceClass: "e0",
		bInterfaceSubClass: "01",
		bInterfaceProtocol: "03",
	};
	await refreshUsbNetMarkers(
		devices.map(({ ifname }) => ifname),
		{
			...deps,
			readLinkName: async (path) =>
				path.startsWith(router.readlink) ? "rndis_host" : "cdc_mbim",
			readAttr: async (path) => {
				for (const [key, value] of Object.entries(rndis)) {
					if (path === `${router.readlink}/${key}`) return value;
				}
				return deps.readAttr(path);
			},
		},
	);
	await refreshDongleMetadata({
		listFiles: async () => ["/run/ceralive/dongles/dongle0.json"],
		readFile: async () =>
			JSON.stringify({
				version: 1,
				slot: 0,
				ifname: "fixture0",
				usb_path: "fixture-port",
				mac: "02:00:00:00:20:01",
				driver: "cdc_ether",
				inner_ip: "192.0.2.3",
				inner_gateway: "192.0.2.1",
				veth_host: "dg0h",
				veth_host_ip: "192.0.2.4",
				state: "up",
				updated_at_ms: 1000,
				lease_refresh_ms: 30000,
			}),
		now: () => 1000,
	});
}

export function oweBondMarkerRetractions(anchor: unknown) {
	for (const { name, key } of markerRows)
		expect(anchor).toMatchObject({
			netif: { [name]: { [key]: expect.any(Object) } },
		});
	invalidateUsbNetReading("wwu-router", 1);
	invalidateUsbNetReading("wwu-modem", 1);
	resetDongleMetadata();
}

export function resetBondMarkerReplay() {
	resetDongleMetadata();
	resetDongleMarkerTracking();
	resetModemNetTracking();
	resetRouterCellularTracking();
}
