import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import {
	hotspotCredentialsStore,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { reconcileWifiAdapterModes } from "../modules/wifi/wifi-adapter-mode-restore.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { revalidateCreatedConcurrentApInterface } from "../modules/wifi/wifi-concurrent-interface-creation.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotDeps,
	startHotspotLocked,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type { HotspotActivationDeps } from "../modules/wifi/wifi-hotspot-types.ts";
import { bindingForRow } from "../modules/wifi/wifi-operation-binding.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import { hybridFixture, MAC } from "./helpers/wifi-hybrid-start.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

for (const snapshot of [
	{ ifindex: "99", wdev: "0x7" },
	{ ifindex: "7", wdev: "0x99" },
]) {
	test(`a selected snapshot must match the exact created receipt: ${JSON.stringify(snapshot)}`, async () => {
		const f = await targetFixture({ existing: false });
		const target =
			await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0");
		if (!target || typeof target === "string")
			throw new Error("Missing created target");
		expect(await revalidateCreatedConcurrentApInterface(target, snapshot)).toBe(
			false,
		);
		expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x7");
		expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	});
}

test("the actual activation target composition creates exactly one missing qualified leg", async () => {
	const f = await targetFixture({ existing: false });
	const target = await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0");
	expect(target).toMatchObject({ ifname: "clap-wlan0", created: true });
	if (!target || typeof target === "string")
		throw new Error("Missing created target");
	expect(await concurrent.revalidateConcurrentApInterface(target)).toBe(true);
	expect(f.autoconnect()).toBe("no");
	expect(f.calls.filter((args) => args.includes("add"))).toHaveLength(1);
	expect(f.calls.filter((args) => args[0] === "nmcli")).toEqual([
		["nmcli", "device", "set", target.ifname, "autoconnect", "no"],
	]);
	await concurrent.releaseCreatedConcurrentApInterface(target);
	expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
});

for (const refusal of ["hwsim", "capacity", "foreign-profile"]) {
	test(`missing-leg activation refuses ${refusal} before creation or policy writes`, async () => {
		const f = await targetFixture({ existing: false });
		if (refusal === "hwsim") f.driver("mac80211_hwsim");
		if (refusal === "capacity")
			f.combination(
				"valid interface combinations:\n * #{ managed, AP } <= 1, total <= 1, #channels <= 1",
			);
		if (refusal === "foreign-profile") f.readableProfiles(false);
		expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
			concurrent.HYBRID_CHANNEL_REFUSAL,
		);
		expect(
			f.calls.filter((args) => args.includes("add") || args[0] === "nmcli"),
		).toEqual([]);
		expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
	});
}

test("missing-leg NM readiness failure cleans up only the exact created leg", async () => {
	const f = await targetFixture({ existing: false });
	f.state("20 (unavailable)");
	expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
		concurrent.HYBRID_CHANNEL_REFUSAL,
	);
	expect(f.calls.filter((args) => args.includes("add"))).toHaveLength(1);
	expect(f.calls.filter((args) => args[0] === "nmcli")).toEqual([]);
	expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
});

test("qualified cold intent restore pins and activates the newly created leg while keeping station and sentinel", async () => {
	const f = await hybridFixture(false, false);
	f.target.objects.delete("clap-wlan0");
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.target.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	try {
		await f.restoreFromIntent("hybrid");
		settlePending("wlan0", true);
		expect(f.row.conn).toBe("station-uuid");
		expect(f.row.concurrentHotspot?.activeConn).toBe("test-ap");
		expect(f.row.concurrentHotspot?.ifname).toBe("clap-wlan0");
		expect(f.fields["connection.interface-name"]).toBe("clap-wlan0");
		expect(f.fields["connection.autoconnect"]).toBe("no");
		expect(f.target.objects.get("clap-wlan0")?.type).toBe("AP");
		expect(f.target.objects.get("clap-sentinel")?.wdev).toBe("0x8");
		expect(f.target.calls.filter((args) => args.includes("add"))).toHaveLength(
			1,
		);
		expect(f.effects).toEqual(["write", "up", "write"]);
	} finally {
		await f.restore();
	}
});

