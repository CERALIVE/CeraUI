import { spyOn } from "bun:test";
import * as runner from "../../helpers/run.ts";
import * as time from "../../helpers/time.ts";
import { resolvePhysicalDevice } from "../../modules/modems/physical-identity.ts";
import {
	defaultRouterCellularScanDeps,
	refreshUsbNetMarkers,
} from "../../modules/network/router-cellular-scan.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./constructed-usb-twins.ts";

export const FIRST_SIGHT_IFACE = "wwu1c2";
export const FIRST_SIGHT_IP = "100.64.1.2";

export function firstSightIfconfig(ifname: string, ip: string): string {
	return [
		`${ifname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0`,
		"        ether 02:00:00:00:00:01",
		"        RX packets 1  bytes 0",
		"        TX packets 1  bytes 0",
	].join("\n");
}

/** Constructed port identity, independent of the live descriptor cache. */
export function firstSightPhysicalDevice() {
	const device = constructedTwins.find((d) => d.ifname === FIRST_SIGHT_IFACE);
	if (device === undefined) throw new Error("missing constructed modem");
	return resolvePhysicalDevice({
		ifname: FIRST_SIGHT_IFACE,
		idPath: device.udevadm.ID_PATH,
		vid: device.idVendor,
		pid: device.idProduct,
	});
}

/** The real OS publication and USB reader, with only OS reads and time injected. */
export function firstSightScan(
	output: string,
	blockedIfnames: readonly string[] = [FIRST_SIGHT_IFACE],
	devices = constructedTwins,
) {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const clock = { now: 0 };
	const fixture = constructedTwinDeps(devices);
	spyOn(time, "getms").mockImplementation(() => clock.now);
	spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
		async (path) => {
			if (
				blockedIfnames.some(
					(ifname) => path === `/sys/class/net/${ifname}/device`,
				)
			) {
				entered.resolve();
				await gate.promise;
			}
			return fixture.resolveLink(path);
		},
	);
	spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
		fixture.readAttr,
	);
	spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
		fixture.listDir,
	);
	spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
		fixture.readLinkName,
	);
	spyOn(runner, "run").mockImplementation(async (bin) =>
		bin === "ifconfig" ? output : "",
	);
	return {
		clock,
		entered: entered.promise,
		release: () => gate.resolve(),
		settle: () =>
			refreshUsbNetMarkers(
				output.split("\n\n").map((entry) => entry.split(":")[0] ?? ""),
			),
	};
}
