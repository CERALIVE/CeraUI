import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UplinkShaperApplier } from "../modules/network/uplink-shaper/applier.ts";
import { UplinkShaperCoordinator } from "../modules/network/uplink-shaper/coordinator.ts";
import { readShaperOwnership } from "../modules/network/uplink-shaper/ownership-authority.ts";

test("failed shaper application retries empty idle intent and restores retained roots", async () => {
	// Given retained ownership and a leaf read that fails until storage is repaired.
	const root = mkdtempSync(join(tmpdir(), "shaper-pending-"));
	const path = join(root, "roots.json");
	writeFileSync(path, '{"eth0":{"kind":"noqueue","handle":"0:"}}');
	let repaired = false;
	let reads = 0;
	const commands: string[][] = [];
	const applier = new UplinkShaperApplier({
		readRecordedRoots: async () => {
			reads++;
			if (!repaired) throw Object.assign(new Error("EIO"), { code: "EIO" });
			return readShaperOwnership(path);
		},
		readRoot: async () => ({ kind: "noqueue", handle: "0:" }),
		readBacklog: async () => 0,
		runTc: async (argv) => {
			commands.push([...argv]);
		},
	});
	const coordinator = new UplinkShaperCoordinator({
		apply: (r) => applier.apply(r),
	});
	const emptyIdle = { streaming: false, sharedUplinks: [], telemetry: [] };
	try {
		// When the failed idle uplink disappears, idle updates still own the failed work.
		await expect(
			coordinator.update({
				...emptyIdle,
				sharedUplinks: [{ identity: "eth0", ifname: "eth0", mark: 1 }],
			}),
		).rejects.toThrow("EIO");
		await coordinator.update(emptyIdle).catch(() => undefined);
		await coordinator.update(emptyIdle).catch(() => undefined);
		expect(reads).toBe(3);
		expect(commands).toEqual([]);
		repaired = true;
		await coordinator.update(emptyIdle);
		await coordinator.update(emptyIdle);
		// Then repair is consumed without a streaming edge and successful work settles.
		expect(reads).toBe(4);
		expect(commands).toEqual([["qdisc", "del", "dev", "eth0", "root"]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed root persistence must succeed before a later shaper update mutates traffic control", async () => {
	// Given an applier with a real ownership file and an unavailable first persistence.
	const root = mkdtempSync(join(tmpdir(), "shaper-persist-"));
	const path = join(root, "roots.json");
	writeFileSync(path, "{}");
	let writes = 0;
	const commands: string[][] = [];
	const applier = new UplinkShaperApplier({
		readRecordedRoots: () => readShaperOwnership(path),
		readRoot: async () => ({ kind: "noqueue", handle: "0:" }),
		readBacklog: async () => 0,
		writeRecordedRoots: async (roots) => {
			writes++;
			if (writes < 3)
				throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
			writeFileSync(path, JSON.stringify(roots));
		},
		runTc: async (argv) => {
			commands.push([...argv]);
		},
	});
	const request = {
		mode: "streaming",
		uplinks: [{ ifname: "eth0", mark: 1, capBps: 2_000_000 }],
	} as const;
	try {
		// When two attempts cannot persist ownership, then storage recovers.
		await expect(applier.apply(request)).rejects.toThrow("ENOSPC");
		await applier.apply(request).catch(() => undefined);
		expect(writes).toBe(2);
		expect(commands).toEqual([]);
		await applier.apply(request);
		// Then no qdisc replacement was submitted before the ownership write succeeded.
		expect(writes).toBeGreaterThanOrEqual(3);
		expect(await readShaperOwnership(path)).toEqual({
			eth0: { kind: "noqueue", handle: "0:" },
		});
		expect(commands.length).toBeGreaterThan(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
