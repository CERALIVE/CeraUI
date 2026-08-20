/**
 * THE PRE-SPAWN GATE — the backward-compatibility guarantee of this change.
 *
 * A new CeraUI must run a device with an OLD `srtla_send` byte-identically to
 * the CeraUI that shipped before the bind-map existed. Passing an unknown flag
 * to that binary makes it exit non-zero with a usage error, i.e. a failed
 * stream, so the decision has to be made from a probe BEFORE the argument
 * vector exists — and every probe failure has to land on the legacy path.
 */
import { describe, expect, test } from "bun:test";

import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	type BindMapSpawnDeps,
	resolveBindMapArgs,
} from "../modules/streaming/bind-map-spawn.ts";
import type { PublishedBond } from "../modules/streaming/srtla.ts";
import type { CapabilityProbeResult } from "../modules/streaming/srtla-capabilities.ts";

const TWIN_IP = "192.168.8.100";
const SIDECAR = "/tmp/srtla_ips.bindmap.json";
const EXEC = "/usr/bin/srtla_send";

const TWINS: BondEntry[] = [
	{ ip: TWIN_IP, iface: "enx0c5b8f279a64", linkId: "lnk_a" },
	{ ip: TWIN_IP, iface: "eth1", linkId: "lnk_b" },
];

const publishedBond: PublishedBond = {
	entries: TWINS,
	publication: {
		ok: true,
		generation: 3,
		changed: true,
		sidecarPath: SIDECAR,
	},
};

const failedBond: PublishedBond = {
	entries: TWINS,
	publication: { ok: false, reason: "sidecar_write_failed", changed: true },
};

function harness(
	bond: PublishedBond | undefined,
	probeResult: CapabilityProbeResult | Error,
): { deps: BindMapSpawnDeps; causes: string[]; probes: number } {
	const state = { causes: [] as string[], probes: 0 };
	const deps: BindMapSpawnDeps = {
		getBond: () => bond,
		probe: async () => {
			state.probes += 1;
			if (probeResult instanceof Error) throw probeResult;
			return probeResult;
		},
		announce: (cause) => {
			state.causes.push(cause);
		},
	};
	return {
		deps,
		get causes() {
			return state.causes;
		},
		get probes() {
			return state.probes;
		},
	};
}

describe("pre-spawn bind-map gate", () => {
	test("a supporting sender gets --bind-map pointing at the published sidecar", async () => {
		const h = harness(publishedBond, {
			bindMap: true,
			bindMapSchemaVersion: 1,
		});
		expect(await resolveBindMapArgs(EXEC, h.deps)).toEqual([
			"--bind-map",
			SIDECAR,
		]);
		expect(h.causes).toEqual(["bind-map-passed"]);
	});

	test("an OLD sender runs the LEGACY vector, untouched", async () => {
		const h = harness(publishedBond, {
			bindMap: false,
			reason: "nonzero-exit",
		});
		expect(await resolveBindMapArgs(EXEC, h.deps)).toEqual([]);
		expect(h.causes).toEqual(["capability-unsupported"]);
	});

	test("a probe timeout is a legacy spawn, never a failed start", async () => {
		const h = harness(publishedBond, { bindMap: false, reason: "timeout" });
		expect(await resolveBindMapArgs(EXEC, h.deps)).toEqual([]);
		expect(h.causes).toEqual(["capability-unsupported"]);
	});

	test("an invalid capability document is a legacy spawn too", async () => {
		const h = harness(publishedBond, {
			bindMap: false,
			reason: "invalid-json",
		});
		expect(await resolveBindMapArgs(EXEC, h.deps)).toEqual([]);
		expect(h.causes).toEqual(["capability-unsupported"]);
	});

	test("a failed mapping write NEVER probes and NEVER passes the flag", async () => {
		const h = harness(failedBond, { bindMap: true, bindMapSchemaVersion: 1 });
		expect(await resolveBindMapArgs(EXEC, h.deps)).toEqual([]);
		expect(h.probes).toBe(0);
		expect(h.causes).toEqual(["mapping-write-failed"]);
	});

	test("no publication at all is still reported, not swallowed", async () => {
		const h = harness(undefined, { bindMap: true, bindMapSchemaVersion: 1 });
		expect(await resolveBindMapArgs(EXEC, h.deps)).toEqual([]);
		expect(h.probes).toBe(0);
		expect(h.causes).toEqual(["mapping-write-failed"]);
	});

	test("a disposition is recorded on EVERY branch — none is silent", async () => {
		const branches: Array<[PublishedBond | undefined, CapabilityProbeResult]> =
			[
				[publishedBond, { bindMap: true, bindMapSchemaVersion: 1 }],
				[publishedBond, { bindMap: false, reason: "spawn-failed" }],
				[failedBond, { bindMap: true, bindMapSchemaVersion: 1 }],
				[undefined, { bindMap: true, bindMapSchemaVersion: 1 }],
			];
		for (const [bond, probe] of branches) {
			const h = harness(bond, probe);
			await resolveBindMapArgs(EXEC, h.deps);
			expect(h.causes).toHaveLength(1);
		}
	});
});
