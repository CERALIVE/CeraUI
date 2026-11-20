import { expect, test } from "bun:test";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { HOTSPOT_UP_TO } from "../modules/wifi/wifi-hotspot-types.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

test("rollback leaves an activation running if Up timed out without an active-path receipt", async () => {
	const f = await firstAp();
	try {
		f.faults.upTimeout = true;
		const result = await f.start();
		const uuid = f.created();
		if (!uuid) throw new Error("Missing created profile");
		expect(f.active()).toBe(uuid);
		expect(f.profiles.has(uuid)).toBeTrue();
		expect(
			f.commands.filter((args) => ["down", "del"].includes(args[1] ?? "")),
		).toEqual([]);
		expect(result).toMatchObject({
			success: false,
			reason: "cleanup-pending",
		});
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

test.each(["before Down", "after Down"] as const)(
	"first-profile rollback leaves a same-profile successor started %s running",
	async (when) => {
		const f = await firstAp("autoconnect");
		try {
			const down = f.deps.nmDisconnect;
			const connect = f.deps.nmConnect;
			f.deps.nmDisconnect = async (uuid, path) => {
				if (when === "before Down") await connect(uuid, HOTSPOT_UP_TO);
				const stopped = await down(uuid, path);
				if (when === "after Down") await connect(uuid, HOTSPOT_UP_TO);
				return stopped;
			};
			const result = await f.start();
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created profile");
			expect(f.active()).toBe(uuid);
			expect(f.profiles.has(uuid)).toBeTrue();
			expect(result).toMatchObject({
				success: false,
				reason: "cleanup-pending",
			});
		} finally {
			cancelWifiAdapterReconciliation();
			await f.restore();
		}
	},
);
