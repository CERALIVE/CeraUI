import { describe, expect, test } from "bun:test";
import { getSpawnSite, spawnWithTimeout } from "../helpers/spawn-policy.ts";

describe("apt preflight process policy", () => {
	test.each([
		["softwareUpdates.aptCacheClean", "bounded-command"],
		["softwareUpdates.aptArchiveConfig", "bounded-probe"],
		["softwareUpdates.aptSpaceProbe", "bounded-probe"],
	])("registers %s as %s", (id, classification) => {
		// Given a real new process site; when looking it up; then its bound is enforced.
		expect(getSpawnSite(id)).toMatchObject({
			class: classification,
			status: "enforced",
			contract: { timed: true, lifetimeTimeoutExempt: false },
		});
	});
	test("sets the probe locale on the child without changing the backend environment", async () => {
		// Given a caller with its own locale.
		const before = process.env.LC_ALL;
		// When a bounded child gets a command-local override.
		const result = await spawnWithTimeout(
			[process.execPath, "-e", "process.stdout.write(process.env.LC_ALL)"],
			{ timeoutMs: 5000, env: { ...process.env, LC_ALL: "C" } },
		);
		// Then only that child sees C.
		expect(result.stdout).toBe("C");
		expect(process.env.LC_ALL).toBe(before);
	});
});
