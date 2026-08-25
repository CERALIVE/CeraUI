import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	MAX_STEERING_UPLINKS,
	type SteeringUplink,
} from "../modules/network/uplink-steering/contracts.ts";
import {
	buildShareRuleset,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";
import { netnsPrivilegePrefix } from "./helpers/netns-privilege.ts";

/**
 * CERALIVE_NETNS_ISOLATED gate: this test measures a REAL weighted packet
 * distribution through a real netns + nftables setup, so its statistical bound
 * is only meaningful with CPU headroom. Bundled inside the ~5400-test backend
 * suite it is measurably load-sensitive — the wan0/wan1 ratio has been observed
 * at 5.667 (local, under parallel verification load) and 5.897 (CI, inside the
 * full `bun test` process) against a 5.5 ceiling, while passing cleanly whenever
 * run isolated. It therefore runs in its own dedicated CI step
 * (`netns-semantics` in `.github/workflows/build-check.yml`'s `test-be` job),
 * AFTER the main suite, and is visibly SKIPPED during the bundled run.
 *
 * The assertions themselves are unchanged — only WHEN they run.
 *
 * Run locally with:
 *   CERALIVE_NETNS_ISOLATED=1 bun test apps/backend/src/tests/uplink-steering-netns.test.ts
 */
const NETNS_ISOLATED = process.env.CERALIVE_NETNS_ISOLATED === "1";

describe.skipIf(!NETNS_ISOLATED)(
	"uplink steering — kernel netns semantics",
	() => {
		test("kernel netns preserves flow marks across reweight and scopes NAT to client provenance", async () => {
			const wan0 = steeringUplink("wan-a", "wan0", 100);
			const wan1 = steeringUplink("wan-b", "wan1", 25);
			const zone = { ifname: "client0", ipv4Cidr: "10.42.0.0/24" } as const;
			const weighted = buildShareRuleset({
				clientZones: [zone],
				uplinks: [wan0, wan1],
			});
			const selectWan0 = buildShareRuleset({
				clientZones: [zone],
				uplinks: [wan0, { ...wan1, selectable: false, weight: 0 }],
			});
			const transitionWan1 = buildShareRuleset({
				clientZones: [zone],
				uplinks: [
					{ ...wan0, selectable: false, weight: 0 },
					{ ...wan1, weight: 100 },
				],
			});
			const finalWan1 = buildShareRuleset({
				clientZones: [zone],
				uplinks: [{ ...wan1, weight: 100 }],
			});

			const root = join(process.cwd(), "test-results", "uplink-sharing");
			await mkdir(root, { recursive: true });
			const temp = await mkdtemp(join(root, "netns-"));
			await chmod(temp, 0o711);
			try {
				const weightedPath = join(temp, "weighted.nft");
				const selectWan0Path = join(temp, "select-wan0.nft");
				const transitionWan1Path = join(temp, "transition-wan1.nft");
				const finalWan1Path = join(temp, "final-wan1.nft");
				const log0 = join(temp, "wan0.log");
				const log1 = join(temp, "wan1.log");
				const goldenPaths = [0, 1, 2, 3, MAX_STEERING_UPLINKS].map((count) =>
					join(temp, `golden-${count}.nft`),
				);
				await Promise.all([
					writeFile(weightedPath, weighted),
					writeFile(selectWan0Path, selectWan0),
					writeFile(transitionWan1Path, transitionWan1),
					writeFile(finalWan1Path, finalWan1),
					writeFile(log0, ""),
					writeFile(log1, ""),
					...goldenPaths.map((path, index) =>
						writeFile(
							path,
							buildShareRuleset({
								clientZones: [zone],
								uplinks: Array.from(
									{ length: [0, 1, 2, 3, MAX_STEERING_UPLINKS][index] ?? 0 },
									(_, uplinkIndex) =>
										steeringUplink(
											`golden-${uplinkIndex}`,
											`gold${uplinkIndex}`,
											100 - uplinkIndex * 10,
										),
								),
							}),
						),
					),
				]);
				await Promise.all([chmod(log0, 0o666), chmod(log1, 0o666)]);
				const fixturePath = fileURLToPath(
					new URL("./fixtures/uplink-steering-netns.sh", import.meta.url),
				);
				const privilege = await netnsPrivilegePrefix(fixturePath);

				const proc = Bun.spawn(
					[
						...privilege,
						"unshare",
						"-rn",
						"bash",
						fixturePath,
						weightedPath,
						selectWan0Path,
						transitionWan1Path,
						finalWan1Path,
						log0,
						log1,
						hexMark(wan0.mark),
						hexMark(wan1.mark),
						...goldenPaths,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode, stderr).toBe(0);
				const result = JSON.parse(stdout.trim()) as NetnsResult;
				expect(result.weightedTotal).toBeGreaterThanOrEqual(950);
				expect(result.weightedWan0).toBeGreaterThan(0);
				expect(result.weightedWan1).toBeGreaterThan(0);
				const ratio = result.weightedWan0 / result.weightedWan1;
				/**
				 * The 1000-packet sample has an expected wan0/wan1 ratio of 4.0
				 * (p=0.8). With binomial sd(wan0)=sqrt(1000*0.8*0.2)≈12.65,
				 * the ratio's local sd is approximately 12.65*25/1000≈0.32.
				 * Therefore the unchanged 5.5 ceiling is about 4.75σ above the
				 * expected ratio, giving the distribution assertion a robust margin.
				 */
				expect(ratio).toBeGreaterThan(2.5);
				expect(ratio).toBeLessThan(5.5);
				expect(result.stickyBefore).toBe("wan0");
				expect(result.stickyAfter).toBe("wan0");
				expect(result.newAfterReweight).toBe("wan1");
				expect(result.drainNew).toBe("wan1");
				expect(result.stickyPostFlush).toBe("wan1");
				expect(result.localUplink).toBe("wan0");
				expect(result.localSource).toBe("192.0.2.1");
				expect(result.overlapLocalSource).toBe("10.42.0.1");
				expect(result.weightedNatScoped).toBe(true);
				expect(result.replyProbeUplink).toBe("wan1");
				expect(result.replyRoundTrip, JSON.stringify(result)).toBe(true);
				expect(result.rpFilter).toEqual({
					all: 0,
					default: 0,
					wan0: 0,
					wan1: 0,
				});
				expect(["conntrack", "ctnetlink"]).toContain(result.flushBackend);
				expect(result.foreignTablePresent).toBe(true);
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		}, 30_000);
	},
);

interface NetnsResult {
	readonly weightedWan0: number;
	readonly weightedWan1: number;
	readonly weightedTotal: number;
	readonly weightedNatScoped: boolean;
	readonly stickyBefore: "wan0" | "wan1" | null;
	readonly stickyAfter: "wan0" | "wan1" | null;
	readonly newAfterReweight: "wan0" | "wan1" | null;
	readonly drainNew: "wan0" | "wan1" | null;
	readonly stickyPostFlush: "wan0" | "wan1" | null;
	readonly localUplink: "wan0" | "wan1" | null;
	readonly localSource: string | null;
	readonly overlapLocalSource: string | null;
	readonly replyProbeUplink: "wan0" | "wan1" | null;
	readonly replyRoundTrip: boolean;
	readonly flushBackend: "conntrack" | "ctnetlink";
	readonly rpFilter: {
		readonly all: number;
		readonly default: number;
		readonly wan0: number;
		readonly wan1: number;
	};
	readonly foreignTablePresent: boolean;
}

function steeringUplink(
	identity: string,
	ifname: string,
	weight: number,
): SteeringUplink {
	return {
		identity,
		ifname,
		mark: stableUplinkMark(identity),
		selectable: true,
		weight,
	};
}

function hexMark(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