test("cold verified restore cannot create the leg on a different phy reusing the parent name at command resolution", async () => {
	const f = await hybridFixture(false, false);
	f.target.objects.delete("clap-wlan0");
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.target.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	const parent = f.target.objects.get("wlan0");
	const replacement = f.target.objects.get("clap-sentinel");
	if (!parent || !replacement) throw new Error("Missing phy fixture");
	const mutated: string[] = [];
	let reached = false;
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			if (command !== "iw" || !args.includes("add"))
				return f.target.run(command, args);
			reached = true;
			f.target.objects.set("wlan0", {
				...replacement,
				ifindex: 90,
				wdev: "0x90",
			});
			const selector = args[args.indexOf("interface") - 2];
			const address = args[args.indexOf("interface") - 1];
			const selectedPhy =
				selector === "dev"
					? f.target.objects.get(address ?? "")?.phy
					: address === "phy#0"
						? parent.phy
						: undefined;
			if (!selectedPhy) throw new Error("No such phy");
			mutated.push(selectedPhy);
			return f.target.run(command, args);
		},
		async () => true,
		async () => "fixture-boot",
	);
	try {
		await f.restoreFromIntent("hybrid");
		expect(reached).toBe(true);
		expect(mutated).toEqual([parent.phy]);
		expect(f.effects).toEqual([]);
	} finally {
		await f.restore();
	}
});

test.each(["cold", "borrowed"] as const)(
	"verified %s hybrid restore refuses a port owner's contradictory saved path before radio mutation",
	async (target) => {
		const f = await hybridFixture(false, false, true);
		const uuid = "independent-port-profile";
		const owner = `${MAC}@usb-port-p2`;
		try {
			if (target === "cold") f.target.objects.delete("clap-wlan0");
			const second = f.target.objects.get("clap-sentinel");
			if (!second) throw new Error("Missing fixture sentinel");
			f.target.objects.set("wlan1", second);
			removeWifiInterface(MAC);
			addWifiInterface(owner, f.row);
			spyOn(radioIdentityReaders, "readDevicePath").mockImplementation(
				async (ifname) => (ifname === "wlan1" ? "usb-port-p1" : "usb-port-p2"),
			);
			const readRadioSpy = spyOn(radioIdentityReaders, "readText");
			const readRadio = readRadioSpy.getMockImplementation();
			if (!readRadio) throw new Error("Missing radio fixture");
			readRadioSpy.mockImplementation(async (path) =>
				path === `${second.phy}/macaddress` ? MAC : readRadio(path),
			);
			await wifiRadioIdentity.discover(
				[...f.target.objects.keys()].map((ifname) =>
					ifname === f.row.ifname ? { ifname, row: f.row } : { ifname },
				),
			);
			await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
				[...f.target.objects.keys()],
				wifiRadioIdentity.state.rows,
			);
			rememberHotspotCredentials(owner, {
				ssid: "Port AP",
				password: "fixture-port-password",
				conn: uuid,
			});
			f.target.bindings.set(uuid, "clap-wlan0");
			const profile: Record<string, string> = {
				"match.path": "usb-port-p1",
				"connection.interface-name": "clap-wlan0",
				"802-11-wireless.mode": "ap",
			};
			const cli = spyOn(runner, "run");
			const read = cli.getMockImplementation() ?? runner.run;
			cli.mockImplementation(async (binary, args, options) =>
				binary === "nmcli" &&
				args?.at(-1) === uuid &&
				nmcliFieldNames(args).length > 0
					? nmcliFieldOutput(args, (field) => profile[field] ?? "")
					: read(binary, args, options),
			);
			let delegatedKey: string | undefined;
			await reconcileWifiAdapterModes(
				{
					...defaultAdapterModeDeps,
					readCapabilities: f.activationDeps.readCapabilities,
					startHotspot: async (_device, publish, attempt, binding) => {
						if (!binding) throw new Error("Expected verified restore binding");
						delegatedKey = binding.key;
						return startHotspotLocked(
							binding.key,
							f.row,
							{
								...f.activationDeps,
								credentials: hotspotCredentialsStore,
								publishOutcome: publish,
							},
							undefined,
							attempt,
							binding,
						);
					},
					publishHotspotOutcome: () => undefined,
				},
				() => ({ [owner]: "hybrid" }),
			);
			expect(delegatedKey).toBe(owner);
			expect(f.target.calls.filter((args) => args.includes("add"))).toEqual([]);
			expect(f.target.calls.filter(([binary]) => binary === "nmcli")).toEqual(
				[],
			);
			expect(f.target.autoconnect()).toBe("yes");
			expect(f.effects).toEqual([]);
		} finally {
			await f.restore();
		}
	},
);

