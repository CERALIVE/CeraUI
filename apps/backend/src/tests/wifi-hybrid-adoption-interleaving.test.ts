import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { hybridFixture } from "./helpers/wifi-hybrid-start.ts";

type HybridStart = Awaited<ReturnType<typeof hybridFixture>>;

const changes = {
	replacement: (f: HybridStart) => {
		const leg = f.target.objects.get("clap-wlan0");
		if (leg) {
			leg.ifindex = 99;
			leg.wdev = "0x99";
		}
	},
	"foreign binding": (f: HybridStart) => {
		f.target.bindings.set("foreign-profile", "clap-wlan0");
	},
};
const adoptionWrite = [
	"nmcli",
	"device",
	"set",
	"clap-wlan0",
	"autoconnect",
	"no",
];
// A foreign binding found after our write gets back exactly the recorded prior value.
const restoreWrite = [...adoptionWrite.slice(0, -1), "yes"];

for (const [change, apply] of Object.entries(changes)) {
	for (const window of [
		"readiness",
		"adoption write",
		"profile refresh",
	] as const) {
		test(`a ${change} during ${window} refuses hybrid before the next write`, async () => {
			const f = await hybridFixture();
			const priorAutoconnect = f.target.autoconnect();
			spyOn(nm, "nmConnGetFields").mockResolvedValue(["clap-wlan0", ""]);
			if (window === "readiness")
				concurrent.setConcurrentInterfaceDepsForTest(f.target.run, async () => {
					apply(f);
					return true;
				});
			else if (window === "adoption write")
				concurrent.setConcurrentInterfaceDepsForTest(
					async (command, args) => {
						const output = await f.target.run(command, args);
						if (command === "nmcli") apply(f);
						return output;
					},
					async () => true,
				);
			else
				f.activationDeps.wifiUpdateSavedConns = async () => {
					apply(f);
					return undefined;
				};
			try {
				expect(await f.start()).toEqual({
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
				).toEqual(
					window === "readiness"
						? []
						: change === "foreign binding" ||
								(change === "replacement" && window === "adoption write")
							? [adoptionWrite, restoreWrite]
							: [adoptionWrite],
				);
				if (change === "replacement" && window === "adoption write")
					expect(
						f.target.calls.filter((args) => args[0] === "nmcli").at(-1),
					).toEqual([...adoptionWrite.slice(0, -1), priorAutoconnect]);
				if (window === "readiness" || change === "foreign binding")
					expect(f.target.autoconnect()).toBe("yes");
				expect(f.target.objects.has("clap-wlan0")).toBe(true);
				expect(f.row.conn).toBe("station-uuid");
				expect(f.saved().channel).toBe("ch_11");
			} finally {
				await f.restore();
			}
		});
	}
}

test("an observed external autoconnect change retires our restoration claim", async () => {
	const f = await hybridFixture();
	spyOn(nm, "nmConnGetFields").mockResolvedValue(["clap-wlan0", ""]);
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			const output = await f.target.run(command, args);
			if (command === "nmcli") {
				f.target.bindings.set("foreign-profile", "clap-wlan0");
				f.target.externalAutoconnect("yes");
			}
			return output;
		},
		async () => true,
	);
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
			reason: "hybrid-channel-not-permitted",
		});
		f.target.bindings.delete("foreign-profile");
		f.target.externalAutoconnect("no");
		concurrent.setConcurrentInterfaceDepsForTest(
			f.target.run,
			async () => true,
		);
		f.target.calls.length = 0;
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		expect(await f.stop()).toEqual({ success: true });
		expect(f.target.calls.filter((args) => args[0] === "nmcli")).toEqual([]);
		expect(f.target.autoconnect()).toBe("no");
	} finally {
		await f.restore();
	}
});
