import { expect, test } from "bun:test";
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

const natural = 0xca671800;
const spare = 0xca671900;
const incumbent = {
	identity: "constructed-twin-386",
	ifname: "wwan1",
	mark: natural,
	weight: 100,
	selectable: true,
};
const joiner = {
	...incumbent,
	identity: "constructed-twin-322",
	ifname: "wwan0",
};
const replacement = {
	...incumbent,
	identity: "constructed-third",
	ifname: "wwan2",
};
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const table = (mark: number) => `${30_000 + ((mark >>> 8) & 0xffff)}`;
const killed = new Error("backend exited");

async function fixture(
	callback: (h: ReturnType<typeof harness>) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "steering-marks-"));
	try {
		await callback(harness(join(dir, "marks.json")));
	} finally {
		await rm(dir, { recursive: true });
	}
}

function harness(path: string) {
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

test("cold duplicate-address twins retain separate admitted routes for either same-boot restart order", async () => {
	await fixture(async (h) => {
		await h.apply([incumbent, joiner]);
		expect(h.routed(natural)).toBe("wwan0");
		expect(h.routed(spare)).toBe("wwan1");
		for (const order of [
			[joiner, incumbent],
			[incumbent, joiner],
		]) {
			h.restart();
			h.begin();
			await h.apply(order);
			expect([...h.resets]).toEqual([]);
			expect(h.routed(natural)).toBe("wwan0");
			expect(h.routed(spare)).toBe("wwan1");
		}
	});
});

test("replaces an orphan provisional table with the actual owner on a changed restart", async () => {
	await fixture(async (h) => {
		await h.apply([incumbent]);
		h.begin();
		h.crashAt(`route-add:${spare}`);
		await expect(h.apply([incumbent, joiner])).rejects.toBe(killed);
		expect(h.tables.get("56393")).toBe("wwan0");
		expect(h.rules.has(spare)).toBe(false);
		expect(h.routed(spare)).toBeUndefined();
		h.restart();
		await h.apply([joiner, replacement, incumbent]);
		expect(h.routed(natural)).toBe("wwan1");
		expect(h.routed(spare)).toBe("wwan2");
		expect(h.routed(0xca671a00)).toBe("wwan0");
	});
});

test("retires the departing collision mark without flushing the surviving prober on reweight", async () => {
	await fixture(async (h) => {
		await h.apply([incumbent]);
		await h.apply([joiner, incumbent]);
		h.begin();
		await h.apply([{ ...joiner, weight: 25 }]);
		expect(h.routed(spare)).toBe("wwan0");
		expect(h.routed(natural)).toBeUndefined();
		expect([...h.resets]).toEqual([natural]);
	});
});

test("a crash before or after every collision write converges to the uninterrupted assignment", async () => {
	let expected:
		| Awaited<ReturnType<ReturnType<typeof harness>["image"]>>
		| undefined;
	let effects: string[] = [];
	await fixture(async (h) => {
		await h.apply([incumbent]);
		h.begin();
		await h.apply([incumbent, joiner]);
		effects = [...h.effects];
		expected = await h.image();
	});
	if (expected === undefined) throw new Error("uninterrupted image missing");
	const finalImage = expected;
	expect(effects).toEqual([
		"journal:1:temp",
		"journal:1:file-sync",
		"journal:1:rename",
		"journal:1:dir-sync",
		"guard",
		"fence",
		`flush:${spare}`,
		`rule-del:${spare}`,
		`route-del:${spare}`,
		`route-add:${spare}`,
		`rule-add:${spare}`,
		`route-add:${natural}`,
		`rule-add:${natural}`,
		"publish",
		"journal:2:temp",
		"journal:2:file-sync",
		"journal:2:rename",
		"journal:2:dir-sync",
		"available",
	]);
	for (const effect of [undefined, ...effects]) {
		await fixture(async (h) => {
			await h.apply([incumbent]);
			h.begin();
			if (effect !== undefined) {
				h.crashAt(effect);
				await expect(h.apply([joiner, incumbent]), effect).rejects.toBe(killed);
			}
			h.restart();
			await h.apply([incumbent, joiner]);
			expect(await h.image(), effect ?? "before intent").toEqual(finalImage);
			expect(h.routed(natural)).toBe("wwan1");
			expect(h.routed(spare)).toBe("wwan0");
		});
	}
});
