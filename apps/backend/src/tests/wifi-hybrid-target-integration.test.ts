import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as exec from "../helpers/exec.ts";
import * as runner from "../helpers/run.ts";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as nmSecrets from "../modules/network/network-manager-secret.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import * as wifi from "../modules/wifi/wifi.ts";
import { wifiAdapterModeCapability } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { setApStaCapabilityRunnerForTest } from "../modules/wifi/wifi-ap-sta-capability.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import * as connections from "../modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../modules/wifi/wifi-device-list.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { isHotspotActive } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	resetWifiConnectionModeCache,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import { firstApInstances } from "./helpers/wifi-first-ap-instances.ts";
import {
	decodeProfile,
	encodeProfile,
} from "./helpers/wifi-first-ap-keyfile-codec.ts";
import { hybridFixture, MAC } from "./helpers/wifi-hybrid-start.ts";

function discoveryFixture(
	f: Awaited<ReturnType<typeof hybridFixture>>,
	legacy = false,
	unqualified = true,
	virtualName = "clap-wlan0",
) {
	wifiDeviceListStartUpdate();
	wifiDeviceListAdd("wlan0", MAC, "192.168.1.50");
	if (legacy) wifiDeviceListAdd(virtualName, "de:56:7b:fb:b6:cb");
	wifiDeviceListEndUpdate();
	resetWifiConnectionModeCache();
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station-uuid",
		...(legacy ? [`${virtualName}:wifi:connected:test-ap`] : []),
	]);
	spyOn(exec, "execFileP").mockImplementation(async (bin, argv = []) => {
		if (
			bin !== "nmcli" ||
			!argv.includes("connection") ||
			!argv.includes("show")
		)
			throw new Error("Unexpected discovery fixture command");
		const uuid = argv.at(-1);
		const values = nmcliFieldOutput(argv, (field) => {
			if (field === "802-11-wireless.mode")
				return uuid === "test-ap" ? "ap" : "infrastructure";
			if (field === "connection.autoconnect-priority") return "999";
			if (field === "802-11-wireless.ssid") return "Legacy AP";
			if (field === "802-11-wireless-security.psk") return "legacy-password";
			if (field === "802-11-wireless.band") return "bg";
			if (field === "802-11-wireless.channel") return "1";
			if (field === "connection.interface-name") return virtualName;
			if (field === "802-11-wireless-security.key-mgmt") return "wpa-psk";
			if (field === "802-11-wireless-security.proto") return "rsn";
			if (field === "802-11-wireless-security.pmf") return "1";
			if (field.endsWith(".pairwise") || field.endsWith(".group"))
				return "ccmp";
			if (field === "802-11-wireless.hidden") return "no";
			return "";
		});
		return { stdout: values, stderr: "" };
	});
	spyOn(nmSecrets, "readVerifiedNmWifiSecret").mockImplementation(
		async (uuid) => (uuid === "test-ap" ? "legacy-password" : undefined),
	);
	spyOn(wifi, "wifiUpdateSavedConns").mockResolvedValue(undefined);
	spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(true);
	spyOn(connections, "wifiScheduleScanRefresh").mockImplementation(
		() => undefined,
	);
	spyOn(capabilities, "refreshWifiCapabilities").mockResolvedValue(undefined);
	setApStaCapabilityRunnerForTest(async (_bin, args) =>
		args[0] === "dev"
			? "wiphy 0"
			: "valid interface combinations:\n * #{ managed, P2P-client } <= 2, #{ AP } <= 1, #{ P2P-device } <= 1, total <= 3, #channels <= 1",
	);
	if (legacy) {
		if (unqualified) f.target.driver("rtw89_8852be");
		f.target.active("test-ap");
		f.target.state("100 (connected)");
		const leg = f.target.objects.get(virtualName);
		if (leg) leg.type = "AP";
		delete f.row.hotspot.conn;
		delete f.row.hotspot.name;
		delete f.row.hotspot.password;
	}
}

for (const first of [false, true]) {
	test(`SCC pins the actual station channel before up, first=${first}`, async () => {
		const f = await hybridFixture(first);
		try {
			expect(await f.start()).toEqual({ success: true });
			expect(f.fields).toMatchObject({
				"connection.interface-name": "clap-wlan0",
				"802-11-wireless.band": "bg",
				"802-11-wireless.channel": "1",
			});
			expect(f.row.hotspot.channel).toBe("ch_11");
			expect(f.saved().channel).toBe("ch_11");
			expect(f.row.conn).toBe("station-uuid");
			expect(
				f.target.calls.some(
					(args) => args.includes("add") || args.at(-1) === "del",
				),
			).toBe(false);
		} finally {
			await f.restore();
		}
	});
}

