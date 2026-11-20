import { expect, spyOn, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getWifiState,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	handleWifiMonitorEvent,
	registerPendingConfirmation,
	settlePending,
	syncWifiStateCache,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import * as profileOperations from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { bindingForRow } from "../modules/wifi/wifi-operation-binding.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { request } from "./helpers/wifi-entry-fixture.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";
import { mockQualifiedHybridActivation } from "./helpers/wifi-hotspot-test-setup.ts";

const secondMac = "dc:a6:32:aa:bb:c1";

async function startFixture(active = false) {
	const fixture = await wifiFrameFixture(active);
	const priorCache = getWifiState();
	spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue(undefined);
	spyOn(defaultHotspotDeps, "readProfileInstance").mockResolvedValue(null);
	spyOn(defaultHotspotDeps, "wifiUpdateSavedConns").mockResolvedValue();
	spyOn(defaultHotspotDeps, "pruneHotspotConns").mockResolvedValue();
	spyOn(defaultHotspotDeps, "setDupIpSuppression").mockImplementation(() => {});
	spyOn(defaultHotspotDeps, "broadcastState").mockImplementation(() => {});
	const intent = defaultHotspotDeps.recordIntent;
	if (!intent)
		throw new Error("Start fixture requires the production intent recorder");
	spyOn(intent, "persist").mockImplementation(() => {});
	spyOn(defaultHotspotDeps.credentials, "get").mockReturnValue(undefined);
	spyOn(defaultHotspotDeps.credentials, "remember").mockImplementation(
		() => {},
	);
	const up = spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	return {
		...fixture,
		up,
		restore: async () => {
			setWifiState(priorCache);
			await fixture.restore();
		},
	};
}

test.each(["ifindex", "macaddress"] as const)(
	"Start refuses a changed %s after pinning and dispatches no Up",
	async (changed) => {
		const fixture = await startFixture();
		const pin = spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(
			async () => {
				spyOn(radioIdentityReaders, "readText").mockImplementation(
					async (path) =>
						path.endsWith("/ifindex")
							? changed === "ifindex"
								? "20"
								: "10"
							: path.endsWith("/index")
								? "1"
								: changed === "macaddress"
									? secondMac
									: "dc:a6:32:aa:bb:c0",
				);
				return true;
			},
		);
		try {
			const result = await request("start", fixture.context, fixture.before);
			expect(pin).toHaveBeenCalledTimes(1);
			expect(fixture.up).not.toHaveBeenCalled();
			expect(result).toEqual({ success: false, error: "radio-changed" });
			expect(JSON.parse(fixture.frames.at(-1) ?? "{}")).toEqual({
				wifi: { hotspot: { start: { device: 0, error: "radio-changed" } } },
			});
		} finally {
			await fixture.restore();
		}
	},
);

test.each(["stopped", "failed", "new-active-path", "new-profile"] as const)(
	"existing Start reconciles a change during successful Up: %s",
	async (scenario) => {
		const fixture = await startFixture();
		const instance = {
			path: "/org/freedesktop/NetworkManager/Settings/1",
			fingerprint: "test-ap",
			runId: "test",
			file: { filename: "test", device: "1", inode: "2", ctime: "3" },
		};
		const activePath = "/org/freedesktop/NetworkManager/ActiveConnection/6";
		let upUuid: string | undefined;
		spyOn(profileOperations, "runHotspotProfileOperation").mockImplementation(
			async (operation) => ({
				checked: true,
				success: Boolean(
					await (operation.kind === "modify"
						? operation.run(operation.fields)
						: operation.run()),
				),
				instance,
			}),
		);
		spyOn(defaultHotspotDeps, "readProfileInstance").mockImplementation(
			async () =>
				upUuid && scenario === "new-profile"
					? { ...instance, path: `${instance.path}0` }
					: instance,
		);
		spyOn(nm, "nmDeviceProp").mockImplementation(async () => [
			"100",
			upUuid ?? "",
			scenario === "new-active-path" ? `${activePath}0` : activePath,
		]);
		spyOn(defaultHotspotDeps, "nmConnSetFields").mockResolvedValue(true);
		spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(
			async (uuid, _, activated) => {
				upUuid = uuid;
				activated?.(activePath);
				await fixture.rotate();
				return true;
			},
		);
		const down = spyOn(defaultHotspotDeps, "nmDisconnect").mockResolvedValue(
			scenario === "stopped",
		);
		try {
			const result = await request("start", fixture.context, fixture.before);
			expect(upUuid).toBeDefined();
			if (!upUuid) throw new Error("Expected Up for the saved fixture profile");
			expect(result).toEqual({
				success: false,
				error: "radio-changed",
				...(scenario === "stopped" ? {} : { reason: "deactivation-failed" }),
			});
			expect(down.mock.calls).toEqual(
				scenario === "failed" || scenario === "stopped" ? [[upUuid]] : [],
			);
		} finally {
			await fixture.restore();
		}
	},
);

test("hybrid Start refuses a replacement AP leg on the same phy", async () => {
	const fixture = await startFixture();
	mockQualifiedHybridActivation();
	delete fixture.row.activeMode;
	fixture.row.supportsApStaConcurrency = true;
	const intent = defaultHotspotDeps.recordIntent;
	if (!intent) throw new Error("Missing fixture intent recorder");
	const restoreIntent = spyOn(intent, "restore").mockImplementation(() => {});
	const previousModes = getConfig().wifi_modes;
	getConfig().wifi_modes = { "dc:a6:32:aa:bb:c0": "hybrid" };
	const target = { ifname: "clap-wlan0", created: false };
	spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockResolvedValue(
		target,
	);
	const release = spyOn(
		defaultHotspotDeps,
		"releaseConcurrentInterface",
	).mockResolvedValue();
	let legIndex = "21";
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (path.endsWith("/ifindex"))
			return path.includes(target.ifname) ? legIndex : "10";
		if (path.endsWith("/index")) return "1";
		return "dc:a6:32:aa:bb:c0";
	});
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(
		"/sys/devices/equivalence/phy1",
	);
	const capability: NonNullable<
		ReturnType<typeof capabilities.getWifiCapabilitiesForInterface>
	> = {
		phy: "phy1",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "unknown",
		regulatory: { country: "ES", is6GhzLegal: false, self_managed: false },
	};
	spyOn(capabilities, "getWifiCapabilitiesForInterface").mockReturnValue(
		capability,
	);
	spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue(capability);
	spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(async () => {
		legIndex = "22";
		return true;
	});
	try {
		expect(await request("start", fixture.context, fixture.before)).toEqual({
			success: false,
			error: "radio-changed",
		});
		expect(fixture.up).not.toHaveBeenCalled();
		expect<unknown>(release.mock.calls).toEqual([[target.ifname, target]]);
	} finally {
		if (previousModes === undefined) delete getConfig().wifi_modes;
		else getConfig().wifi_modes = previousModes;
		restoreIntent.mockRestore();
		await fixture.restore();
	}
});

