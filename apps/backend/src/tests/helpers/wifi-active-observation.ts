import { spyOn } from "bun:test";
import type {
	DbusTransport,
	DbusValue,
	MethodCall,
	SignalListener,
} from "@ceralive/modem-control/transport";
import * as nm from "../../modules/network/network-manager.ts";
import * as profileInstance from "../../modules/network/network-manager-profile-instance.ts";

export const ACTIVE_PATH = "/org/freedesktop/NetworkManager/ActiveConnection/1";
export const RUN_ID = "00000000000000000000000000000001/:1.1";

export function mockActivationBus(
	getId: () => string,
	deactivate: (call: MethodCall) => void | Promise<void>,
	activation: () =>
		| {
				readonly uuid: string;
				readonly ifname: string;
				readonly path: string;
				readonly state?: number;
		  }
		| undefined = () => ({
		uuid: "policy-ap",
		ifname: "wlan0",
		path: ACTIVE_PATH,
	}),
	settleWithReply = true,
	onInspect?: (path: string) => void,
	onPostReplyRead?: (property: "ActiveConnections" | "State") => void,
) {
	const listeners = new Map<string, SignalListener>();
	const finished = new Set<string>();
	const terminal = (path: string) => {
		finished.add(path);
		listeners.get("StateChanged")?.({
			path,
			member: "StateChanged",
			interface: "org.freedesktop.NetworkManager.Connection.Active",
			sender: ":1.1",
			signature: "uu",
			body: [4, 0],
		});
	};
	spyOn(profileInstance.nmActivationBus, "open").mockImplementation(() => {
		const id = getId();
		let connected = false;
		let downAcknowledged = false;
		return {
			connect: async () => {
				connected = true;
			},
			disconnect: async () => {
				connected = false;
			},
			isConnected: () => connected,
			callMethod: async (call) => {
				if (!connected) throw new Error("Bus is closed");
				if (call.member === "GetId") return { signature: "s", body: [id] };
				if (call.member === "Get") {
					const active = activation();
					const property = call.args?.[1];
					let value: DbusValue;
					if (property === "ActiveConnections") {
						value = active && !finished.has(active.path) ? [active.path] : [];
						if (downAcknowledged) onPostReplyRead?.(property);
					} else {
						if (property === "Uuid") onInspect?.(call.path);
						if (!active) throw new Error("No such activation");
						if (property !== "Interface" && call.path !== active.path)
							throw new Error("No such activation path");
						if (property === "Uuid") value = active.uuid;
						else if (property === "Devices")
							value = ["/org/freedesktop/NetworkManager/Devices/1"];
						else if (property === "State") {
							value = finished.has(call.path) ? 4 : (active.state ?? 2);
							if (downAcknowledged) onPostReplyRead?.(property);
						} else if (property === "Interface") value = active.ifname;
						else throw new Error("Unexpected activation property");
					}
					return {
						signature: "v",
						body: [
							{
								signature: Array.isArray(value)
									? "ao"
									: typeof value === "number"
										? "u"
										: "s",
								value,
							},
						],
					};
				}
				if (call.member !== "DeactivateConnection" || call.signature !== "o")
					throw new Error("Unexpected activation bus call");
				await deactivate(call);
				downAcknowledged = true;
				if (settleWithReply && typeof call.args?.[0] === "string")
					terminal(call.args[0]);
				return { signature: "", body: [] };
			},
			subscribeSignal: async (spec, listener) => {
				listeners.set(spec.member, listener);
				return {
					unsubscribe: async () => {
						listeners.delete(spec.member);
					},
				};
			},
			on: () => undefined,
			off: () => undefined,
			subscriptionCount: () => 0,
		} satisfies DbusTransport;
	});
	return terminal;
}

export function mockActiveObservation(
	active: (ifname: string) => string | undefined,
) {
	spyOn(profileInstance, "nmRunId").mockResolvedValue(RUN_ID);
	const deviceProp = nm.nmDeviceProp;
	spyOn(nm, "nmDeviceProp").mockImplementation((ifname, fields, mode) => {
		if (fields === "GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH") {
			const uuid = active(ifname);
			return Promise.resolve(
				uuid ? ["100", uuid, ACTIVE_PATH] : ["30", "", ""],
			);
		}
		return deviceProp(ifname, fields, mode);
	});
}

/** Project the same simulated activation in both the roster and device receipt. */
export function mockRosterActivation() {
	spyOn(profileInstance, "nmRunId").mockResolvedValue(RUN_ID);
	const stub = spyOn(nm, "nmDeviceProp");
	const deviceProp = stub.getMockImplementation();
	stub.mockImplementation(async (ifname, fields, mode) => {
		if (fields !== "GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH")
			return deviceProp?.(ifname, fields, mode);
		const roster = await nm.nmDevices("device,type,state,con-uuid");
		const entry = roster
			?.map(nm.nmcliParseSep)
			.find(([name]) => name === ifname);
		if (!entry) return undefined;
		const [, , state, uuid] = entry;
		return state === "connected" && uuid && uuid !== "--"
			? ["100", uuid, ACTIVE_PATH]
			: ["30", "", ""];
	});
}