for (const condition of [
	"dfs",
	"no-ir",
	"missing-rules",
	"unqualified-band",
] as const) {
	test(`hybrid refuses ${condition} with the channel reason before profile mutation`, async () => {
		const f = await hybridFixture();
		if (condition === "dfs")
			f.target.frequency(5640, "(no IR, radar detection)");
		if (condition === "no-ir") f.target.frequency(2412, "(no IR)");
		if (condition === "missing-rules") f.target.reg("");
		if (condition === "unqualified-band") {
			f.target.frequency(5180);
			f.target.reg(
				"global\ncountry US: DFS-FCC\n (5170 - 5250 @ 80), (N/A, 20), (N/A)",
			);
		}
		try {
			expect(await f.start()).toEqual({
				success: false,
				error: "activation-failed",
				reason: "hybrid-channel-not-permitted",
			});
			expect(f.effects).toEqual([]);
			expect(f.row.conn).toBe("station-uuid");
			expect(
				f.target.calls.some(
					(args) => args.includes("set") && args.includes("reg"),
				),
			).toBe(false);
		} finally {
			await f.restore();
		}
	});
}

test("a station roam during profile normalization refuses the stale SCC activation", async () => {
	const f = await hybridFixture();
	f.changeBeforeUp(() => f.target.frequency(5640, "(no IR, radar detection)"));
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
			reason: "hybrid-channel-not-permitted",
		});
		expect(f.effects.includes("up")).toBe(false);
		expect(f.row.conn).toBe("station-uuid");
	} finally {
		await f.restore();
	}
});

test("a borrowed leg replaced between selection and up is refused without deletion", async () => {
	const f = await hybridFixture();
	f.changeBeforeUp(() => {
		const leg = f.target.objects.get("clap-wlan0");
		if (leg) {
			leg.ifindex = 99;
			leg.wdev = "0x99";
		}
	});
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
			reason: "hybrid-channel-not-permitted",
		});
		expect(f.effects.includes("up")).toBe(false);
		expect(f.target.objects.get("clap-wlan0")?.ifindex).toBe(99);
		expect(f.target.calls.filter((args) => args.at(-1) === "del")).toEqual([]);
		expect(f.row.conn).toBe("station-uuid");
	} finally {
		await f.restore();
	}
});

test("station info must belong to the sampled parent ifindex before any hybrid mutation", async () => {
	const f = await hybridFixture();
	f.target.reportParentIndex(99);
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
			reason: "hybrid-channel-not-permitted",
		});
		expect(f.effects).toEqual([]);
		expect(f.target.autoconnect()).toBe("yes");
	} finally {
		await f.restore();
	}
});

test("card qualification selects different offerings on the same host", async () => {
	const f = await hybridFixture();
	try {
		const capabilities = () => ({ staApCombo: { supported: true } });
		const otherCard = { ...f.row, id: 1, ifname: "wlan1" };
		connections.addWifiInterface("dc:a6:32:aa:bb:c1", otherCard);
		spyOn(fs, "realpathSync")
			.mockReturnValueOnce("/sys/bus/pci/drivers/mt7925e")
			.mockReturnValueOnce("/sys/bus/pci/drivers/rtw89_8852be");
		expect(
			wifiAdapterModeCapability(f.row, capabilities).staApComboSupported,
		).toBe(true);
		expect(
			wifiAdapterModeCapability(otherCard, capabilities).staApComboSupported,
		).toBeUndefined();
	} finally {
		await f.restore();
	}
});

for (const first of [false, true]) {
	test(`hybrid preserves the chosen WPA3 security fields, first=${first}`, async () => {
		const f = await hybridFixture(first);
		f.row.hotspot.security = "wpa3-sae";
		try {
			expect(await f.start()).toEqual({ success: true });
			expect(f.fields).toMatchObject({
				"802-11-wireless-security.key-mgmt": "sae",
				"802-11-wireless-security.pmf": "required",
			});
		} finally {
			await f.restore();
		}
	});
}

