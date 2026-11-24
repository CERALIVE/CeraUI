import { mkdtemp, rm } from "node:fs/promises";
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

export const shared = 0xca123400;
const other = 0xca00aa00;
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const table = (mark: number) => String(30_000 + ((mark >>> 8) & 0xffff));
export const link = (identity: string, ifname: string, mark: number) => ({
	identity,
	ifname,
	mark,
	weight: 100,
	selectable: true,
});
export const x = link("id-x", "wwan0", shared);
export const z = link("id-z", "wwan1", other);
const listed = (text: string) =>
	text
		.split("\n")
		.filter((line) => !/^(add|delete) table /.test(line))
		.join("\n")
		.replaceAll(" meta oif ", " oif ");

export async function device(
	run: (h: ReturnType<typeof kernel>) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "steering-stale-journal-"));
	try {
		await run(kernel(join(dir, "marks.json")));
	} finally {
		await rm(dir, { recursive: true });
	}
}

/** Main's applier and the lifecycle over one kernel; the journal is on disk. */
export function kernel(path: string) {
	const tables = new Map<string, string>();
	const rules = new Map<number, string>();
	const flows = new Set<number>();
	const resets: number[] = [];
	const address = new Map<string, string>();
	const index = new Map<string, number>();
	let share = "";
	let guard = "";
	let fence = false;
	let observeFails = 0;
	let saveFault: string | undefined;
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
		resets.push(mark);
		rules.delete(mark);
		tables.delete(table(mark));
	};
	const flush = async (mark: number) => {
		resets.push(mark);
		flows.delete(mark);
	};
	const mainApplier = () =>
		new UplinkSteeringApplier({
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
			rollbackRoute: async () => undefined,
			removeRoute: (route) => retire(route.mark),
			applyRuleset: publish,
			deactivateSharing: async () => undefined,
			flushConntrack: flush,
			setIpForwarding: async () => undefined,
			publishFlowsReset: () => undefined,
		});
	const journal = fileMarkJournal(path);
	const lifecycle = () => {
		const applier = mainApplier();
		return new SteeringMarkLifecycle({
			journal: {
				load: () => journal.load(),
				save: async (record) => {
					const code = saveFault;
					saveFault = undefined;
					if (code) throw Object.assign(new Error(code), { code });
					await journal.save(record);
				},
			},
			observe: () => {
				if (observeFails-- > 0) throw new Error("nft: netlink busy");
				return observeKernelMarks(async (bin) =>
					bin === "nft"
						? `${listed(share)}\n${listed(guard)}\n`
						: fence
							? "110:\tfrom all fwmark 0xca000000/0xff000000 lookup 30000\n"
							: "",
				);
			},
			linkIndex: async (ifname) => index.get(ifname) ?? 80,
			armFence: async () => {
				fence = true;
			},
			guard: async (admission) => {
				guard = buildMarkGuard(admission);
			},
			retire,
			inventory: async () => new Set(rules.keys()),
			ensure,
			flush,
			publish,
			applyLegacy: (before, next) => applier.apply(before, next),
		});
	};
	const plan = (links: readonly SteeringUplink[]): PreparedSteeringState => {
		const uplinks = [...links].sort((a, b) => a.ifname.localeCompare(b.ifname));
		return {
			clientZones: [zone],
			uplinks,
			routes: uplinks.map((uplink) => ({
				...uplink,
				sourceAddress: address.get(uplink.ifname) ?? "100.64.1.2",
				table: table(uplink.mark),
				managed: true,
			})),
		};
	};
	return {
		path,
		flows,
		resets,
		address,
		index,
		lifecycle,
		mainApplier,
		plan,
		guarded: () => guard !== "" || fence,
		route: (mark: number) => tables.get(table(mark)),
		failNextSave: () => {
			saveFault = "ENOSPC";
		},
		failObservations: (count: number) => {
			observeFails = count;
		},
		async step(
			marks: SteeringMarkLifecycle,
			previous: PreparedSteeringState | undefined,
			links: readonly SteeringUplink[],
		) {
			const assigned = await marks.marks(links);
			const next = plan(
				links.map((uplink) => ({
					...uplink,
					mark: assigned.get(uplink.identity) ?? uplink.mark,
				})),
			);
			await marks.apply(previous, next);
			return next;
		},
	};
}
