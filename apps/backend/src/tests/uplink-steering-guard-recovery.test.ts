import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PreparedSteeringState,
	type UplinkRoutePlan,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import { buildMarkGuard } from "../modules/network/uplink-steering/mark-admission.ts";
import { fileMarkJournal } from "../modules/network/uplink-steering/mark-journal.ts";
import { SteeringMarkLifecycle } from "../modules/network/uplink-steering/mark-lifecycle.ts";
import { observeKernelMarks } from "../modules/network/uplink-steering/mark-observation.ts";

const shared = 0xca123400;
const other = 0xca00aa00;
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const table = (mark: number) => String(30_000 + ((mark >>> 8) & 0xffff));
const link = (identity: string, ifname: string, mark: number) => ({
	identity,
	ifname,
	mark,
	weight: 100,
	selectable: true,
});
const pair = [
	link("id-x", "wwan0", shared),
	link("id-z", "wwan1", other),
	link("id-y", "wwan2", shared),
];
const listed = (text: string) =>
	text
		.split("\n")
		.filter((line) => !/^(add|delete) table /.test(line))
		.join("\n")
		.replaceAll(" meta oif ", " oif ");

async function device(run: (h: ReturnType<typeof kernel>) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "steering-guard-recovery-"));
	try {
		await run(kernel(join(dir, "marks.json")));
	} finally {
		await rm(dir, { recursive: true });
	}
}

function kernel(path: string) {
	const tables = new Map<string, string>();
	const rules = new Map<number, string>();
	let share = "";
	let guard = "";
	let fence = false;
	let previous: PreparedSteeringState | undefined;
	const publish = async (ruleset: string) => {
		const at = ruleset.indexOf("add table inet ceralive_share_guard");
		share = at < 0 ? ruleset : ruleset.slice(0, at);
		if (at >= 0) guard = ruleset.slice(at);
	};
	const ensure = async (route: UplinkRoutePlan) => {
		tables.set(route.table, route.ifname);
		rules.set(route.mark, route.table);
		return { route, changed: true };
	};
	const retire = async (mark: number) => {
		rules.delete(mark);
		tables.delete(table(mark));
	};
	const lifecycle = () => {
		const applier = new UplinkSteeringApplier({
			discoverRoutes: async () => [],
			ensureRoute: ensure,
			rollbackRoute: async () => {},
			removeRoute: (route) => retire(route.mark),
			applyRuleset: publish,
			deactivateSharing: async () => {},
			flushConntrack: async () => {},
			setIpForwarding: async () => {},
			publishFlowsReset: () => {},
		});
		return new SteeringMarkLifecycle({
			journal: fileMarkJournal(path),
			observe: () =>
				observeKernelMarks(async (bin) =>
					bin === "nft"
						? `${listed(share)}\n${listed(guard)}\n`
						: fence
							? "110:\tfrom all fwmark 0xca000000/0xff000000 lookup 30000\n"
							: "",
				),
			linkIndex: async (ifname) => 80 + Number(ifname.slice(4)),
			armFence: async () => {
				fence = true;
			},
			guard: async (admission) => {
				guard = buildMarkGuard(admission);
			},
			retire,
			inventory: async () => new Set(rules.keys()),
			ensure,
			flush: async () => {},
			publish,
			applyLegacy: (before, next) => applier.apply(before, next),
		});
	};
	let marks = lifecycle();
	return {
		get marks() {
			return marks;
		},
		receipt: () => /chain ((?:assignment|fenced)_\d+) \{/.exec(guard)?.[1],
		restart: () => {
			marks = lifecycle();
			previous = undefined;
		},
		async step(links: readonly SteeringUplink[]) {
			const assigned = await marks.marks(links);
			const uplinks = links.map((uplink) => ({
				...uplink,
				mark: assigned.get(uplink.identity) ?? uplink.mark,
			}));
			const next = {
				clientZones: [zone],
				uplinks,
				routes: uplinks.map((uplink) => ({
					...uplink,
					sourceAddress: `100.64.${uplink.ifname.slice(4)}.2`,
					table: table(uplink.mark),
					managed: true,
				})),
			};
			await marks.apply(previous, next);
			previous = next;
		},
		corrupt: async () => {
			const saved = await readFile(path, "utf8");
			await writeFile(path, "torn");
			return () => writeFile(path, saved);
		},
	};
}

const outcome = (work: Promise<unknown>) =>
	work.then(
		() => "ok",
		(error: { reason?: string }) => error.reason ?? String(error),
	);

test("a committed collision transition leaves nothing pending", async () => {
	await device(async (h) => {
		await h.step(pair.slice(0, 2));
		await h.step(pair);
		expect({ pending: h.marks.pending, receipt: h.receipt() }).toEqual({
			pending: false,
			receipt: "assignment_2",
		});
	});
});

test("a transient journal read fault under a guard recovers once it reads again", async () => {
	await device(async (h) => {
		await h.step(pair.slice(0, 2));
		await h.step(pair);
		const restore = await h.corrupt();
		expect(await outcome(h.marks.marks(pair))).toBe("mark_collision");
		expect(h.receipt()).toBe("fenced_0");
		await restore();

		expect(await outcome(h.marks.marks(pair))).toBe("ok");
		expect(h.marks.pending).toBe(true);
		h.restart();
		expect(await outcome(h.step(pair))).toBe("ok");
		expect({ pending: h.marks.pending, receipt: h.receipt() }).toEqual({
			pending: false,
			receipt: "assignment_3",
		});
	});
});
