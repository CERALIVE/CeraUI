import { describe, expect, test } from "bun:test";

import {
	type NetnsProbe,
	type NetnsProbeResult,
	netnsPrivilegePrefix,
} from "./helpers/netns-privilege.ts";

const FIXTURE_PATH =
	"/checkout/apps/backend/src/tests/fixtures/uplink-steering-netns.sh";

describe("network-namespace privilege resolution", () => {
	test("prefers plain unshare only after the namespace reads the checkout fixture", async () => {
		const harness = probeHarness([{ ok: true, error: "" }]);

		expect(await netnsPrivilegePrefix(FIXTURE_PATH, harness.probe)).toEqual([]);
		expect(harness.calls).toEqual([["unshare", "-rn", "cat", FIXTURE_PATH]]);
	});

	test("falls back to passwordless sudo when plain unshare cannot read the fixture", async () => {
		const harness = probeHarness([
			{ ok: false, error: "Permission denied" },
			{ ok: true, error: "" },
		]);

		expect(await netnsPrivilegePrefix(FIXTURE_PATH, harness.probe)).toEqual([
			"sudo",
			"-n",
		]);
		expect(harness.calls).toEqual([
			["unshare", "-rn", "cat", FIXTURE_PATH],
			["sudo", "-n", "unshare", "-rn", "cat", FIXTURE_PATH],
		]);
	});

	test("fails with both probe errors and actionable remedies when neither path works", async () => {
		const harness = probeHarness([
			{ ok: false, error: "direct permission denied" },
			{ ok: false, error: "sudo: a password is required" },
		]);

		expect(netnsPrivilegePrefix(FIXTURE_PATH, harness.probe)).rejects.toThrow(
			/direct permission denied.*sudo: a password is required.*configure passwordless sudo/s,
		);
	});
});

function probeHarness(outcomes: readonly NetnsProbeResult[]): {
	readonly calls: readonly string[][];
	readonly probe: NetnsProbe;
} {
	const remaining = [...outcomes];
	const calls: string[][] = [];
	return {
		calls,
		probe: async (argv) => {
			calls.push([...argv]);
			return (
				remaining.shift() ?? { ok: false, error: "missing scripted outcome" }
			);
		},
	};
}
