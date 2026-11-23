import { afterEach, expect, test } from "bun:test";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	handleWifiMonitorEvent,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import { MAC, PORT, PROFILE } from "./helpers/wifi-autoconnect-fixture.ts";
import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();
afterEach(() => {
	delete f.deps.pollHotspotActive;
});
async function flush(): Promise<void> {
	for (let turn = 0; turn < 256; turn++) await Promise.resolve();
}

test.each(["hotspot", "hybrid"] as const)(
	"r6 an optimistic poll cannot confirm %s without the selected AP up",
	async (mode) => {
		f.confirmsActivation = false;
		const entered = Promise.withResolvers<void>();
		const hint = Promise.withResolvers<boolean>();
		f.deps.pollHotspotActive = () => {
			entered.resolve();
			return hint.promise;
		};
		try {
			await f.startRestore(mode);
			await entered.promise;
			f.list([
				"wlan0:wifi:connected:station-link",
				"clap-wlan0:wifi:disconnected:",
			]);
			hint.resolve(true);
			await flush();
			expect(observedWifiAdapterMode(f.row())).toBe("station");
			expect(f.row().hotspot.transition).toBe("activating");
			f.list(
				mode === "hybrid"
					? [
							"wlan0:wifi:connected:station-link",
							`clap-wlan0:wifi:connected:${PROFILE}`,
						]
					: [`wlan0:wifi:connected:${PROFILE}`],
			);
			await handleWifiMonitorEvent({
				type: "device-state",
				device: mode === "hybrid" ? "clap-wlan0" : "wlan0",
				state: "connected",
			});
			expect(observedWifiAdapterMode(f.row())).toBe(mode);
		} finally {
			hint.resolve(false);
			await settlePending("wlan0", false);
			await flush();
		}
	},
);

test("r6 a parent station event or AP name cannot confirm a disconnected hybrid AP", async () => {
	f.confirmsActivation = false;
	await f.startRestore("hybrid");
	f.list([
		"wlan0:wifi:connected:station-link",
		"clap-wlan0:wifi:disconnected:",
	]);
	await handleWifiMonitorEvent({
		type: "device-state",
		device: "wlan0",
		state: "connected",
	});
	expect(observedWifiAdapterMode(f.row())).toBe("station");
	expect(f.row().hotspot.transition).toBe("activating");
	await handleWifiMonitorEvent({
		type: "connection-state",
		connection: f.row().hotspot.name ?? "",
		state: "activated",
	});
	expect(observedWifiAdapterMode(f.row())).toBe("station");
	f.list([
		"wlan0:wifi:connected:station-link",
		`clap-wlan0:wifi:connected:${PROFILE}`,
	]);
	await handleWifiMonitorEvent({
		type: "device-state",
		device: "clap-wlan0",
		state: "connected",
	});
	expect(observedWifiAdapterMode(f.row())).toBe("hybrid");
	expect(f.row().conn).toBe("station-link");
});

test.each(["hotspot", "hybrid"] as const)(
	"r6 a held poll from the first %s attempt cannot confirm its replacement UUID",
	async (mode) => {
		f.confirmsActivation = false;
		const oldEntered = Promise.withResolvers<void>();
		const newEntered = Promise.withResolvers<void>();
		const oldPoll = Promise.withResolvers<boolean>();
		const newPoll = Promise.withResolvers<boolean>();
		let polls = 0;
		f.deps.pollHotspotActive = () => {
			if (++polls === 1) {
				oldEntered.resolve();
				return oldPoll.promise;
			}
			newEntered.resolve();
			return newPoll.promise;
		};
		try {
			await f.startRestore(mode);
			await oldEntered.promise;
			await settlePending("wlan0", false);
			const profile = f.profiles.get(PROFILE);
			if (!profile) throw new Error("Missing first profile");
			f.profiles.set("replacement-ap", { ...profile });
			rememberHotspotCredentials(MAC, {
				ssid: "Policy AP",
				password: "fixture-password",
				conn: "replacement-ap",
			});
			f.row().hotspot.conn = "replacement-ap";
			f.list(["wlan0:wifi:disconnected:"]);
			await f.advance();
			await newEntered.promise;
			f.list(["wlan0:wifi:disconnected:", "clap-wlan0:wifi:disconnected:"]);
			oldPoll.resolve(true);
			await flush();
			expect(f.attempts).toHaveLength(2);
			expect(observedWifiAdapterMode(f.row())).toBe("station");
			expect(f.row().hotspot.transition).toBe("activating");
			f.list(
				mode === "hybrid"
					? [
							"wlan0:wifi:connected:station-link",
							"clap-wlan0:wifi:connected:replacement-ap",
						]
					: ["wlan0:wifi:connected:replacement-ap"],
			);
			newPoll.resolve(true);
			await flush();
			expect(observedWifiAdapterMode(f.row())).toBe(mode);
			expect(f.row().hotspot.conn).toBe("replacement-ap");
		} finally {
			oldPoll.resolve(false);
			newPoll.resolve(false);
			await settlePending("wlan0", false);
			await flush();
		}
	},
);

test.each(["hotspot", "hybrid"] as const)(
	"r6 a poll captured before physical replacement cannot confirm %s",
	async (mode) => {
		f.confirmsActivation = false;
		const entered = Promise.withResolvers<void>();
		const proof = Promise.withResolvers<boolean>();
		f.deps.pollHotspotActive = () => {
			entered.resolve();
			return proof.promise;
		};
		try {
			await f.startRestore(mode);
			await entered.promise;
			f.witnesses.set("wlan0", {
				ifindex: 9,
				phy: "/sys/devices/policy/reprobed/phy0",
				mac: MAC,
				path: PORT,
			});
			await f.sample();
			proof.resolve(true);
			await flush();
			expect(observedWifiAdapterMode(f.row())).toBe("station");
		} finally {
			proof.resolve(false);
			await settlePending("wlan0", false);
			await flush();
		}
	},
);
