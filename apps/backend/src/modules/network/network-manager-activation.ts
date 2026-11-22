import { type DbusValue, isVariant } from "@ceralive/modem-control/transport";
import { nmActivationBus } from "./network-manager-profile-instance.ts";

const NM = "org.freedesktop.NetworkManager";
const BUS = "org.freedesktop.DBus";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const ACTIVE = `${NM}.Connection.Active`;
const ROOT = "/org/freedesktop/NetworkManager";
const DEACTIVATED = 4;
const DOWN_WAIT_MS = 10_000;

/** Validate the bus ID and address the original daemon on this same socket. */
export async function deactivateNmActivation(
	path: string,
	runId: string,
	uuid: string,
	ifname: string,
): Promise<boolean> {
	const [busId, owner] = runId.split("/");
	if (!busId || !owner || !/^:[\w-]+(?:\.[\w-]+)+$/.test(owner)) return false;
	const bus = nmActivationBus.open();
	try {
		await bus.connect();
		const identity = await bus.callMethod({
			destination: BUS,
			path: "/org/freedesktop/DBus",
			interface: BUS,
			member: "GetId",
			timeoutMs: 1000,
		});
		if (identity.body[0] !== busId) return false;
		const property = async (object: string, iface: string, name: string) => {
			const reply = await bus.callMethod({
				destination: owner,
				path: object,
				interface: PROPERTIES,
				member: "Get",
				signature: "ss",
				args: [iface, name],
				timeoutMs: 1000,
			});
			const value = reply.body[0];
			return value !== undefined && isVariant(value) ? value.value : undefined;
		};
		const removed = (value: DbusValue | undefined) =>
			Array.isArray(value) &&
			value.every((item) => typeof item === "string") &&
			!value.includes(path);
		const absent = () => property(ROOT, NM, "ActiveConnections").then(removed);
		const terminal = Promise.withResolvers<boolean>();
		await bus.subscribeSignal(
			{ sender: owner, path, interface: ACTIVE, member: "StateChanged" },
			(event) => {
				if (event.body[0] === DEACTIVATED) terminal.resolve(true);
			},
		);
		await bus.subscribeSignal(
			{
				sender: owner,
				path: ROOT,
				interface: PROPERTIES,
				member: "PropertiesChanged",
			},
			(event) => {
				if (event.body[0] !== NM || !Array.isArray(event.body[1])) return;
				for (const entry of event.body[1]) {
					if (
						Array.isArray(entry) &&
						entry[0] === "ActiveConnections" &&
						entry[1] !== undefined &&
						isVariant(entry[1]) &&
						removed(entry[1].value)
					)
						terminal.resolve(true);
				}
			},
		);
		const verified = await Promise.all([
			property(path, ACTIVE, "Uuid"),
			property(path, ACTIVE, "Devices"),
			property(path, ACTIVE, "State"),
		]).catch((error: unknown) => {
			if (error instanceof Error) return undefined;
			throw error;
		});
		if (!verified) return false;
		const [actualUuid, devices, state] = verified;
		if (
			actualUuid !== uuid ||
			!Array.isArray(devices) ||
			devices.length !== 1 ||
			typeof devices[0] !== "string" ||
			(await property(devices[0], `${NM}.Device`, "Interface")) !== ifname
		)
			return false;
		if (state === DEACTIVATED) return true;
		if (state !== 1 && state !== 2 && state !== 3) return false;
		const completedAfterReply = async () => {
			if (await absent()) return true;
			return (await property(path, ACTIVE, "State")) === DEACTIVATED;
		};
		if (state !== 3) {
			try {
				await bus.callMethod({
					destination: owner,
					path: ROOT,
					interface: NM,
					member: "DeactivateConnection",
					signature: "o",
					args: [path],
					timeoutMs: DOWN_WAIT_MS,
				});
			} catch (error: unknown) {
				if (!(error instanceof Error)) throw error;
				return false;
			}
		}
		if (await completedAfterReply().catch(() => false)) return true;
		const timer = setTimeout(() => terminal.resolve(false), DOWN_WAIT_MS);
		try {
			return await terminal.promise;
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await bus.disconnect();
	}
}
