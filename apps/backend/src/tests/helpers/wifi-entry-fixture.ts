import { spyOn } from "bun:test";
import type {
	HotspotConfigOutput,
	HotspotPrepareOutput,
	HotspotToggleOutput,
	SetWifiAdapterModeOutput,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as nm from "../../modules/network/network-manager.ts";
import { wifiAdapterModeRecorder } from "../../modules/wifi/wifi-adapter-mode.ts";
import { defaultAdapterModeDeps } from "../../modules/wifi/wifi-adapter-mode-transition.ts";
import { defaultHotspotDeps } from "../../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	defaultHotspotStopDeps,
} from "../../modules/wifi/wifi-hotspot-config.ts";
import {
	hotspotConfigureProcedure,
	hotspotPrepareProcedure,
	hotspotStartProcedure,
	setWifiAdapterModeProcedure,
} from "../../rpc/procedures/wifi.procedure.ts";
import { mockActiveObservation } from "./wifi-active-observation.ts";
import { wifiFrameFixture } from "./wifi-frame-fixture.ts";

const chosen = { name: "Admission AP", password: "admission-password" };
export const guarded = [
	"prepare-load",
	"prepare-save",
	"start",
	"configure",
	"hotspot",
	"hybrid",
] as const;
type Guarded = (typeof guarded)[number];

export async function fixture() {
	const state = await wifiFrameFixture();
	const effects: unknown[] = [];
	spyOn(nm, "nmConnsGet").mockResolvedValue([]);
	mockActiveObservation((ifname) =>
		ifname === state.row.ifname
			? state.row.activeMode === "ap"
				? (state.row.activeConn ?? state.row.conn ?? undefined)
				: undefined
			: state.row.concurrentHotspot?.ifname === ifname
				? (state.row.concurrentHotspot.activeConn ?? undefined)
				: undefined,
	);
	spyOn(defaultHotspotDeps, "readProfilePins").mockResolvedValue(["", ""]);
	spyOn(defaultHotspotDeps.credentials, "get").mockImplementation((owner) => {
		effects.push("store-read");
		return owner === "dc:a6:32:aa:bb:c0"
			? { conn: "test-ap", ssid: "Original AP", password: "original-password" }
			: undefined;
	});
	spyOn(defaultHotspotDeps.credentials, "remember").mockImplementation(() => {
		effects.push("store-write");
	});
	spyOn(wifiAdapterModeRecorder, "persist").mockImplementation(() => {
		effects.push("mode-write");
	});
	spyOn(defaultAdapterModeDeps, "persistMode").mockImplementation(() => {
		effects.push("mode-write");
	});
	spyOn(defaultAdapterModeDeps, "readPersistedMode").mockReturnValue(undefined);
	spyOn(defaultHotspotConfigDeps, "getCapabilities").mockReturnValue(undefined);
	for (const deps of [
		defaultHotspotDeps,
		defaultHotspotConfigDeps,
		defaultHotspotStopDeps,
	]) {
		spyOn(deps, "nmConnSetFields").mockImplementation(async () => {
			effects.push("nm-write");
			return true;
		});
		spyOn(deps, "broadcastState").mockImplementation(() => undefined);
	}
	spyOn(defaultHotspotConfigDeps, "nmConnect").mockResolvedValue(true);
	spyOn(defaultHotspotConfigDeps, "wifiUpdateSavedConns").mockResolvedValue();
	spyOn(defaultHotspotConfigDeps, "rememberCredentials").mockImplementation(
		() => {
			effects.push("store-write");
		},
	);
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(true);
	spyOn(defaultHotspotStopDeps, "rescan").mockResolvedValue();
	return { ...state, effects };
}

export function request(
	kind: Guarded,
	context: Awaited<ReturnType<typeof fixture>>["context"],
	incarnation?: string,
): Promise<
	| HotspotConfigOutput
	| HotspotPrepareOutput
	| HotspotToggleOutput
	| SetWifiAdapterModeOutput
> {
	const input = {
		device: "0",
		...(incarnation === undefined ? {} : { incarnation }),
	};
	switch (kind) {
		case "prepare-load":
			return call(hotspotPrepareProcedure, input, { context });
		case "prepare-save":
			return call(
				hotspotPrepareProcedure,
				{ ...input, ...chosen },
				{ context },
			);
		case "start":
			return call(hotspotStartProcedure, input, { context });
		case "configure":
			return call(
				hotspotConfigureProcedure,
				{ ...input, ...chosen, channel: "auto" },
				{ context },
			);
		case "hotspot":
		case "hybrid":
			return call(
				setWifiAdapterModeProcedure,
				{ ...input, mode: kind },
				{ context },
			);
	}
}
