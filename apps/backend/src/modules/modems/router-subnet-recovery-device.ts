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
	requireKernelProof: boolean,
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
	let located: string | undefined;
	for (const bus of buses) {
		const name = `usb${bus}`;
		let controllerPath: string | undefined;
		try {
			const target = routerUsbSysfs.rootPath(name);
			if (target.startsWith("/sys/devices/") && target.endsWith(`/${name}`)) {
				controllerPath = target.slice(0, -(name.length + 1));
			}
		} catch {
			// A bus with no device at that chain cannot account for occupancy.
		}
		const controller = controllerPath?.split("/").at(-1);
		if (controller === undefined || controllerPath === undefined) {
			if (occupied.has(bus)) return true;
		} else if (port.hasController(controller)) {
			if (requireKernelProof) {
				// Compatibility suffix matches may veto absence, but cannot establish it.
				const pci = /^[0-9a-f]{4,}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/.test(
					controller,
				);
				const transport = pci ? "pci" : "platform";
				const key = `${transport}-${controller}-usb-0:${port.portChain}`;
				if (port.stableKey !== key) continue;
				if (located !== undefined && located !== controllerPath) return true;
			}
			if (occupied.has(bus)) return true;
			located = controllerPath;
		}
	}
	if (
		paths.some((path) => port.containsDevpath(path)) ||
		[...occupied].some((bus) => !buses.has(bus))
	)
		return true;
	if (located !== undefined) return false;
	if (requireKernelProof) return true;
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

/** Presence evidence for operator decisions, never permission for router writes. */
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

/** A parser miss cannot retire a rollback obligation without corroboration. */
export async function replayDeviceAbsenceProven(
	entry: ModemMutationEntry,
): Promise<boolean> {
	try {
		const device = await observeMutationDevice(entry, readUdevExportDb, true);
		return device.status === "absent";
	} catch {
		// A missing reader, unresolved controller, or failed scan is not absence.
		return false;
	}
}

async function observeMutationDevice(
	entry: ModemMutationEntry,
	readDatabase: () => Promise<string>,
	requireKernelProof = false,
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
		if (keyed || usbPortIsOccupied(port, paths, hubPaths, requireKernelProof))
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
		if (address === undefined) {
			if (requireKernelProof) return { status: "unknown" };
		} else if (
			paths.some((path) => path.split("/").includes(address)) ||
			(requireKernelProof
				? modemPciSysfs.addresses().includes(address)
				: pciFunctionIsPresent(address))
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
