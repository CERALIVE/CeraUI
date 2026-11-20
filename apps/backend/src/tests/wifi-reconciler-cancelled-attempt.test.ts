import { expect, test } from "bun:test";
import {
	getBootReadiness,
	markBootDegraded,
} from "../modules/system/readiness.ts";
import { notifyWifiAdapterModeEdge } from "../modules/wifi/wifi-adapter-mode-events.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { MAC } from "./helpers/wifi-autoconnect-fixture.ts";
import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();

test.each(["hotspot", "hybrid"] as const)(
	"r6 a late third %s terminal cannot revive restoration cancelled by station",
	async (mode) => {
		f.confirmsActivation = false;
		await f.startRestore(mode);
		for (let attempt = 0; attempt < 2; attempt++) {
			await settlePending(f.row().ifname, false);
			f.list(["wlan0:wifi:disconnected:"]);
			await f.advance();
		}
		expect(f.attempts).toHaveLength(3);
		markBootDegraded("unrelated");
		f.persistMode(MAC, "station");
		await notifyWifiAdapterModeEdge();
		expect(getBootReadiness().degradedSubsystems).toEqual(["unrelated"]);
		await settlePending(f.row().ifname, false);
		expect(getBootReadiness().degradedSubsystems).toEqual(["unrelated"]);
		await f.advance(300_000);
		expect(f.attempts).toHaveLength(3);
	},
);
