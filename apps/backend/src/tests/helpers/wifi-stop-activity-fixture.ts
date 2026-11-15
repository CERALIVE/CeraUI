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
		await f.sample();
		const model: Scenario["model"] = {
			phase: "inactive",
			reply: "ok",
			query: "ok",
		};
		const commands: string[] = [],
			downs: string[] = [],
			queries: string[] = [];
		const events: Scenario["events"] = [];
		let disarm: ReturnType<Scenario["holdDisarm"]> | undefined;
		let entered: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		let released: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		spyOn(nm, "nmConnsGet").mockImplementation(connectionInventory);
		spyOn(runner, "run").mockImplementation(async (binary, args = []) => {
			if (binary !== "nmcli") throw new Error(`Unexpected binary: ${binary}`);
			commands.push(args.join(" "));
			if (args[0] === "con" && args[1] === "modify") {
				const fields = Object.fromEntries(
					Array.from({ length: (args.length - 3) / 2 }, (_, i) => [
						args[3 + i * 2],
						args[4 + i * 2],
					]),
				);
				Object.assign(f.profiles.get(args[2] ?? "") ?? {}, fields);
				if (disarm && fields["connection.autoconnect"] === "no") {
					entered?.resolve();
					await released?.promise;
				}
				return "";
			}
			if (args[0] === "conn" && args[1] === "down") {
				downs.push(args[2] ?? "");
				if (model.reply !== "refuse") model.phase = "inactive";
				if (model.reply !== "ok") throw new Error("memory down reply failed");
				return "Connection successfully deactivated";
			}
			const fieldsAt = args.indexOf("--fields");
			if (fieldsAt >= 0 && args.includes("connection")) {
				const fields = args[fieldsAt + 1] ?? "";
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
			const getAt = args.indexOf("--get-values");
			if (getAt >= 0) {
				const profile = f.profiles.get(args[getAt + 4] ?? "");
				return (args[getAt + 1] ?? "")
					.split(",")
					.map((field) => profile?.[field] ?? "")
					.join("\n");
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
			nmDisconnect: (uuid) => nm.nmDisconnect(uuid),
			releaseConcurrentInterface: async () => undefined,
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
				const target = mode === "hybrid" ? "clap-wlan0" : "wlan0";
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
