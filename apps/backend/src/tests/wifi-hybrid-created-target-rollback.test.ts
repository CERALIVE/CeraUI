import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { selectedTargets } from "../modules/wifi/wifi-hybrid-target-record.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { hybridFixture } from "./helpers/wifi-hybrid-start.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

const adds = (calls: string[][]) =>
	calls.filter((args) => args.includes("add"));
const deletes = (calls: string[][]) =>
	calls.filter((args) => args.at(-1) === "del");

async function coldHybridFixture() {
	const f = await hybridFixture(false, false);
	f.target.objects.delete("clap-wlan0");
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.target.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	return f;
}

async function createdTarget() {
	const target = await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0");
	if (!target || typeof target === "string")
		throw new Error("Missing created target");
	return target;
}

test("a Start whose activation fails retires its created leg, so the next Start creates it again", async () => {
	const f = await coldHybridFixture();
	try {
		f.failNextUp();
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect([...f.target.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
		expect(selectedTargets.has("clap-wlan0")).toBe(false);
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		expect(f.row.conn).toBe("station-uuid");
		expect(f.row.concurrentHotspot?.ifname).toBe("clap-wlan0");
		expect(f.target.objects.get("clap-wlan0")?.type).toBe("AP");
		expect(f.target.objects.get("clap-sentinel")?.wdev).toBe("0x8");
		expect(adds(f.target.calls)).toHaveLength(2);
		expect(deletes(f.target.calls)).toEqual([["iw", "wdev", "0x7", "del"]]);
	} finally {
		await f.restore();
	}
});

test("authority withdrawn after the record write retires the deleted leg's record", async () => {
	const f = await targetFixture({ existing: false });
	const list = spyOn(nm, "nmConnsGet").getMockImplementation();
	if (!list) throw new Error("Missing isolated profile listing");
	let reads = 0;
	let recordedBeforeRefusal = false;
	spyOn(nm, "nmConnsGet").mockImplementation(async (fields) => {
		if (fields !== "uuid,type" || ++reads !== 5) return list(fields);
		// The selector's final authority check, after it stored the record.
		recordedBeforeRefusal =
			selectedTargets.get("clap-wlan0")?.record !== undefined;
		return undefined;
	});
	expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
		concurrent.HYBRID_CHANNEL_REFUSAL,
	);
	expect(recordedBeforeRefusal).toBe(true);
	expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
	expect(selectedTargets.has("clap-wlan0")).toBe(false);
	expect(await createdTarget()).toMatchObject({
		ifname: "clap-wlan0",
		created: true,
	});
	expect(adds(f.calls)).toHaveLength(2);
	expect(deletes(f.calls)).toEqual([["iw", "wdev", "0x7", "del"]]);
	expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
});

test("a failed delete keeps the record bound to the surviving created leg", async () => {
	const f = await targetFixture({ existing: false });
	const target = await createdTarget();
	const record = selectedTargets.get("clap-wlan0")?.record;
	expect(record?.wireless).toEqual({ ifindex: "7", wdev: "0x7" });
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			if (args.at(-1) === "del") throw new Error("Fixture delete failed");
			return f.run(command, args);
		},
		async () => true,
	);
	await defaultHotspotDeps.rollbackConcurrentInterface?.(target);
	expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x7");
	expect(selectedTargets.get("clap-wlan0")?.record).toBe(record);
	concurrent.setConcurrentInterfaceDepsForTest(f.run, async () => true);
	await defaultHotspotDeps.rollbackConcurrentInterface?.(target);
	expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
	expect(selectedTargets.has("clap-wlan0")).toBe(false);
	expect(await createdTarget()).toMatchObject({ created: true });
	expect(adds(f.calls)).toHaveLength(2);
});

test("a kept created leg keeps its record through Stop and a failed reuse Start", async () => {
	const f = await coldHybridFixture();
	try {
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		const leg = f.target.objects.get("clap-wlan0");
		const wireless = selectedTargets.get("clap-wlan0")?.record?.wireless;
		expect(wireless).toEqual({ ifindex: "7", wdev: "0x7" });
		expect(await f.stop()).toEqual({ success: true });
		f.failNextUp();
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(f.target.objects.get("clap-wlan0")).toBe(leg);
		expect(selectedTargets.get("clap-wlan0")?.record?.wireless).toEqual(
			wireless,
		);
		expect(await f.start()).toEqual({ success: true });
		expect(f.target.objects.get("clap-wlan0")).toBe(leg);
		expect(f.target.objects.get("clap-sentinel")?.wdev).toBe("0x8");
		expect(adds(f.target.calls)).toHaveLength(1);
		expect(deletes(f.target.calls)).toEqual([]);
	} finally {
		await f.restore();
	}
});

test("rollback never deletes a same-name replacement or the sentinel, and the replacement stays refused", async () => {
	const f = await targetFixture({ existing: false });
	const target = await createdTarget();
	const leg = f.objects.get("clap-wlan0");
	if (!leg) throw new Error("Missing created leg");
	leg.ifindex = 99;
	leg.wdev = "0x99";
	await defaultHotspotDeps.rollbackConcurrentInterface?.(target);
	expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x99");
	expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	expect(selectedTargets.get("clap-wlan0")?.record?.wireless.wdev).toBe("0x7");
	expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
		concurrent.HYBRID_CHANNEL_REFUSAL,
	);
	expect(adds(f.calls)).toHaveLength(1);
	expect(deletes(f.calls)).toEqual([]);
});
