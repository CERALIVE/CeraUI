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
	options: {
		blocked?: readonly string[];
		buses?: Readonly<Record<string, string>>;
		devices?: typeof constructedTwins;
	} = {},
) {
	const clock = { now: 0 };
	const fixture = constructedTwinDeps(options.devices);
	const reads = new Map<
		string,
		{
			gate: ReturnType<typeof Promise.withResolvers<void>>;
			entered: ReturnType<typeof Promise.withResolvers<void>>;
		}
	>();
	const block = (name: string) => {
		reads.set(name, {
			gate: Promise.withResolvers<void>(),
			entered: Promise.withResolvers<void>(),
		});
	};
	for (const name of options.blocked ?? [FIRST_SIGHT_IFACE]) block(name);
	const busReplies = new Map<string, () => Promise<string | undefined>>();
	const busCounts = new Map<string, number>();
	for (const [name, bus] of Object.entries(options.buses ?? {}))
		busReplies.set(name, async () => bus);
	spyOn(time, "getms").mockImplementation(() => clock.now);
	spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
		async (path) => {
			const parked = reads.get(path.split("/").at(-2) ?? "");
			if (parked) {
				parked.entered.resolve();
				await parked.gate.promise;
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
		(path) => {
			if (!path.endsWith("/device/subsystem"))
				return fixture.readLinkName(path);
			const name = path.split("/").at(-3) ?? "";
			busCounts.set(name, (busCounts.get(name) ?? 0) + 1);
			return busReplies.get(name)?.() ?? Promise.resolve(undefined);
		},
	);
	spyOn(runner, "run").mockImplementation(async (bin) =>
		bin === "ifconfig" ? output : "",
	);
	return {
		clock,
		block,
		busCounts,
		entered: reads.get(FIRST_SIGHT_IFACE)?.entered.promise ?? Promise.resolve(),
		enteredFor: (name: string) =>
			reads.get(name)?.entered.promise ?? Promise.resolve(),
		setOutput: (next: string) => {
			output = next;
		},
		setBus: (name: string, reply: () => Promise<string | undefined>) =>
			busReplies.set(name, reply),
		release: () => {
			for (const read of reads.values()) read.gate.resolve();
		},
		settle: () =>
			refreshUsbNetMarkers(
				output.split("\n\n").map((entry) => entry.split(":")[0] ?? ""),
			),
	};
}
