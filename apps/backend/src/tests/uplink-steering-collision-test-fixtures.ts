import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	PreparedSteeringState,
	UplinkRoutePlan,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import {
	type MarkAdmission,
	receiptName,
} from "../modules/network/uplink-steering/mark-admission.ts";
import { fileMarkJournal } from "../modules/network/uplink-steering/mark-journal.ts";
import { SteeringMarkLifecycle } from "../modules/network/uplink-steering/mark-lifecycle.ts";

export const natural = 0xca671800;
export const spare = 0xca671900;
export const incumbent = {
	identity: "constructed-twin-386",
	ifname: "wwan1",
	mark: natural,
	weight: 100,
	selectable: true,
};
export const joiner = {
	...incumbent,
	identity: "constructed-twin-322",
	ifname: "wwan0",
};
export const replacement = {
	...incumbent,
	identity: "constructed-third",
	ifname: "wwan2",
};
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const table = (mark: number) => `${30_000 + ((mark >>> 8) & 0xffff)}`;
export const killed = new Error("backend exited");

export async function fixture(
	callback: (h: ReturnType<typeof harness>) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "steering-marks-"));
	try {
		await callback(harness(join(dir, "marks.json")));
	} finally {
		await rm(dir, { recursive: true });
	}
}

export function harness(path: string) {
	let receipt = "";
	let fence = false;
	let wantedCrash: string | undefined;
	let journalWrite = 0;
	let prior: PreparedSteeringState | undefined;
	let admitted: readonly { readonly mark: number; readonly ifindex: number }[] =
		[];
	const effects: string[] = [];
	const tables = new Map<string, string>();
	const rules = new Map<number, string>();
	const resets = new Set<number>();
	const lifecycle = () =>
		new SteeringMarkLifecycle({
			journal: fileMarkJournal(path, (effect) => {
				if (effect === "temp") journalWrite++;
				mutate(`journal:${journalWrite}:${effect}`);
			}),
			observe: async () => ({ guard: receipt, fence, legacy: "" }),
			linkIndex: async (ifname) => 10 + Number(ifname.slice(4)),
			armFence: async () => {
				fence = true;
				mutate("fence");
			},
			guard: async (state: MarkAdmission) => {
				admitted = state.claims;
				receipt = `fenced_${state.seq}`;
				mutate("guard");
			},
			flush: async (mark) => {
				resets.add(mark);
				mutate(`flush:${mark}`);
			},
			retire: async (mark) => {
				rules.delete(mark);
				mutate(`rule-del:${mark}`);
				tables.delete(table(mark));
				mutate(`route-del:${mark}`);
			},
			ensure: async (route) => {
				tables.set(route.table, route.ifname);
				mutate(`route-add:${route.mark}`);
				rules.set(route.mark, route.table);
				mutate(`rule-add:${route.mark}`);
			},
			publish: async (body) => {
				const seq = /chain assignment_(\d+)/.exec(body)?.[1];
				if (seq === undefined)
					throw new Error("publication has no kernel receipt");
				receipt = receiptName(Number(seq));
				admitted = [
					...body.matchAll(
						/meta mark & 0xffffff00 == (0x[\da-f]+) meta oif (\d+)/g,
					),
				].map((match) => ({
					mark: Number(match[1]),
					ifindex: Number(match[2]),
				}));
				mutate("publish");
			},
			applyLegacy: async (_previous, next) => {
				for (const route of next.routes) {
					tables.set(route.table, route.ifname);
					rules.set(route.mark, route.table);
				}
			},
		});
	let controller = lifecycle();
	function mutate(effect: string) {
		effects.push(effect);
		if (effect === wantedCrash) throw killed;
	}
	async function apply(input: readonly SteeringUplink[]) {
		const marks = await controller.marks(input);
		const uplinks = [...input]
			.sort((a, b) => a.ifname.localeCompare(b.ifname))
			.map((owner) => ({
				...owner,
				mark: marks.get(owner.identity) ?? owner.mark,
			}));
		const routes = uplinks.map(
			(owner): UplinkRoutePlan => ({
				...owner,
				table: table(owner.mark),
				sourceAddress: "100.64.1.2",
				managed: true,
			}),
		);
		const next = { clientZones: [zone], uplinks, routes };
		await controller.apply(prior, next);
		mutate("available");
		prior = next;
		return routes;
	}
	return {
		apply,
		effects,
		resets,
		tables,
		rules,
		crashAt(effect?: string) {
			wantedCrash = effect;
		},
		begin() {
			journalWrite = 0;
			effects.length = 0;
			resets.clear();
		},
		restart() {
			controller = lifecycle();
			prior = undefined;
			wantedCrash = undefined;
		},
		routed(mark: number) {
			const output = rules.get(mark);
			const ifname = output === undefined ? undefined : tables.get(output);
			return ifname &&
				admitted.some(
					(claim) =>
						claim.mark === mark &&
						claim.ifindex === 10 + Number(ifname.slice(4)),
				)
				? ifname
				: undefined;
		},
		async image() {
			return {
				receipt,
				fence,
				tables: [...tables].sort(),
				rules: [...rules].sort(),
				journal: await fileMarkJournal(path).load(),
			};
		},
	};
}
