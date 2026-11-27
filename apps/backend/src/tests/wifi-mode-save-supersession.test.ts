import { expect, spyOn, test } from "bun:test";
import type { WifiMessage } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-deps.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import * as compat from "../rpc/compat.ts";
import { setWifiAdapterModeProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { isolateTransition } from "./helpers/wifi-transition-fixture.ts";

test("same-radio Configure keeps the admitted prior until the superseded mode terminal", async () => {
	const f = await isolateTransition();
	const defaults = { ...defaultHotspotDeps };
	Object.assign(defaultHotspotDeps, f.deps, {
		broadcastState: broadcastWifiState,
	});
	delete defaultHotspotDeps.pollHotspotActive;
	spyOn(defaultAdapterModeDeps, "persistMode").mockImplementation(() => {});
	spyOn(defaultAdapterModeDeps, "readPersistedMode").mockReturnValue(undefined);
	let expire: (() => void) | undefined;
	spyOn(defaultAdapterModeDeps, "armTerminalTimeout").mockImplementation(
		(action) => {
			expire = action;
			return () => {};
		},
	);
	const events: unknown[] = [];
	spyOn(compat, "broadcastMsg").mockImplementation((type, payload) => {
		if (type !== "wifi") return;
		const frame: WifiMessage = JSON.parse(JSON.stringify(payload));
		events.push([frame, wifiBuildMsg()[0]?.leaving]);
	});
	try {
		expect(
			await call(
				setWifiAdapterModeProcedure,
				{ device: String(f.row.id), mode: "hotspot", incarnation: f.before },
				{ context: f.context },
			),
		).toEqual({ success: true, accepted: true, applied: "hotspot" });
		const uuid = f.created();
		if (!uuid || !expire)
			throw new Error("Missing accepted AP or mode terminal");
		// Discovery may publish the active AP before the Start monitor confirms it.
		f.row.activeConn = uuid;
		f.row.activeMode = "ap";
		expect(wifiBuildMsg()[0]?.observed_mode).toBe("hotspot");
		expect(wifiBuildMsg()[0]?.leaving).toBe("station");
		const duringSave: (string | null | undefined)[] = [];
		await wifiHotspotConfig(
			f.context.ws,
			{
				device: f.row.id,
				incarnation: f.before,
				name: "Peer AP",
				password: "peer-password",
				channel: "auto",
			},
			{
				...defaultHotspotConfigDeps,
				broadcastState: () => {
					duringSave.push(wifiBuildMsg()[0]?.leaving);
				},
			},
		);
		expect(f.row.hotspot.name).toBe("Peer AP");
		expect(f.row.hotspot.transition).toBeUndefined();
		expect(duringSave).toEqual(["station", "station"]);
		expect(wifiBuildMsg()[0]?.leaving).toBe("station");
		const mode = { device: f.row.id, incarnation: f.before };
		expect(events).toEqual([
			[
				{ adapter_mode: { ...mode, pending: true, mode: "hotspot" } },
				undefined,
			],
		]);
		expire();
		const terminal = [
			{ adapter_mode: { ...mode, error: "not-confirmed" } },
			"station",
		];
		expect(events.at(-1)).toEqual(terminal);
		expect(events).toHaveLength(2);
		expect(wifiBuildMsg()[0]?.leaving).toBeUndefined();
	} finally {
		expire?.();
		Object.assign(defaultHotspotDeps, defaults);
		await f.restore();
	}
});