test("Stop retains the selected leg and the next hybrid Start reuses its exact object", async () => {
	const f = await hybridFixture();
	try {
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		const leg = f.target.objects.get("clap-wlan0");
		expect(await f.stop()).toEqual({ success: true });
		expect(f.target.autoconnect()).toBe("yes");
		expect(await f.start()).toEqual({ success: true });
		expect(f.target.objects.get("clap-wlan0")).toBe(leg);
		expect(
			f.target.calls.filter(
				(args) => args.includes("add") || args.at(-1) === "del",
			),
		).toEqual([]);
		expect(f.row.conn).toBe("station-uuid");
	} finally {
		await f.restore();
	}
});

test("hotspot-only Start restores the saved channel after hybrid Stop", async () => {
	const f = await hybridFixture();
	try {
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		expect(await f.stop()).toEqual({ success: true });
		expect(await f.startExclusive()).toEqual({ success: true });
		expect(f.fields["802-11-wireless.channel"]).toBe("11");
		expect(f.saved().channel).toBe("ch_11");
	} finally {
		await f.restore();
	}
});

for (const outcome of ["configured", "rollback", "illegal-rollback"] as const) {
	test(`active hybrid configuration derives SCC through ${outcome}`, async () => {
		const f = await hybridFixture();
		try {
			expect(await f.start()).toEqual({ success: true });
			settlePending("wlan0", true);
			f.effects.length = 0;
			const previousSsid = f.row.hotspot.name;
			const write = spyOn(f.activationDeps, "nmConnSetFields");
			if (outcome === "rollback") f.failNextUp();
			if (outcome === "illegal-rollback")
				f.failNextUp(() =>
					f.target.frequency(5640, "(no IR, radar detection)"),
				);
			await f.configure();
			expect(f.fields["802-11-wireless.channel"]).toBe("1");
			expect(
				write.mock.calls.map(([uuid, fields]) => [
					uuid,
					fields["802-11-wireless.channel"],
				]),
			).toContainEqual(["test-ap", "1"]);
			expect(
				write.mock.calls.map(([uuid, fields]) => [
					uuid,
					fields["802-11-wireless.ssid"],
					fields["802-11-wireless.channel"],
				]),
			).toEqual(
				outcome === "configured"
					? [["test-ap", "Configured AP", "1"]]
					: [
							["test-ap", "Configured AP", "1"],
							["test-ap", previousSsid, "1"],
						],
			);
			expect(f.effects.filter((effect) => effect === "up")).toHaveLength(
				outcome === "rollback" ? 2 : 1,
			);
			expect(f.saved().channel).toBe("ch_11");
			expect(f.row.conn).toBe("station-uuid");
			if (outcome === "illegal-rollback") {
				expect(f.frames.at(-1)).toContain(
					'"reason":"hybrid-channel-not-permitted"',
				);
				expect(f.effects).toContain("down:test-ap");
				expect(isHotspotActive(f.row)).toBe(false);
			}
		} finally {
			await f.restore();
		}
	});
}

test("an unchanged saved channel outside the current offering never refuses hybrid Save", async () => {
	const f = await hybridFixture();
	try {
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		f.row.hotspot.availableChannels = ["auto", "ch_1"];
		f.row.hotspot.derivedChannels = [{ channel: 1, freqMhz: 2412, band: "bg" }];
		// Only the selected parent participates in this Save's identity observation.
		await f.target.observeParent();
		const write = spyOn(f.activationDeps, "nmConnSetFields");
		await f.configure();
		expect(f.frames.at(-1)).toContain('"success":true');
		expect(f.saved().ssid).toBe("Configured AP");
		expect(f.saved().channel).toBe("ch_11");
		expect(f.fields["802-11-wireless.channel"]).toBe("1");
		expect(
			write.mock.calls.map(([uuid, fields]) => [
				uuid,
				fields["802-11-wireless.channel"],
			]),
		).toContainEqual(["test-ap", "1"]);
	} finally {
		await f.restore();
	}
});

test("an illegal station roam stops only the observed AP and preserves the borrowed netdev", async () => {
	const f = await hybridFixture();
	try {
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		f.effects.length = 0;
		discoveryFixture(f, true, false);
		f.target.frequency(5640, "(no IR, radar detection)");
		await f.observeRoam();
		expect(f.effects.filter((effect) => effect.startsWith("down:"))).toEqual([
			"down:test-ap",
		]);
		expect([...f.target.objects.keys()]).toEqual([
			"wlan0",
			"clap-wlan0",
			"clap-sentinel",
		]);
		expect(f.row.conn).toBe("station-uuid");
		expect(
			f.frames.some((frame) =>
				frame.includes('"reason":"hybrid-channel-not-permitted"'),
			),
		).toBe(true);
	} finally {
		await f.restore();
	}
});

