import { expect, test } from "bun:test";
import { getSpawnSite, validateSpawnSite } from "../helpers/spawn-policy.ts";

test("live journal follow is registered as a socket-aborted lifetime-exempt watcher", () => {
	const site = getSpawnSite("deviceLogs.journalFollow");
	expect(site).toMatchObject({
		id: "deviceLogs.journalFollow",
		file: "modules/device-logs/follow.ts",
		class: "watcher",
		status: "enforced",
		contract: {
			timed: false,
			startupTimeout: false,
			shutdownCleanup: false,
			shutdownAbort: true,
			lifetimeTimeoutExempt: true,
		},
	});
	if (!site) throw new Error("missing journal follower policy");
	expect(validateSpawnSite(site)).toEqual([]);
});
