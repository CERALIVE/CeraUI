import { spyOn } from "bun:test";
import * as runner from "../../helpers/run.ts";
import * as nm from "../../modules/network/network-manager.ts";
import { wifiAdapterModeRecorder } from "../../modules/wifi/wifi-adapter-mode.ts";
import type { HotspotStopDeps } from "../../modules/wifi/wifi-hotspot-config.ts";
import { handleWifiMonitorEvent } from "../../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotOutcomeKind,
	HotspotToggleOutcome,
} from "../../modules/wifi/wifi-hotspot-outcome.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../../modules/wifi/wifi-interfaces.ts";
import { nmcliFieldNames, nmcliFieldOutput } from "./nmcli-field-output.ts";
import { mockActivationBus } from "./wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PROFILE,
} from "./wifi-autoconnect-fixture.ts";

type Phase = "inactive" | "activating" | "activated";
type Scenario = {
	row: WifiInterfaceWithHotspot;
	start: HotspotActivationDeps;
	stop: HotspotStopDeps;
	commands: string[];
	downs: string[];
	queries: string[];
	events: Array<{ kind: HotspotOutcomeKind; outcome: HotspotToggleOutcome }>;
	model: {
		phase: Phase;
		reply: "ok" | "refuse" | "lost";
		query: "ok" | "unreadable" | "malformed";
	};
	holdDisarm: () => { entered: Promise<void>; release: () => void };
	lateConnected: () => Promise<void>;
};

