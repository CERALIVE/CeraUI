import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunOpts, run, runWithStdin } from "../helpers/run.ts";
import { UplinkSteeringApplier } from "../modules/network/uplink-steering/applier.ts";
import { buildMarkGuard } from "../modules/network/uplink-steering/mark-admission.ts";
import { fileMarkJournal } from "../modules/network/uplink-steering/mark-journal.ts";
import { SteeringMarkLifecycle } from "../modules/network/uplink-steering/mark-lifecycle.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureMarkFence,
	ensureUplinkRoute,
	planUplinkRoute,
	removeUplinkRoute,
	retireMarkSupport,
	rollbackUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import { MARK_FENCE_RULE } from "../modules/network/uplink-steering/route-policy.ts";
import {
	inNamespace,
	isKernelChild,
	kernelReceipt,
	preflight,
} from "./helpers/kernel-namespace.ts";
import suites from "./kernel-suites.json";

const file = import.meta.filename;
const scenario =
	"collision WAL replaces an orphan table before a different owner can route";
const owner = {
	identity: "constructed-twin-386",
	ifname: "wwan1",
	mark: 0xca671800,
	weight: 100,
	selectable: true,
};
const early = { ...owner, identity: "constructed-twin-322", ifname: "wwan0" };
const third = { ...owner, identity: "constructed-third", ifname: "wwan2" };
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };

test(scenario, async () => {
	if (!isKernelChild(file)) {
		const probe = await preflight();
		expect(probe.ok, probe.detail).toBe(true);
		await inNamespace(file, scenario);
		return;
	}
	const scratch = await mkdtemp(join(tmpdir(), "steering-collision-kernel-"));
	try {
		for (const [index, ifname] of ["wwan0", "wwan1", "wwan2"].entries()) {
			await run("ip", ["link", "add", ifname, "type", "dummy"]);
			await run("ip", ["link", "set", ifname, "up"]);
			await run("ip", ["addr", "add", "100.64.1.2/24", "dev", ifname]);
			await run("ip", [
				"route",
				"add",
				"default",
				"via",
				"100.64.1.1",
				"dev",
				ifname,
				"metric",
				String(50 * (index + 1)),
			]);
		}
		const applyNft = async (batch: string) => {
			await runWithStdin("nft", ["-f", "-"], batch);
		};
		const applier = new UplinkSteeringApplier({
			discoverRoutes: discoverOwnedUplinkRoutes,
			ensureRoute: ensureUplinkRoute,
			rollbackRoute: rollbackUplinkRoute,
			removeRoute: removeUplinkRoute,
			applyRuleset: applyNft,
			deactivateSharing: async () => {
				throw new Error("unexpected deactivate");
			},
			flushConntrack: async () => {
				throw new Error("unexpected legacy flush");
			},
			setIpForwarding: async () => {},
			publishFlowsReset: () => {},
		});
		const resets: number[] = [];
		let interrupt = false;
		const killed = new Error("backend restarted after default route");
		const makeController = () =>
			new SteeringMarkLifecycle({
				journal: fileMarkJournal(join(scratch, "marks.json")),
				observe: async () => {
					const nft = await run("nft", ["-nn", "list", "ruleset"]);
					return {
						guard:
							/\bchain ((?:assignment|fenced)_\d+) \{/.exec(nft)?.[1] ?? "",
						legacy: nft,
						fence: MARK_FENCE_RULE.test(await run("ip", ["rule", "show"])),
					};
				},
				linkIndex: async (ifname) =>
					Number(
						/^(\d+):/.exec(
							await run("ip", ["-o", "link", "show", "dev", ifname]),
						)?.[1],
					),
				armFence: ensureMarkFence,
				guard: (admission) => applyNft(buildMarkGuard(admission)),
				retire: retireMarkSupport,
				ensure: async (route) => {
					const wrapped = async (
						bin: Parameters<typeof run>[0],
						argv: string[],
						opts?: RunOpts,
					) => {
						const out = await run(bin, argv, opts);
						if (
							interrupt &&
							bin === "ip" &&
							argv[0] === "route" &&
							["add", "replace"].includes(argv[1] ?? "") &&
							argv[3] === "56393"
						)
							throw killed;
						return out;
					};
					await ensureUplinkRoute(route, { run: wrapped, journaled: true });
				},
				flush: async (mark) => {
					resets.push(mark);
				},
				publish: applyNft,
				applyLegacy: (previous, next) => applier.apply(previous, next),
			});
		async function apply(
			controller: SteeringMarkLifecycle,
			links: readonly (typeof owner)[],
		) {
			const marks = await controller.marks(links);
			const uplinks = [...links]
				.sort((a, b) => a.ifname.localeCompare(b.ifname))
				.map((link) => ({
					...link,
					mark: marks.get(link.identity) ?? link.mark,
				}));
			const routes = [];
			for (const link of uplinks) {
				routes.push(
					await planUplinkRoute(
						{
							...link,
							sourceAddress: "100.64.1.2",
							sourceAddressUnique: false,
						},
						{ run, journaled: true },
					),
				);
			}
			await controller.apply(undefined, {
				clientZones: [zone],
				uplinks,
				routes,
			});
		}
		const controller = makeController();
		await apply(controller, [owner]);
		interrupt = true;
		await expect(apply(controller, [owner, early])).rejects.toThrow(
			killed.message,
		);
		expect(await run("ip", ["route", "show", "table", "56393"])).toContain(
			"dev wwan0",
		);
		expect(await run("ip", ["rule", "show"])).not.toContain(
			"0xca671900/0xffffff00",
		);
		interrupt = false;
		await apply(makeController(), [early, owner, third]);
		for (const [mark, ifname] of [
			["0xca671800", "wwan1"],
			["0xca671900", "wwan2"],
			["0xca671a00", "wwan0"],
		]) {
			if (mark === undefined || ifname === undefined)
				throw new Error("invalid test case");
			expect(
				await run("ip", ["route", "get", "203.0.113.1", "mark", mark]),
			).toContain(`dev ${ifname}`);
		}
		const route = await run("ip", ["route", "show", "table", "56393"]);
		expect(route.trim().split("\n")).toHaveLength(1);
		expect(route).toContain("dev wwan2");
		expect(await run("ip", ["rule", "show"])).not.toContain(
			"100:\tfrom 100.64.1.2",
		);
		expect(resets).not.toContain(owner.mark);
		expect(
			await run("nft", ["list", "table", "inet", "ceralive_share_guard"]),
		).toContain("chain assignment_3");
		console.log(kernelReceipt(file, scenario));
	} finally {
		await rm(scratch, { recursive: true });
	}
}, 30_000);

if (!isKernelChild(file)) {
	test("kernel scenario receipt set", () => {
		expect(suites["uplink-steering-collision-kernel.test.ts"]).toEqual([
			scenario,
		]);
	});
}
