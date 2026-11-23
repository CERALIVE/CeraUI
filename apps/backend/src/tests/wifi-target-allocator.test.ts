import { afterEach, expect, mock, test } from "bun:test";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

test("an unrecorded borrowed target survives a name-only release", async () => {
	const f = await targetFixture();
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	expect([...f.objects.keys()]).toEqual([
		"wlan0",
		"clap-wlan0",
		"clap-sentinel",
	]);
});

test("selects the same eligible leg and restores only its owned autoconnect change", async () => {
	const f = await targetFixture();
	const target = await concurrent.selectConcurrentApInterface("wlan0");
	expect(target).toMatchObject({ ifname: "clap-wlan0", created: false });
	expect(f.autoconnect()).toBe("no");
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	expect(f.autoconnect()).toBe("yes");
	expect(
		f.calls.filter((args) => args.includes("add") || args.at(-1) === "del"),
	).toEqual([]);
	expect([...f.objects.keys()]).toEqual([
		"wlan0",
		"clap-wlan0",
		"clap-sentinel",
	]);
});

for (const failure of [
	"wrong-phy",
	"foreign-active",
	"unavailable",
	"rock",
	"capacity",
	"managed-bootstrap-capacity",
] as const) {
	test(`target selection refuses ${failure} without changing objects or device policy`, async () => {
		const f = await targetFixture();
		if (failure === "wrong-phy") {
			const leg = f.objects.get("clap-wlan0");
			if (leg) leg.phy += "1";
		}
		if (failure === "foreign-active") f.active("foreign-station");
		if (failure === "unavailable") f.state("20 (unavailable)");
		if (failure === "rock") f.driver("rtw89_8852be");
		if (failure === "capacity")
			f.combination(
				"valid interface combinations:\n * #{ managed } <= 1, #{ AP } <= 1, total <= 2, #channels <= 1",
			);
		if (failure === "managed-bootstrap-capacity")
			f.combination(
				"valid interface combinations:\n * #{ managed } <= 1, #{ AP } <= 1, #{ P2P-device } <= 1, total <= 3, #channels <= 1",
			);
		expect(
			await concurrent.selectConcurrentApInterface("wlan0"),
		).toBeUndefined();
		expect(f.autoconnect()).toBe("yes");
		expect([...f.objects.keys()]).toEqual([
			"wlan0",
			"clap-wlan0",
			"clap-sentinel",
		]);
		expect(
			f.calls.filter(
				(args) =>
					args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
			),
		).toEqual([]);
	});
}

test("borrowed policy authority cannot affect a same-name replacement", async () => {
	const f = await targetFixture();
	await concurrent.selectConcurrentApInterface("wlan0");
	const leg = f.objects.get("clap-wlan0");
	if (leg) {
		leg.ifindex = 99;
		leg.wdev = "0x99";
	}
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	expect(f.autoconnect()).toBe("no");
	expect(f.objects.get("clap-wlan0")?.ifindex).toBe(99);
});

test("the NM empty UUID marker is an idle borrowed target", async () => {
	const f = await targetFixture();
	f.active("--");
	expect(await concurrent.selectConcurrentApInterface("wlan0")).toMatchObject({
		ifname: "clap-wlan0",
		created: false,
	});
});

test("the creation primitive's exact object can enter qualified adoption", async () => {
	const f = await targetFixture({ existing: false });
	const first = await concurrent.ensureConcurrentApInterface("wlan0");
	expect(first?.created).toBe(true);
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	const next = await concurrent.selectConcurrentApInterface("wlan0");
	expect(next?.created).toBe(false);
	expect(f.calls.filter((args) => args.includes("add"))).toHaveLength(1);
	expect([...f.objects.keys()]).toEqual([
		"wlan0",
		"clap-sentinel",
		"clap-wlan0",
	]);
});

test("unavailable NM never creates a missing Orange target", async () => {
	const f = await targetFixture();
	f.objects.delete("clap-wlan0");
	f.state("20 (unavailable)");
	expect(await concurrent.selectConcurrentApInterface("wlan0")).toBeUndefined();
	expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
	expect(
		f.calls.filter(
			(args) =>
				args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
		),
	).toEqual([]);
});

for (const metadata of [
	{ ifindex: 99 },
	{ wiphy: 1 },
	{ ifname: "clap-replaced" },
]) {
	test(`borrowed iw metadata must agree with the sampled object: ${JSON.stringify(metadata)}`, async () => {
		const f = await targetFixture();
		f.reportTarget(metadata);
		expect(
			await concurrent.selectConcurrentApInterface("wlan0"),
		).toBeUndefined();
		expect(
			f.calls.filter((args) => args[0] === "nmcli" || args.at(-1) === "del"),
		).toEqual([]);
		expect([...f.objects.keys()]).toEqual([
			"wlan0",
			"clap-wlan0",
			"clap-sentinel",
		]);
	});
}
