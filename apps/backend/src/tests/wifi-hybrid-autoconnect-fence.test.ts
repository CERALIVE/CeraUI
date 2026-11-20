import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

for (const existing of [false, true]) {
	for (const boundary of ["profile-observation", "device-write"] as const) {
		test(`${existing ? "borrowed" : "created"} leg replacement during ${boundary} is refused without leaving foreign autoconnect changed`, async () => {
			const f = await targetFixture({ existing });
			let replaced = false;
			let profileReads = 0;
			const foreignWrites: string[][] = [];
			const replace = () => {
				const leg = f.objects.get("clap-wlan0");
				if (!leg) throw new Error("Missing fixture leg");
				f.objects.set("clap-wlan0", { ...leg, ifindex: 99, wdev: "0x99" });
				f.externalAutoconnect("yes");
				replaced = true;
			};
			spyOn(nm, "nmConnsGet").mockImplementation(async () => {
				if (
					boundary === "profile-observation" &&
					!replaced &&
					(existing
						? ++profileReads === 2
						: f.calls.some((call) => call.includes("add")))
				)
					replace();
				return [];
			});
			concurrent.setConcurrentInterfaceDepsForTest(
				async (command, args) => {
					if (command === "nmcli") {
						if (boundary === "device-write" && !replaced) replace();
						if (replaced) foreignWrites.push([command, ...args]);
					}
					return f.run(command, args);
				},
				async () => true,
			);
			expect(
				await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0"),
			).toBe(concurrent.HYBRID_CHANNEL_REFUSAL);
			expect(replaced).toBe(true);
			expect(f.autoconnect()).toBe("yes");
			expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x99");
			expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
			expect(f.calls.filter((args) => args.at(-1) === "del")).toEqual([]);
			expect(foreignWrites).toEqual(
				boundary === "profile-observation"
					? []
					: [
							["nmcli", "device", "set", "clap-wlan0", "autoconnect", "no"],
							["nmcli", "device", "set", "clap-wlan0", "autoconnect", "yes"],
						],
			);
		});
	}

	test(`${existing ? "borrowed" : "created"} leg with unreadable autoconnect refuses before a device write`, async () => {
		const f = await targetFixture({ existing });
		const read = spyOn(nm, "nmDeviceProp").getMockImplementation();
		if (!read) throw new Error("Missing isolated device reader");
		spyOn(nm, "nmDeviceProp").mockImplementation((name, fields, mode) =>
			fields === "GENERAL.AUTOCONNECT"
				? Promise.resolve(undefined)
				: read(name, fields, mode),
		);
		expect(await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0")).toBe(
			concurrent.HYBRID_CHANNEL_REFUSAL,
		);
		expect(f.calls.filter((args) => args[0] === "nmcli")).toEqual([]);
		expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
	});
}

test("release refuses a replacement appearing during its autoconnect read", async () => {
	const f = await targetFixture();
	const target = await defaultHotspotDeps.ensureConcurrentInterface?.("wlan0");
	if (!target || typeof target === "string")
		throw new Error("Missing borrowed target");
	const read = spyOn(nm, "nmDeviceProp").getMockImplementation();
	if (!read) throw new Error("Missing isolated device reader");
	let replaced = false;
	spyOn(nm, "nmDeviceProp").mockImplementation(async (name, fields, mode) => {
		if (!replaced && fields === "GENERAL.AUTOCONNECT") {
			const leg = f.objects.get("clap-wlan0");
			if (!leg) throw new Error("Missing fixture leg");
			f.objects.set("clap-wlan0", { ...leg, ifindex: 99, wdev: "0x99" });
			replaced = true;
		}
		return read(name, fields, mode);
	});
	f.calls.length = 0;
	await concurrent.releaseConcurrentApInterface(target.ifname);
	expect(replaced).toBe(true);
	expect(f.autoconnect()).toBe("no");
	expect(f.calls.filter((args) => args[0] === "nmcli")).toEqual([]);
	expect(f.objects.get("clap-wlan0")?.wdev).toBe("0x99");
	expect(f.objects.get("clap-sentinel")?.wdev).toBe("0x8");
});