export function stopActivityFixture(): (
	mode: "hotspot" | "hybrid",
) => Promise<Scenario> {
	const f = autoconnectFixture();
	const connectionInventory = nm.nmConnsGet;
	return async (mode) => {
		const row = f.row();
		row.supportsApStaConcurrency = mode === "hybrid";
		getWifiIdToMacAddress()[0] = MAC;
		const target = mode === "hybrid" ? "clap-wlan0" : "wlan0";
		if (mode === "hybrid") {
			const parent = f.witnesses.get("wlan0");
			if (!parent) throw new Error("Missing hybrid parent witness");
			f.witnesses.set(target, { ...parent, ifindex: 7 });
		}
		await f.sample();
		const model: Scenario["model"] = {
			phase: "inactive",
			reply: "ok",
			query: "ok",
		};
		const commands: string[] = [],
			downs: string[] = [],
			queries: string[] = [];
		const activePath = "/org/freedesktop/NetworkManager/ActiveConnection/1";
		mockActivationBus(
			() => "00000000000000000000000000000001",
			(call) => {
				if (call.destination !== ":1.1" || call.args?.[0] !== activePath)
					throw new Error("Down did not target the selected activation");
				downs.push(PROFILE);
				if (model.reply !== "refuse") model.phase = "inactive";
				if (model.reply !== "ok") throw new Error("memory down reply failed");
			},
			() =>
				model.phase === "inactive"
					? undefined
					: {
							uuid: PROFILE,
							path: activePath,
							ifname: target,
						},
		);
		const deviceProp = spyOn(nm, "nmDeviceProp");
		const otherDeviceFields = deviceProp.getMockImplementation();
		deviceProp.mockImplementation(async (ifname, fields, mode) => {
			if (fields === "GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH")
				return ifname === target && model.phase !== "inactive"
					? [model.phase === "activated" ? "100" : "70", PROFILE, activePath]
					: ["30", "", ""];
			return otherDeviceFields?.(ifname, fields, mode);
		});
		spyOn(nm, "nmDevices").mockImplementation(async () => [
			`${target}:wifi:${model.phase === "inactive" ? "disconnected:" : `${model.phase}:${PROFILE}`}`,
		]);
		const events: Scenario["events"] = [];
		let disarm: ReturnType<Scenario["holdDisarm"]> | undefined;
		let entered: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		let released: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		const inventorySpy = spyOn(nm, "nmConnsGet");
		const resourceInventory = inventorySpy.getMockImplementation();
		if (!resourceInventory)
			throw new Error("Missing fixture resource inventory");
		inventorySpy.mockImplementation(connectionInventory);
		const runSpy = spyOn(runner, "run");
		const resourceBoundary = runSpy.getMockImplementation();
		if (!resourceBoundary) throw new Error("Missing fixture resource boundary");
		runSpy.mockImplementation(async (binary, args = [], options) => {
			if (binary === "busctl") return resourceBoundary(binary, args, options);
			if (binary !== "nmcli") throw new Error(`Unexpected binary: ${binary}`);
			commands.push(args.join(" "));
			if (args[0] === "con" && args[1] === "modify") {
				const fields = Object.fromEntries(
					Array.from({ length: (args.length - 3) / 2 }, (_, i) => [
						args[3 + i * 2],
						args[4 + i * 2],
					]),
				);
				await resourceBoundary(binary, args, options);
				if (disarm && fields["connection.autoconnect"] === "no") {
					entered?.resolve();
					await released?.promise;
				}
				return "";
			}
			const fieldsAt = args.indexOf("--fields");
			if (
				fieldsAt >= 0 &&
				args.includes("connection") &&
				!args.includes("multiline")
			) {
				const fields = args[fieldsAt + 1] ?? "";
				if (fields === "uuid,dbus-path" || fields === "uuid,filename")
					return (await resourceInventory(fields))?.join("\n") ?? "";
				if (fields.includes("active")) {
					queries.push(fields);
					if (model.query === "unreadable")
						throw new Error("inventory unavailable");
				}
				return [...f.profiles.keys()]
					.map((uuid) =>
						fields
							.split(",")
							.map((field) =>
								field === "uuid"
									? uuid
									: field === "type"
										? "802-11-wireless"
										: field === "active"
											? model.query === "malformed"
												? "unknown"
												: uuid === PROFILE && model.phase !== "inactive"
													? "yes"
													: "no"
											: "",
							)
							.join(":"),
					)
					.join("\n");
			}
			if (nmcliFieldNames(args).length > 0) {
				const profile = f.profiles.get(args.at(-1) ?? "");
				return nmcliFieldOutput(args, (field) => profile?.[field] ?? "");
			}
			throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
		});
		const publish = (
			kind: HotspotOutcomeKind,
			_device: number | string,
			outcome: HotspotToggleOutcome,
		) => {
			events.push({ kind, outcome });
		};
		const start: HotspotActivationDeps = {
			...f.deps,
			readCapabilities: () => ({
				staApCombo: { supported: mode === "hybrid" },
			}),
			nmConnect: async () => {
				model.phase = "activating";
				return true;
			},
			publishOutcome: publish,
		};
		const stop: HotspotStopDeps = {
			recordIntent: wifiAdapterModeRecorder,
			nmConnSetFields: (uuid, fields) => nm.nmConnSetFields(uuid, fields),
			nmDisconnect: (...args) => nm.nmDisconnect(...args),
			releaseConcurrentInterface: async () => true,
			broadcastState: () => undefined,
			setDupIpSuppression: () => undefined,
			rescan: async () => undefined,
			publishOutcome: publish,
		};
		return {
			row,
			start,
			stop,
			commands,
			downs,
			queries,
			events,
			model,
			holdDisarm() {
				const profile = f.profiles.get(PROFILE);
				if (profile) profile["connection.autoconnect"] = "yes";
				entered = Promise.withResolvers<void>();
				released = Promise.withResolvers<void>();
				disarm = {
					entered: entered.promise,
					release: () => released?.resolve(),
				};
				return disarm;
			},
			async lateConnected() {
				if (model.phase !== "inactive") model.phase = "activated";
				f.list([
					`${target}:wifi:${model.phase === "activated" ? `connected:${PROFILE}` : "disconnected:"}`,
				]);
				await handleWifiMonitorEvent({
					type: "device-state",
					device: target,
					state: "connected",
				});
			},
		};
	};
}