test("discovery advertises driver capability without creating a missing leg", async () => {
	const f = await hybridFixture();
	discoveryFixture(f);
	f.target.objects.delete("clap-wlan0");
	connections.removeWifiInterface(MAC);
	try {
		await wifiUpdateDevices();
		expect(wifi.wifiBuildMsg()["0"]?.supports_hotspot).toBe(true);
		expect(f.target.objects.has("clap-wlan0")).toBe(false);
		expect(f.target.calls.some((args) => args.includes("add"))).toBe(false);
		expect(
			Object.values(connections.getWifiInterfacesByMacAddress()).map(
				(row) => row.ifname,
			),
		).toEqual(["wlan0"]);
	} finally {
		await f.restore();
	}
});

for (const mode of [undefined, "station", "hybrid"] as const) {
	test(`startup uses the qualified leg only for saved hybrid intent, saved=${mode}`, async () => {
		const f = await hybridFixture();
		if (mode !== "hybrid") f.target.objects.delete("clap-wlan0");
		try {
			await f.restoreFromIntent(mode);
			expect(f.target.objects.has("clap-wlan0")).toBe(mode === "hybrid");
			expect(f.effects.filter((effect) => effect === "up")).toHaveLength(
				mode === "hybrid" ? 1 : 0,
			);
			expect(f.saved().channel).toBe("ch_11");
			if (mode === "hybrid") {
				expect(f.fields).toMatchObject({
					"connection.interface-name": "clap-wlan0",
					"802-11-wireless.channel": "1",
					"connection.autoconnect": "no",
				});
			}
		} finally {
			await f.restore();
		}
	});
}

test("startup leaves unqualified hybrid intent pending without exclusive fallback", async () => {
	const f = await hybridFixture();
	f.target.driver("rtw89_8852be");
	f.target.objects.delete("clap-wlan0");
	try {
		await f.restoreFromIntent("hybrid");
		expect(f.effects).toEqual([]);
		expect(f.target.objects.has("clap-wlan0")).toBe(false);
	} finally {
		await f.restore();
	}
});

for (const secondCard of [false, true]) {
	test(`limited boot restore retains the sole-owner exception, second card=${secondCard}`, async () => {
		const f = await hybridFixture();
		if (secondCard) f.target.objects.delete("clap-wlan0");
		f.target.permanent("00:00:00:00:00:00");
		f.row.degradedReason = "permanent-mac-unresolved";
		connections.removeWifiInterface(MAC);
		connections.addWifiInterface("limited:4:0", f.row);
		await f.target.observeParent();
		rememberHotspotCredentials(MAC, {
			ssid: "Original AP",
			password: "original-password",
			channel: "ch_11",
			conn: "test-ap",
		});
		if (secondCard)
			connections.addWifiInterface("limited:5:1", {
				...f.row,
				id: 1,
				ifname: "wlan1",
			});
		// Owned writes now verify the predicted keyfile bytes, including on limited restore.
		const profile: Record<string, string> = {
			"connection.interface-name": "clap-wlan0",
			"connection.autoconnect": "yes",
			"802-11-wireless.mode": "ap",
			"802-11-wireless.band": "bg",
			"802-11-wireless.channel": "1",
		};
		const resources = firstApInstances(
			new Set(["test-ap"]),
			new Map([["test-ap", profile]]),
		);
		resources.add("test-ap");
		const observation = {
			active: undefined,
			pending: false,
			mode: "ap",
			ifname: "clap-wlan0",
		};
		const inventory = spyOn(nm, "nmConnsGet").getMockImplementation();
		if (!inventory) throw new Error("Missing hybrid profile inventory");
		spyOn(nm, "nmConnsGet").mockImplementation(async (fields) =>
			fields === "uuid,dbus-path" || fields === "uuid,filename"
				? resources.read(["--fields", fields], observation).split("\n")
				: inventory(fields),
		);
		spyOn(runner, "run").mockImplementation(async (binary, args = []) => {
			if (binary === "busctl") return resources.busReply(args);
			if (binary !== "nmcli" || !nmcliFieldNames(args).length)
				throw new Error("Unexpected hybrid profile read");
			return resources.read([...args], observation);
		});
		spyOn(runner, "runWithStdin").mockImplementation(
			async (binary, args, input) => {
				if (
					binary !== "nmcli" ||
					args.slice(0, 3).join(" ") !== "--offline connection modify"
				)
					throw new Error("Unexpected offline operation");
				const fields = decodeProfile(input);
				for (let i = 3; i < args.length; i += 2) {
					const key = args[i];
					const value = args[i + 1];
					if (key === undefined || value === undefined)
						throw new Error("Invalid offline delta");
					fields[key] = value;
				}
				return encodeProfile(fields);
			},
		);
		spyOn(nm, "nmConnSetFields").mockImplementation(async (uuid, fields) => {
			const success = await f.activationDeps.nmConnSetFields(uuid, fields);
			if (success) {
				Object.assign(profile, fields);
				resources.files.write(uuid);
			}
			return success;
		});
		spyOn(nm, "nmConnect").mockImplementation(f.activationDeps.nmConnect);
		spyOn(nm, "nmDisconnect").mockImplementation(f.activationDeps.nmDisconnect);
		try {
			await f.restoreFromIntent("hybrid");
			expect(f.effects.filter((effect) => effect === "up")).toHaveLength(
				secondCard ? 0 : 1,
			);
			expect(f.target.objects.has("clap-wlan0")).toBe(!secondCard);
			expect(getHotspotCredentials(MAC)).toMatchObject({
				ssid: "Original AP",
				password: "original-password",
				channel: "ch_11",
				conn: "test-ap",
			});
			if (!secondCard)
				expect(f.fields).toMatchObject({
					"connection.interface-name": "clap-wlan0",
					"802-11-wireless.band": "bg",
					"802-11-wireless.channel": "1",
				});
		} finally {
			resources.files.close();
			await f.restore();
		}
	});
}

