import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { revalidateCreatedConcurrentApInterface } from "../modules/wifi/wifi-concurrent-interface-creation.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { hybridFixture } from "./helpers/wifi-hybrid-start.ts";
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
