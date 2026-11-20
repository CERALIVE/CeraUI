import { expect, test } from "bun:test";
import {
	getBootReadiness,
	markBootDegraded,
} from "../modules/system/readiness.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	observedWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode.ts";
import {
	notifyWifiAdapterModeDiscovery,
	notifyWifiAdapterModeEdge,
} from "../modules/wifi/wifi-adapter-mode-events.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { MAC, PORT, PROFILE } from "./helpers/wifi-autoconnect-fixture.ts";

import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();
const { row, startRestore, lose, advance, attempts, lockResults } = f;
const DEGRADED = `wifi-hotspot-restore:${MAC}`;

test.each(["hotspot", "hybrid"] as const)(
	"NM loss restores saved %s through the locked normal start path",
	async (mode) => {
		await startRestore(mode);
		lose(mode === "hybrid" ? "clap-wlan0" : "wlan0");
		await notifyWifiAdapterModeEdge();

		expect(observedWifiAdapterMode(row())).toBe(mode);
		expect(attempts).toEqual(["wlan0", "wlan0"]);
		expect(lockResults).toEqual([false, false]);
		if (mode === "hybrid") expect(row().conn).toBe("station-link");
	},
);

test("discovery of a missing AP rearms a completed restore", async () => {
	await startRestore();
	f.list(["wlan0:wifi:disconnected:"]);
	await f.discover();
	await notifyWifiAdapterModeEdge();

	expect(observedWifiAdapterMode(row())).toBe("hotspot");
	expect(attempts).toEqual(["wlan0", "wlan0"]);
});

test("explicit Stop followed by loss keeps station intent and never restores", async () => {
	await startRestore();
	expect(
		await wifiHotspotStop(
			{ device: row().id },
			{
				...defaultHotspotStopDeps,
				nmDisconnect: async () => true,
				broadcastState: () => undefined,
				setDupIpSuppression: () => undefined,
				releaseConcurrentInterface: async () => undefined,
				rescan: async () => undefined,
				publishOutcome: () => undefined,
			},
		),
	).toEqual({ success: true });
	lose();
	await notifyWifiAdapterModeEdge();
	await advance(30_000);

	expect(getPersistedWifiAdapterMode(MAC)).toBe("station");
	expect(observedWifiAdapterMode(row())).toBe("station");
	expect(attempts).toEqual(["wlan0"]);
});

test("failed recovery is bounded and later observed success clears only its degradation", async () => {
	await startRestore();
	markBootDegraded("unrelated");
	f.acceptsActivation = false;
	lose();
	await notifyWifiAdapterModeEdge();
	await advance();
	await advance();
	await advance(30_000);

	expect(attempts).toEqual(["wlan0", "wlan0", "wlan0", "wlan0"]);
	expect(getBootReadiness().degradedSubsystems).toEqual([
		"unrelated",
		DEGRADED,
	]);
	f.acceptsActivation = true;
	row().conn = PROFILE;
	row().activeConn = PROFILE;
	row().activeMode = "ap";
	await notifyWifiAdapterModeDiscovery();
	expect(getBootReadiness().degradedSubsystems).toEqual(["unrelated"]);
	lose();
	await notifyWifiAdapterModeEdge();
	expect(observedWifiAdapterMode(row())).toBe("hotspot");
});

test("accepted recovery without NM confirmation also exhausts three attempts", async () => {
	await startRestore();
	f.confirmsActivation = false;
	lose();
	await notifyWifiAdapterModeEdge();
	for (let attempt = 0; attempt < 3; attempt++) {
		settlePending(row().ifname, false);
		f.list(["wlan0:wifi:disconnected:"]);
		await advance();
	}

	expect(attempts).toEqual(["wlan0", "wlan0", "wlan0", "wlan0"]);
	expect(getBootReadiness().degradedSubsystems).toEqual([DEGRADED]);
});

test("reprobe of the same permanent MAC restores on the new incarnation and ifname", async () => {
	await startRestore();
	const old = wifiRadioIdentity.state.rows.get("wlan0")?.incarnation;
	handleWifiMonitorEvent({
		type: "device-state",
		device: "wlan0",
		state: "unavailable",
	});
	f.witnesses.delete("wlan0");
	f.witnesses.set("wlan1", {
		ifindex: 9,
		phy: "/sys/devices/policy/reprobed/phy0",
		mac: MAC,
		path: PORT,
	});
	f.list(["wlan1:wifi:disconnected:"]);
	await f.discover();
	await notifyWifiAdapterModeEdge();

	expect(wifiRadioIdentity.state.rows.get("wlan1")?.incarnation).not.toBe(old);
	expect(attempts).toEqual(["wlan0", "wlan1"]);
	expect(row().ifname).toBe("wlan1");
	expect(observedWifiAdapterMode(row())).toBe("hotspot");
});

test("loss during a pending operation waits for it to settle before restoring", async () => {
	await startRestore();
	row().hotspot.transition = "activating";
	lose();
	await notifyWifiAdapterModeEdge();
	await advance();
	expect(attempts).toEqual(["wlan0"]);
	expect(getBootReadiness().degraded).toBe(false);

	delete row().hotspot.transition;
	await advance();
	expect(attempts).toEqual(["wlan0", "wlan0"]);
	expect(observedWifiAdapterMode(row())).toBe("hotspot");
});

test("a new incarnation gets its own recovery budget after the old one exhausted", async () => {
	await startRestore();
	f.acceptsActivation = false;
	lose();
	await notifyWifiAdapterModeEdge();
	await advance();
	await advance();
	f.acceptsActivation = true;
	f.witnesses.set("wlan0", {
		ifindex: 9,
		phy: "/sys/devices/policy/reprobed/phy0",
		mac: MAC,
		path: PORT,
	});
	await f.discover();
	await notifyWifiAdapterModeEdge();

	expect(attempts).toEqual(["wlan0", "wlan0", "wlan0", "wlan0", "wlan0"]);
	expect(observedWifiAdapterMode(row())).toBe("hotspot");
	expect(getBootReadiness().degraded).toBe(false);
});

test("a busy adapter lock retries after release without degrading", async () => {
	await startRestore();
	const release = Promise.withResolvers<void>();
	const held = withWifiAdapterLock(
		wifiAdapterLockKey(MAC),
		() => release.promise,
	);
	try {
		lose();
		await notifyWifiAdapterModeEdge();
		await advance();
		expect(attempts).toEqual(["wlan0"]);
		expect(getBootReadiness().degraded).toBe(false);
	} finally {
		release.resolve();
		await held;
	}
	await advance();
	expect(attempts).toEqual(["wlan0", "wlan0"]);
	expect(observedWifiAdapterMode(row())).toBe("hotspot");
	expect(getBootReadiness().degraded).toBe(false);
});
