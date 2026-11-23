import { afterEach, expect, mock, test } from "bun:test";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

test("the retained creation primitive disarms its exact object and release never re-arms it", async () => {
	const f = await targetFixture({ existing: false });
	const created = await concurrent.ensureConcurrentApInterface("wlan0");
	expect(created?.created).toBe(true);
	expect(f.autoconnect()).toBe("no");
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	expect(f.autoconnect()).toBe("no");
	expect(
		f.calls.filter((args) => args[0] === "nmcli").map((args) => args.at(-1)),
	).toEqual(["no"]);
	expect(f.objects.has("clap-wlan0")).toBe(true);
});

test("an unreadable first-discovery boot witness cannot be silently rebased", async () => {
	const f = await targetFixture({ recordDiscovery: false });
	f.boot(undefined);
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	f.boot("fixture-boot");
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	f.calls.length = 0;
	expect(await concurrent.selectConcurrentApInterface("wlan0")).toBeUndefined();
	expect(f.calls.filter((args) => args[0] === "nmcli")).toEqual([]);
});

test("an unreadable first-discovery target cannot gain authority from a later index", async () => {
	const f = await targetFixture({ recordDiscovery: false });
	f.readableTarget(false);
	await wifiRadioIdentity.discover([
		{ ifname: "wlan0" },
		{ ifname: "clap-wlan0" },
	]);
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	f.readableTarget(true);
	f.calls.length = 0;
	expect(await concurrent.selectConcurrentApInterface("wlan0")).toBeUndefined();
	expect(f.calls.filter((args) => args[0] === "nmcli")).toEqual([]);
});

test("Orange never creates or arms a missing leg", async () => {
	const f = await targetFixture({ existing: false });
	const target = await concurrent.selectConcurrentApInterface("wlan0");
	expect(target).toBeUndefined();
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	expect(
		f.calls.filter(
			(args) =>
				args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
		),
	).toEqual([]);
	expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
});

test("a replacement cannot inherit a retained adoption record", async () => {
	const f = await targetFixture();
	await concurrent.selectConcurrentApInterface("wlan0");
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	const created = f.objects.get("clap-wlan0");
	if (!created) throw new Error("Missing created fixture leg");
	f.objects.set("clap-wlan0", { ...created, ifindex: 99, wdev: "0x99" });
	f.calls.length = 0;
	expect(await concurrent.selectConcurrentApInterface("wlan0")).toBeUndefined();
	expect(
		f.calls.filter(
			(args) =>
				args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
		),
	).toEqual([]);
	expect(f.objects.get("clap-wlan0")?.ifindex).toBe(99);
});

test("a lost creation receipt grants neither creation nor deletion authority", async () => {
	// Production ordering: first discovery (no leg) precedes the lost-receipt leftover.
	const f = await targetFixture({ existing: false });
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			const result = await f.run(command, args);
			return args.includes("add") ? "" : result;
		},
		async () => true,
		async () => "fixture-boot",
	);
	expect(await concurrent.ensureConcurrentApInterface("wlan0")).toBeUndefined();
	expect(f.objects.has("clap-wlan0")).toBe(true);
	f.calls.length = 0;
	expect((await concurrent.selectConcurrentApInterface("wlan0"))?.created).toBe(
		false,
	);
	await concurrent.releaseConcurrentApInterface("clap-wlan0");
	expect(
		f.calls.filter((args) => args.includes("add") || args.at(-1) === "del"),
	).toEqual([]);
	expect([...f.objects.keys()]).toEqual([
		"wlan0",
		"clap-sentinel",
		"clap-wlan0",
	]);
});

test("a same-index replacement of a witnessed leg cannot be adopted", async () => {
	const f = await targetFixture();
	const witnessed = f.objects.get("clap-wlan0");
	if (!witnessed) throw new Error("Missing witnessed fixture leg");
	f.objects.set("clap-wlan0", { ...witnessed, wdev: "0x77" });
	f.calls.length = 0;
	expect(await concurrent.selectConcurrentApInterface("wlan0")).toBeUndefined();
	expect(
		f.calls.filter(
			(args) =>
				args[0] === "nmcli" || args.includes("add") || args.at(-1) === "del",
		),
	).toEqual([]);
	expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x77");
});
