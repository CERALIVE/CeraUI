import { afterEach, expect, mock, test } from "bun:test";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { hybridFixture } from "./helpers/wifi-hybrid-start.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

const effects = (calls: string[][]) =>
	calls.filter(
		(call) =>
			call[0] === "nmcli" || call.includes("add") || call.at(-1) === "del",
	);

for (const variant of [
	"ifindex-reused",
	"wdev-reused",
	"both-reused-wrong-parent",
	"neither-reused",
] as const) {
	test(`creation receipt refuses replacement ${variant}`, async () => {
		const f = await targetFixture({ existing: false });
		concurrent.setConcurrentInterfaceDepsForTest(
			async (command, args) => {
				const result = await f.run(command, args);
				if (args.includes("add")) {
					const leg = f.objects.get("clap-wlan0");
					if (!leg) throw new Error("Missing fixture leg");
					if (variant === "ifindex-reused") leg.wdev = "0x99";
					if (variant === "wdev-reused") leg.ifindex = 99;
					if (variant === "both-reused-wrong-parent") leg.phy += "1";
					if (variant === "neither-reused") {
						leg.ifindex = 99;
						leg.wdev = "0x99";
					}
				}
				return result;
			},
			async () => true,
		);
		expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
			concurrent.HYBRID_CHANNEL_REFUSAL,
		);
		expect(
			f.calls.filter((call) => call[0] === "nmcli" || call.at(-1) === "del"),
		).toEqual([]);
		expect(f.objects.has("clap-wlan0")).toBe(true);
		expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	});
}

for (const reason of [
	"unqualified",
	"parent-changed",
	"stale",
	"cancelled-after-create",
] as const) {
	test(`cold creation refuses ${reason}`, async () => {
		const f = await targetFixture({ existing: false });
		let admitted = reason !== "stale";
		if (reason === "unqualified") f.driver("mac80211_hwsim");
		if (reason === "parent-changed") {
			const parent = f.objects.get("wlan0");
			if (!parent) throw new Error("Missing fixture parent");
			parent.ifindex = 99;
		}
		if (reason === "cancelled-after-create")
			concurrent.setConcurrentInterfaceDepsForTest(
				async (command, args) => {
					const result = await f.run(command, args);
					if (args.includes("add")) admitted = false;
					return result;
				},
				async () => true,
			);
		expect(
			await defaultHotspotDeps.ensureConcurrentInterface?.(
				"wlan0",
				() => admitted,
			),
		).toBe(concurrent.HYBRID_CHANNEL_REFUSAL);
		expect(effects(f.calls)).toEqual(
			reason === "cancelled-after-create"
				? [
						[
							"iw",
							"--debug",
							"dev",
							"wlan0",
							"interface",
							"add",
							"clap-wlan0",
							"type",
							"managed",
						],
						["iw", "wdev", "0x7", "del"],
					]
				: [],
		);
		expect([...f.objects.keys()]).toEqual(["wlan0", "clap-sentinel"]);
	});
}

test("a same-name leg appearing after absence was admitted is refused without effects", async () => {
	const f = await targetFixture({ existing: false });
	const parent = f.objects.get("wlan0");
	if (!parent) throw new Error("Missing fixture parent");
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			if (
				command === "iw" &&
				args.join(" ") === "dev clap-wlan0 info" &&
				!f.objects.has("clap-wlan0")
			)
				f.objects.set("clap-wlan0", {
					ifindex: 50,
					wdev: "0x50",
					type: "managed",
					phy: parent.phy,
				});
			return f.run(command, args);
		},
		async () => true,
	);
	expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
		concurrent.HYBRID_CHANNEL_REFUSAL,
	);
	expect(effects(f.calls)).toEqual([]);
	expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x50");
	expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	expect(f.autoconnect()).toBe("yes");
});

test("two simultaneous Start calls admit only one cold creation", async () => {
	const f = await hybridFixture(false, false);
	f.target.objects.delete("clap-wlan0");
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.target.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	try {
		const results = await Promise.all([f.start(), f.start()]);
		expect(results.filter((result) => result.success)).toHaveLength(1);
		expect(f.target.calls.filter((call) => call.includes("add"))).toHaveLength(
			1,
		);
		expect(f.effects.filter((effect) => effect === "up")).toHaveLength(1);
		expect(f.target.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	} finally {
		await f.restore();
	}
});
