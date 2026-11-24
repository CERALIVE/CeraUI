import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PreparedSteeringState,
	type UplinkRoutePlan,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import { fileMarkJournal } from "../modules/network/uplink-steering/mark-journal.ts";
import { SteeringMarkLifecycle } from "../modules/network/uplink-steering/mark-lifecycle.ts";

const shared = 0xcaffff00;
const other = 0xca001100;
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const link = (identity: string, ifname: string, mark: number) => ({
	identity,
	ifname,
	mark,
	weight: 100,
	selectable: true,
});
const departing = link("id-a", "wwan3", shared);
const survivor = link("id-b", "wwan0", other);
const joiner = link("id-c", "wwan1", shared);
const killed = new Error("backend killed");
const table = (mark: number) => String(30_000 + ((mark >>> 8) & 0xffff));

function kernel(path: string) {
	const tables = new Map<string, string>();
	const rules = new Map<number, string>();
	const flushed: number[] = [];
	let flows: number[] = [];
	let share = "";
	let crashOn: string | undefined;
	const ensure = async (route: UplinkRoutePlan) => {
		tables.set(route.table, route.ifname);
		rules.set(route.mark, route.table);
		return { route, changed: true };
	};
	const retire = async (mark: number) => {
		rules.delete(mark);
		tables.delete(table(mark));
	};
	const flush = async (mark: number) => {
		flushed.push(mark);
		flows = flows.filter((flow) => flow !== mark);
	};
	const lifecycle = () => {
		const applier = new UplinkSteeringApplier({
			discoverRoutes: async () =>
				[...rules].map(([mark, owned]) => ({
					identity: `recovered:${mark.toString(16)}`,
					ifname: tables.get(owned) ?? "unknown0",
					sourceAddress: "0.0.0.0",
					mark,
					table: owned,
					managed: true,
				})),
			ensureRoute: ensure,
			rollbackRoute: async () => {},
			removeRoute: (route) => retire(route.mark),
			applyRuleset: async (ruleset) => {
				share = ruleset;
			},
			deactivateSharing: async () => {
				share = "";
			},
			flushConntrack: flush,
			setIpForwarding: async () => {},
			publishFlowsReset: () => {},
		});
		return new SteeringMarkLifecycle({
			journal: fileMarkJournal(path, (effect) => {
				if (effect !== crashOn) return;
				crashOn = undefined;
				throw killed;
			}),
			observe: async () => ({ guard: "", legacy: share, fence: false }),
			linkIndex: async (ifname) => 80 + Number(ifname.slice(4)),
			armFence: async () => {},
			guard: async () => {},
			retire,
			inventory: async () => new Set(rules.keys()),
			ensure,
			flush,
			publish: async (ruleset) => {
				share = ruleset;
			},
			applyLegacy: (previous, next) => applier.apply(previous, next),
		});
	};
	return {
		lifecycle,
		addFlow: (mark: number) => flows.push(mark),
		crashAt: (effect: string) => {
			crashOn = effect;
		},
		image: () => ({ route: tables.get(table(shared)), flushed, flows }),
	};
}

async function step(
	marks: SteeringMarkLifecycle,
	previous: PreparedSteeringState | undefined,
	links: readonly SteeringUplink[],
): Promise<PreparedSteeringState> {
	const assigned = await marks.marks(links);
	const uplinks = [...links]
		.sort((a, b) => a.ifname.localeCompare(b.ifname))
		.map((uplink) => ({
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
			sourceRulePriority: 100,
		})),
	};
	await marks.apply(previous, next);
	return next;
}

test.each([false, true])(
	"a mark left by a departed owner is flushed before a same-mark joiner (crash after intent: %p)",
	async (crash) => {
		const dir = await mkdtemp(join(tmpdir(), "steering-legacy-recovery-"));
		try {
			const h = kernel(join(dir, "marks.json"));
			let marks = h.lifecycle();
			const before = await step(marks, undefined, [departing, survivor]);
			h.addFlow(shared);
			if (crash) h.crashAt("rename");
			await step(marks, before, [survivor]).catch((error: unknown) => {
				if (error !== killed) throw error;
			});
			marks = h.lifecycle();
			await step(marks, undefined, [survivor, joiner]);
			expect(h.image()).toMatchObject({ route: "wwan1", flows: [] });
			expect(h.image().flushed).toContain(shared);
		} finally {
			await rm(dir, { recursive: true });
		}
	},
);
