import { expect, test } from "bun:test";
import {
	fixture,
	type harness,
	incumbent,
	joiner,
	killed,
	natural,
	replacement,
	spare,
} from "./uplink-steering-collision-test-fixtures.ts";

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
