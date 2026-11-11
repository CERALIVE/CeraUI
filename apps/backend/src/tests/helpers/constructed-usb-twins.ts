import { dirname } from "node:path";

import type { RouterCellularScanDeps } from "../../modules/network/router-cellular-scan.ts";
import capture from "../fixtures/real-device/constructed-issue-432-twin-sysfs.json";

export const constructedTwins = capture.devices;

/** Replay the capture shape through the production sysfs reader. */
export function constructedTwinDeps(
	devices = constructedTwins,
): RouterCellularScanDeps {
	const attrs = new Map<string, string>();
	const links = new Map<string, string>();
	const dirs = new Map<string, string[]>();
	for (const [index, device] of devices.entries()) {
		const parent = dirname(device.readlink);
		const iface = device.readlink.split("/").at(-1) ?? "";
		links.set(`/sys/class/net/${device.ifname}/device`, device.readlink);
		for (const key of [
			"idVendor",
			"idProduct",
			"serial",
			"busnum",
			"devpath",
		] as const) {
			attrs.set(`${parent}/${key}`, device[key]);
		}
		attrs.set(`${parent}/devnum`, String(index + 2));
		attrs.set(`${parent}/bDeviceClass`, "00");
		attrs.set(
			`/run/udev/data/c189:${(Number(device.busnum) - 1) * 128 + index + 1}`,
			`E:ID_PATH=${device.udevadm.ID_PATH}`,
		);
		dirs.set(parent, [iface]);
		attrs.set(`${device.readlink}/bInterfaceClass`, "02");
		attrs.set(`${device.readlink}/bInterfaceSubClass`, "0e");
		attrs.set(`${device.readlink}/bInterfaceProtocol`, "00");
	}
	return {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		listDir: async (path) => dirs.get(path) ?? [],
		readAttr: async (path) => attrs.get(path),
		resolveLink: async (path) => links.get(path),
		readLinkName: async () => "cdc_mbim",
	};
}