for (const virtualName of ["clap-wlan0", "clap-a1b2c3d4"]) {
	test(`a legacy AP on ${virtualName} stays visible and stoppable on an unqualified card`, async () => {
		const f = await hybridFixture();
		if (virtualName !== "clap-wlan0") {
			const leg = f.target.objects.get("clap-wlan0");
			if (!leg) throw new Error("Missing legacy fixture leg");
			f.target.objects.delete("clap-wlan0");
			f.target.objects.set(virtualName, leg);
			rememberHotspotCredentials(MAC, {
				ssid: "Legacy AP",
				password: "legacy-password",
				conn: "test-ap",
				channel: "ch_11",
			});
		}
		discoveryFixture(f, true, true, virtualName);
		try {
			await wifiUpdateDevices();
			const observed = wifi.wifiBuildMsg()["0"];
			expect(observed?.hotspot?.name).toBe("Legacy AP");
			expect(observed?.hotspot?.password).toBe("legacy-password");
			expect(await f.stop()).toEqual({ success: true });
			expect(f.effects.filter((effect) => effect.startsWith("down:"))).toEqual([
				"down:test-ap",
			]);
			expect([...f.target.objects.keys()].sort()).toEqual(
				["wlan0", virtualName, "clap-sentinel"].sort(),
			);
			expect(f.row.conn).toBe("station-uuid");
		} finally {
			await f.restore();
		}
	});
}

test("a pending foreign AP is neither advertised as active nor stopped by discovery", async () => {
	const f = await hybridFixture();
	discoveryFixture(f, true, false);
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station-uuid",
		"clap-wlan0:wifi:connecting:test-ap",
	]);
	f.target.state("50 (connecting)");
	const leg = f.target.objects.get("clap-wlan0");
	if (leg) leg.type = "managed";
	try {
		await f.observeRoam();
		expect(wifi.wifiBuildMsg()["0"]?.hotspot).toBeUndefined();
		expect(f.effects.filter((effect) => effect.startsWith("down:"))).toEqual(
			[],
		);
		expect(f.target.autoconnect()).toBe("yes");
	} finally {
		await f.restore();
	}
});

test("an unrelated active clap leg is not adopted from its prefix", async () => {
	const f = await hybridFixture();
	const leg = f.target.objects.get("clap-wlan0");
	if (!leg) throw new Error("Missing foreign fixture leg");
	f.target.objects.delete("clap-wlan0");
	f.target.objects.set("clap-a1b2c3d4", leg);
	discoveryFixture(f, true, true, "clap-a1b2c3d4");
	try {
		await wifiUpdateDevices();
		expect(wifi.wifiBuildMsg()["0"]?.hotspot).toBeUndefined();
		expect(f.target.objects.get("clap-a1b2c3d4")).toBe(leg);
		expect(
			f.target.calls.filter(
				(args) => args[0] === "nmcli" || args.at(-1) === "del",
			),
		).toEqual([]);
	} finally {
		await f.restore();
	}
});