const RESTORE_UUID = "test-ap";
const RESTORE_PORT = "usb-port-p2";
const OLD_LEG = "clap-wlan7";
const NEW_LEG = "clap-wlan0";

async function verifiedProfileFixture(cold: boolean) {
	const f = await hybridFixture(false, false, true);
	if (cold) f.target.objects.delete(NEW_LEG);
	spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(RESTORE_PORT);
	spyOn(radioIdentityReaders, "listInterfaces").mockImplementation(async () => [
		...f.target.objects.keys(),
	]);
	await wifiRadioIdentity.discover(
		[...f.target.objects.keys()].map((ifname) =>
			ifname === f.row.ifname ? { ifname, row: f.row } : { ifname },
		),
	);
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.target.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	rememberHotspotCredentials(MAC, {
		conn: RESTORE_UUID,
		ssid: "Original AP",
		password: "original-password",
	});
	f.target.bindings.set(RESTORE_UUID, NEW_LEG);
	const profile: Record<string, string> = {
		"match.path": RESTORE_PORT,
		"connection.interface-name": NEW_LEG,
		"802-11-wireless.mode": "ap",
		"802-11-wireless.mac-address": MAC,
	};
	const cli = spyOn(runner, "run");
	const read = cli.getMockImplementation() ?? runner.run;
	cli.mockImplementation(async (binary, args, options) =>
		binary === "nmcli" &&
		args?.at(-1) === RESTORE_UUID &&
		nmcliFieldNames(args).length > 0
			? nmcliFieldOutput(args, (field) => profile[field] ?? "")
			: read(binary, args, options),
	);
	const binding = bindingForRow(MAC, f.row);
	if (!binding) throw new Error("Expected verified restore binding");
	const deps: HotspotActivationDeps = {
		...f.activationDeps,
		credentials: hotspotCredentialsStore,
		nmConnSetFields: async (uuid: string, fields: Record<string, string>) => {
			Object.assign(profile, fields);
			return f.activationDeps.nmConnSetFields(uuid, fields);
		},
	};
	return {
		...f,
		deps,
		profile,
		startVerified: () =>
			startHotspotLocked(MAC, f.row, deps, undefined, undefined, {
				...binding,
				bootRestore: "require-port-pin",
			}),
		radioWrites: () =>
			f.target.calls.filter(
				([binary, ...args]) => binary === "nmcli" || args.includes("add"),
			),
	};
}

test.each(["cold", "borrowed"] as const)(
	"verified %s hybrid restore rejects a match.interface-name pinned to the station before any writes",
	async (target) => {
		const f = await verifiedProfileFixture(target === "cold");
		try {
			f.profile["match.interface-name"] = "wlan0";
			await f.startVerified();
			expect(f.radioWrites()).toEqual([]);
			expect(f.effects).toEqual([]);
		} finally {
			await f.restore();
		}
	},
);

test.each([
	"absent",
	"live",
	"unreadable",
	"no-saved-uuid",
	"wrong-mac",
	"no-port",
] as const)(
	"verified hybrid restore requires an absent old leg name and positive owner proof (%s)",
	async (oldName) => {
		const f = await verifiedProfileFixture(true);
		try {
			f.profile["connection.interface-name"] = OLD_LEG;
			f.profile["match.interface-name"] = OLD_LEG;
			if (oldName === "live") {
				const other = f.target.objects.get("clap-sentinel");
				if (!other) throw new Error("Missing other radio");
				f.target.objects.set(OLD_LEG, other);
			}
			if (oldName === "unreadable")
				spyOn(radioIdentityReaders, "listInterfaces").mockResolvedValue(
					undefined,
				);
			if (oldName === "no-saved-uuid")
				spyOn(f.deps.credentials, "get").mockReturnValue(undefined);
			if (oldName === "wrong-mac")
				f.profile["802-11-wireless.mac-address"] = "dc:a6:32:aa:bb:ff";
			if (oldName === "no-port") f.profile["match.path"] = "";
			await f.startVerified();
			if (oldName === "absent") {
				expect(f.effects).toEqual(["write", "up", "write"]);
				expect(f.profile["connection.interface-name"]).toBe(NEW_LEG);
				expect(f.profile["match.interface-name"]).toBe(NEW_LEG);
				expect(f.profile["match.path"]).toBe(RESTORE_PORT);
			} else {
				expect(f.radioWrites()).toEqual([]);
				expect(f.effects).toEqual([]);
			}
		} finally {
			await f.restore();
		}
	},
);