test("Start refuses before pinning if the radio changes during saved-profile refresh", async () => {
	const fixture = await startFixture();
	const pin = spyOn(defaultHotspotDeps, "nmConnSetFields").mockResolvedValue(
		true,
	);
	spyOn(defaultHotspotDeps, "wifiUpdateSavedConns").mockImplementation(
		async () => {
			await fixture.rotate();
		},
	);
	try {
		expect(await request("start", fixture.context, fixture.before)).toEqual({
			success: false,
			error: "radio-changed",
		});
		expect(pin).not.toHaveBeenCalled();
		expect(fixture.up).not.toHaveBeenCalled();
	} finally {
		await fixture.restore();
	}
});

test("a rejected Start preserves a different adapter's new hybrid projection", async () => {
	const fixture = await startFixture();
	const second = {
		...structuredClone(fixture.row),
		id: 1,
		ifname: "wlan1",
		conn: "station-b",
		activeConn: "station-b",
		hotspot: { ...fixture.row.hotspot, conn: "ap-b" },
		concurrentHotspot: { ifname: "clap-wlan1", activeConn: "ap-b" },
	};
	addWifiInterface(secondMac, second);
	spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(async () => {
		syncWifiStateCache(secondMac, second);
		return false;
	});
	try {
		expect(await request("start", fixture.context, fixture.before)).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(getWifiState()[secondMac]).toMatchObject({
			concurrentHotspot: { activeConn: "ap-b" },
		});
		expect(observedWifiAdapterMode(second)).toBe("hybrid");
		expect(second.conn).toBe("station-b");
		expect(second.concurrentHotspot.activeConn).toBe("ap-b");
	} finally {
		await fixture.restore();
	}
});

test.each([true, false])(
	"confirmation of the original active instance refuses after a radio replacement (Down=%s)",
	async (deactivated) => {
		const fixture = await startFixture();
		const key = "dc:a6:32:aa:bb:c0";
		const instance = {
			path: "/org/freedesktop/NetworkManager/Settings/1",
			fingerprint: "test-ap",
			runId: "test",
			file: { filename: "test", device: "1", inode: "2", ctime: "3" },
		};
		const activePath = "/org/freedesktop/NetworkManager/ActiveConnection/6";
		spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:connected:test-ap"]);
		spyOn(nm, "nmDeviceProp").mockResolvedValue(["100", "test-ap", activePath]);
		spyOn(defaultHotspotDeps, "readProfileInstance").mockResolvedValue(
			instance,
		);
		const publish = spyOn(
			defaultHotspotDeps,
			"publishOutcome",
		).mockImplementation(() => {});
		const down = spyOn(defaultHotspotDeps, "nmDisconnect").mockResolvedValue(
			deactivated,
		);
		fixture.row.hotspot.transition = "activating";
		registerPendingConfirmation(
			{
				macAddress: key,
				uuid: "test-ap",
				ifname: "wlan0",
				activation: { profile: instance, activePath },
				binding: bindingForRow(key, fixture.row),
			},
			fixture.row,
			{ ...defaultHotspotDeps, pollHotspotActive: undefined },
		);
		const reading = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			if (path.endsWith("/ifindex")) {
				reading.resolve();
				await release.promise;
				return "20";
			}
			return path.endsWith("/index") ? "1" : key;
		});
		try {
			const confirmation = handleWifiMonitorEvent({
				type: "device-state",
				device: "wlan0",
				state: "connected",
			});
			await Promise.race([reading.promise, confirmation]);
			release.resolve();
			await confirmation;
			expect(down.mock.calls).toEqual([["test-ap"]]);
			expect(publish.mock.calls).toEqual([
				[
					"start",
					0,
					{
						success: false,
						error: "radio-changed",
						...(!deactivated ? { reason: "deactivation-failed" } : {}),
					},
				],
			]);
			expect(fixture.row.hotspot.transition).toBeUndefined();
		} finally {
			release.resolve();
			settlePending("wlan0", false);
			await fixture.restore();
		}
	},
);