test("an unqualified legacy AP refuses Save without losing visibility or Stop authority", async () => {
	const f = await hybridFixture();
	discoveryFixture(f, true);
	try {
		await wifiUpdateDevices();
		await f.configure();
		expect(f.effects.filter((effect) => effect.startsWith("down:"))).toEqual(
			[],
		);
		expect(isHotspotActive(f.row)).toBe(true);
		expect(await f.stop()).toEqual({ success: true });
	} finally {
		await f.restore();
	}
});

test("saved hybrid boot refuses a missing qualified leg with O3 and no mutations", async () => {
	const f = await hybridFixture();
	f.target.objects.delete("clap-wlan0");
	const outcomes: unknown[] = [];
	try {
		await f.restoreFromIntent("hybrid", (_kind, _id, outcome) => {
			outcomes.push(outcome);
		});
		expect(outcomes).toEqual([
			{
				success: false,
				error: "activation-failed",
				reason: "hybrid-channel-not-permitted",
			},
		]);
		expect(f.effects).toEqual([]);
		expect(
			f.target.calls.filter(
				(args) =>
					args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
			),
		).toEqual([]);
		expect(f.saved().channel).toBe("ch_11");
	} finally {
		await f.restore();
	}
});

for (const entry of ["direct", "boot", "limited-boot", "mode"] as const) {
	test(`unqualified saved hybrid ${entry} uses the common channel refusal`, async () => {
		const f = await hybridFixture();
		const modes = getConfig().wifi_modes;
		getConfig().wifi_modes = { [MAC]: "hybrid" };
		f.target.driver("rtw89_8852be");
		if (entry === "limited-boot") {
			f.row.degradedReason = "permanent-mac-unresolved";
			f.target.permanent("00:00:00:00:00:00");
			connections.removeWifiInterface(MAC);
			connections.addWifiInterface("limited:4:0", f.row);
			await f.target.observeParent();
			rememberHotspotCredentials(MAC, {
				ssid: "Original AP",
				password: "original-password",
				channel: "ch_11",
				conn: "test-ap",
			});
			spyOn(nm, "nmConnGetFields").mockResolvedValue([
				"ap",
				"bg",
				"1",
				"clap-wlan0",
			]);
		}
		try {
			if (entry === "direct" || entry === "mode") {
				const result =
					entry === "direct"
						? await f.start()
						: await setWifiAdapterMode(0, "hybrid", {
								...defaultAdapterModeDeps,
								readCapabilities: f.activationDeps.readCapabilities,
							});
				expect(result).toEqual({
					success: false,
					error: "activation-failed",
					reason: "hybrid-channel-not-permitted",
				});
			} else {
				const reasons: (string | undefined)[] = [];
				const publish = defaultAdapterModeDeps.publishHotspotOutcome;
				spyOn(
					defaultAdapterModeDeps,
					"publishHotspotOutcome",
				).mockImplementation((...args) => {
					if (!args[2].success) reasons.push(args[2].reason);
					publish(...args);
				});
				await reconcileWifiAdapterModes(
					{
						...defaultAdapterModeDeps,
						resolveInterfaces: connections.getWifiInterfacesByMacAddress,
						readCapabilities: f.activationDeps.readCapabilities,
					},
					() => ({ [MAC]: "hybrid" }),
				);
				expect(reasons).toEqual(["hybrid-channel-not-permitted"]);
				expect(
					f.frames.some((frame) =>
						frame.includes('"reason":"hybrid-channel-not-permitted"'),
					),
				).toBe(true);
			}
			expect(f.row.conn).toBe("station-uuid");
			expect(f.effects).toEqual([]);
			expect(
				f.target.calls.filter(
					(args) =>
						args[0] === "nmcli" ||
						args.includes("add") ||
						args.at(-1) === "del",
				),
			).toEqual([]);
		} finally {
			getConfig().wifi_modes = modes;
			await f.restore();
		}
	});
}