test("verified hybrid restore uses the saved owner's permanent MAC when the old hybrid profile has no MAC pin", async () => {
	const f = await verifiedProfileFixture(true);
	try {
		f.profile["connection.interface-name"] = OLD_LEG;
		f.profile["802-11-wireless.mac-address"] = "";
		await f.startVerified();
		expect(f.effects).toEqual(["write", "up", "write"]);
		expect(f.profile["connection.interface-name"]).toBe(NEW_LEG);
		expect(f.profile["match.path"]).toBe(RESTORE_PORT);
	} finally {
		await f.restore();
	}
});

test.each(["connection.interface-name", "match.interface-name"] as const)(
	"verified cold hybrid restore refuses a live old name pinned only by %s",
	async (selector) => {
		const f = await verifiedProfileFixture(true);
		try {
			const other = f.target.objects.get("clap-sentinel");
			if (!other) throw new Error("Missing other radio");
			f.target.objects.set(OLD_LEG, other);
			f.profile["match.interface-name"] = NEW_LEG;
			f.profile[selector] = OLD_LEG;
			await f.startVerified();
			expect(f.radioWrites()).toEqual([]);
			expect(f.effects).toEqual([]);
		} finally {
			await f.restore();
		}
	},
);

test("hybrid preflight rejects the same contradictory discovered MAC as activation", async () => {
	const f = await verifiedProfileFixture(true);
	try {
		delete f.row.hotspot.name;
		spyOn(f.deps, "findHotspotConn").mockResolvedValue({
			uuid: RESTORE_UUID,
			ssid: "Original AP",
			password: "original-password",
			macAddress: "dc:a6:32:aa:bb:ff",
			channel: "auto",
		});
		await f.startVerified();
		expect(f.radioWrites()).toEqual([]);
		expect(f.effects).toEqual([]);
	} finally {
		await f.restore();
	}
});

test("hybrid restore does not dispatch Up if the matching interface selector changes after Modify", async () => {
	const f = await verifiedProfileFixture(false);
	try {
		f.profile["match.interface-name"] = NEW_LEG;
		f.changeBeforeUp(() => {
			f.profile["match.interface-name"] = "wlan0";
		});
		await f.startVerified();
		expect(f.effects).toEqual(["write"]);
	} finally {
		await f.restore();
	}
});

test("a post-create same-name replacement cannot become the created leg's selected record", async () => {
	const f = await targetFixture({ existing: false });
	const read = spyOn(radioIdentityReaders, "readText").getMockImplementation();
	if (!read) throw new Error("Missing isolated radio reader");
	let replaceOnSample = false;
	let replaced = false;
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (replaceOnSample && path === "/sys/class/net/clap-wlan0/ifindex") {
			const leg = f.objects.get("clap-wlan0");
			if (!leg) throw new Error("Missing newly created leg");
			leg.ifindex = 99;
			leg.wdev = "0x99";
			replaceOnSample = false;
			replaced = true;
		}
		return read(path);
	});
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			const result = await f.run(command, args);
			if (
				command === "iw" &&
				args.join(" ") === "dev clap-wlan0 info" &&
				!replaced &&
				f.calls.some(
					(call) =>
						call[0] === "nmcli" &&
						call.includes("autoconnect") &&
						call.at(-1) === "no",
				)
			)
				replaceOnSample = true;
			return result;
		},
		async () => true,
	);
	const result = await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0");
	expect(replaced).toBe(true);
	expect(result).toBe(concurrent.HYBRID_CHANNEL_REFUSAL);
	expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x99");
	expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	expect(f.calls.filter((args) => args.at(-1) === "del")).toEqual([]);
});
