import { readdirSync, readFileSync, realpathSync } from "node:fs";
import {
	deriveModemStableKey,
	type ModemMutationEntry,
	modemRecoveryPort,
} from "@ceraui/rpc/schemas";
import { readNetdevWitness } from "../network/netdev-lifetime.ts";
import { supportsSubnetRewrite } from "../network/router-subnet-hygiene.ts";
import { sameBootRouterSubnetWitness } from "../network/router-subnet-witness.ts";
import { isSafeIfname } from "../network/safe-ifname.ts";
import {
	parseNetIdPaths,
	readUdevExportDb,
	udevPropertyRecords,
} from "./modem-id-path-source.ts";
import {
	captureUsbDescriptor,
	enumerateMutationUsb,
	isCoherentState,
} from "./mutation-rollback.ts";

type MutationDevicePresence =
	| { readonly status: "absent" | "unknown" }
	| {
			readonly status: "present";
			readonly identity: "usb-descriptor" | "id-path";
			readonly ifname: string | undefined;
			readonly state: Readonly<Record<string, unknown>>;
	  };

const USB_SYSFS = "/sys/bus/usb/devices";

export const routerUsbSysfs = {
	names: (): readonly string[] => readdirSync(USB_SYSFS),
	rootPath: (name: string): string => realpathSync(`${USB_SYSFS}/${name}`),
	deviceClass: (name: string): string =>
		readFileSync(`${USB_SYSFS}/${name}/bDeviceClass`, "utf8").trim(),
};

export const modemPciSysfs = {
	addresses: (): readonly string[] => readdirSync("/sys/bus/pci/devices"),
};

function pciFunctionIsPresent(address: string): boolean {
	try {
		return modemPciSysfs.addresses().includes(address);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

function usbPortIsOccupied(
	port: NonNullable<ReturnType<typeof modemRecoveryPort>>,
	paths: readonly string[],
	hubPaths: ReadonlySet<string>,
): boolean {
	// udev export can omit a newly enumerated device (or still be partial on
	// success). Check the kernel inventory on every potentially matching bus.
	const names = new Set(routerUsbSysfs.names());
	const buses = new Set<string>();
	for (const name of names) {
		const bus = /^usb(\d+)$/.exec(name)?.[1];
		if (bus !== undefined) buses.add(bus);
	}
	const occupied = new Set(
		[...names].flatMap((name) => {
			const match = /^(\d+)-(.+)$/.exec(name);
			return match?.[1] !== undefined && match[2] === port.portChain
				? [match[1]]
				: [];
		}),
	);
	let located = false;
	for (const bus of buses) {
		const name = `usb${bus}`;
		let controller: string | undefined;
		try {
			const target = routerUsbSysfs.rootPath(name);
			if (target.startsWith("/sys/devices/") && target.endsWith(`/${name}`)) {
				controller = target.split("/").at(-2);
			}
		} catch {
			// A bus with no device at that chain cannot account for occupancy.
		}
		if (controller === undefined) {
			if (occupied.has(bus)) return true;
		} else if (port.hasController(controller)) {
			if (occupied.has(bus)) return true;
			located = true;
		}
	}
	if (
		paths.some((path) => port.containsDevpath(path)) ||
		[...occupied].some((bus) => !buses.has(bus))
	)
		return true;
	if (located) return false;
	// An unrelated hub can sit at this chain permanently. Ignore only devices
	// positively identified as hubs, and only in the cross-controller fallback.
	return (
		paths.some((path) => {
			const devicePath = port.devicePathAtChain(path);
			return devicePath !== undefined && !hubPaths.has(devicePath);
		}) ||
		[...occupied].some(
			(bus) => routerUsbSysfs.deviceClass(`${bus}-${port.portChain}`) !== "09",
		)
	);
}

/** The same presence evidence for all operator decisions, never for replay or router writes. */
export async function resolveMutationDevice(
	entry: ModemMutationEntry,
	readDatabase: () => Promise<string> = readUdevExportDb,
): Promise<MutationDevicePresence> {
	try {
		return await observeMutationDevice(entry, readDatabase);
	} catch {
		return { status: "unknown" };
	}
}

async function observeMutationDevice(
	entry: ModemMutationEntry,
	readDatabase: () => Promise<string>,
): Promise<MutationDevicePresence> {
	let database: Promise<string> | undefined;
	const readOnce = () => (database ??= readDatabase());
	const port = modemRecoveryPort(entry.stableKey);
	const devices = await enumerateMutationUsb(readOnce);
	const matching = devices.filter(
		(device) => deriveModemStableKey(device.physicalUid) === entry.stableKey,
	);
	const device = matching[0];
	if (matching.length > 1) return { status: "unknown" };
	if (device !== undefined) {
		const state = {
			...captureUsbDescriptor(device),
			ifname: device.ifname ?? "",
		};
		if (!isCoherentState(state)) return { status: "unknown" };
		let ifname: string | undefined;
		if (
			entry.kind === "router-subnet" &&
			port &&
			supportsSubnetRewrite(state.vidPid)
		) {
			const netdevs = [...parseNetIdPaths(await readOnce())].filter(
				([, path]) => deriveModemStableKey(path) === entry.stableKey,
			);
			const candidate = netdevs[0]?.[0];
			if (
				netdevs.length === 1 &&
				candidate !== undefined &&
				isSafeIfname(candidate)
			)
				ifname = candidate;
		}
		return {
			status: "present",
			identity: "usb-descriptor",
			state,
			ifname,
		};
	}

	const records = [...udevPropertyRecords(await readOnce())];
	const paths = records.flatMap(({ path }) =>
		path?.startsWith("/devices/") ? [path] : [],
	);
	if (paths.length === 0) return { status: "unknown" };
	const keyed = records.some(
		({ env }) => deriveModemStableKey(env.get("ID_PATH")) === entry.stableKey,
	);
	if (port) {
		const hubPaths = new Set(
			records.flatMap(({ path, env }) =>
				path?.startsWith("/devices/") &&
				env.get("SUBSYSTEM") === "usb" &&
				env.get("DEVTYPE") === "usb_device" &&
				/^9\/\d+\/\d+$/.test(env.get("TYPE") ?? "")
					? [path]
					: [],
			),
		);
		if (keyed || usbPortIsOccupied(port, paths, hubPaths))
			return { status: "unknown" };
	} else {
		if (keyed) {
			// Whole-device ID_PATH is the baseline for PCIe/SoC. It is
			// identity, not evidence of USB mode or the router DHCP state.
			return {
				status: "present",
				identity: "id-path",
				state: { idPath: entry.stableKey },
				ifname: undefined,
			};
		}
		const address =
			/(?:^|-)pci-([0-9a-f]{4,}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/.exec(
				entry.stableKey,
			)?.[1];
		if (
			address &&
			(paths.some((path) => path.split("/").includes(address)) ||
				pciFunctionIsPresent(address))
		) {
			return { status: "unknown" };
		}
	}
	const witness = sameBootRouterSubnetWitness(entry.preState);
	if (
		witness !== undefined &&
		readdirSync("/sys/class/net").some(
			(name) =>
				isSafeIfname(name) && readNetdevWitness(name).node === witness.node,
		)
	) {
		return { status: "unknown" };
	}
	return { status: "absent" };
}