for (const evidence of [
	"qualified",
	"owned-bound",
	"changed-boot",
	"changed-ifindex",
	"other-phy",
	"unmanaged",
	"active",
	"foreign-bound",
	"unreadable-boot",
	"unreadable-target",
	"unreadable-bindings",
	"capacity",
	"missing",
] as const) {
	test(`admitted Orange adoption with ${evidence} evidence`, async () => {
		const f = await hybridFixture(false, false);
		discoveryFixture(f);
		const leg = f.target.objects.get("clap-wlan0");
		if (!leg) throw new Error("Missing adoption fixture leg");
		if (evidence === "missing") f.target.objects.delete("clap-wlan0");
		spyOn(nm, "nmDevices").mockResolvedValue([
			"wlan0:wifi:connected:station-uuid",
			...(evidence === "missing" ? [] : ["clap-wlan0:wifi:disconnected:"]),
		]);
		try {
			await wifiUpdateDevices();
			if (evidence === "changed-boot") f.target.boot("different-boot");
			if (evidence === "changed-ifindex") leg.ifindex = 99;
			if (evidence === "other-phy") leg.phy += "1";
			if (evidence === "unmanaged") f.target.managed(false);
			if (evidence === "active") f.target.active("foreign-station");
			if (evidence === "foreign-bound") {
				f.target.bindings.set("foreign-profile", "clap-wlan0");
				spyOn(nm, "nmConnGetFields").mockResolvedValue(["clap-wlan0", ""]);
			}
			if (evidence === "owned-bound") {
				f.target.bindings.set("test-ap", "clap-wlan0");
				rememberHotspotCredentials(MAC, {
					ssid: "Original AP",
					password: "original-password",
					conn: "test-ap",
					channel: "ch_11",
				});
				spyOn(nm, "nmConnGetFields").mockResolvedValue(["clap-wlan0", ""]);
			}
			if (evidence === "unreadable-boot") f.target.boot(undefined);
			if (evidence === "unreadable-target") f.target.readableTarget(false);
			if (evidence === "unreadable-bindings") f.target.readableProfiles(false);
			if (evidence === "capacity")
				f.target.combination(
					"valid interface combinations:\n * #{ managed } <= 1, #{ AP } <= 1, total <= 2, #channels <= 1",
				);
			f.target.calls.length = 0;
			const result = await f.start();
			if (evidence === "missing") {
				expect(result).toEqual({ success: true });
				expect(await f.stop()).toEqual({ success: true });
				expect(await f.start()).toEqual({ success: true });
				expect(
					f.target.calls.filter((args) => args.includes("add")),
				).toHaveLength(1);
				expect(f.target.calls.filter((args) => args.at(-1) === "del")).toEqual(
					[],
				);
			} else if (evidence === "qualified" || evidence === "owned-bound") {
				expect(result).toEqual({ success: true });
				expect(await f.stop()).toEqual({ success: true });
				expect(await f.start()).toEqual({ success: true });
				expect(
					f.target.calls.filter(
						(args) => args.includes("add") || args.at(-1) === "del",
					),
				).toEqual([]);
			} else {
				expect(result).toEqual({
					success: false,
					error: "activation-failed",
					reason: "hybrid-channel-not-permitted",
				});
				expect(f.effects).toEqual([]);
				expect(
					f.target.calls.filter(
						(args) =>
							args[0] === "nmcli" ||
							args.includes("add") ||
							args.at(-1) === "del",
					),
				).toEqual([]);
			}
			expect(f.row.conn).toBe("station-uuid");
			expect(f.saved().channel).toBe("ch_11");
		} finally {
			await f.restore();
		}
	});
}

test("a leg appearing after first discovery is adopted but its replacement is refused", async () => {
	const f = await hybridFixture(false, false);
	discoveryFixture(f);
	const leg = f.target.objects.get("clap-wlan0");
	if (!leg) throw new Error("Missing adoption fixture leg");
	f.target.objects.delete("clap-wlan0");
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station-uuid",
	]);
	try {
		await wifiUpdateDevices();
		f.target.objects.set("clap-wlan0", leg);
		expect(await f.start()).toEqual({ success: true });
		expect(await f.stop()).toEqual({ success: true });
		leg.ifindex = 99;
		leg.wdev = "0x99";
		f.effects.length = 0;
		f.target.calls.length = 0;
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
			reason: "hybrid-channel-not-permitted",
		});
		expect(f.effects).toEqual([]);
		expect(
			f.target.calls.filter(
				(args) =>
					args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
			),
		).toEqual([]);
	} finally {
		await f.restore();
	}
});
