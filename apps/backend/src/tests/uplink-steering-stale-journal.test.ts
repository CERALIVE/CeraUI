import { expect, test } from "bun:test";
import type { PreparedSteeringState } from "../modules/network/uplink-steering/applier.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import {
	device,
	link,
	shared,
	x,
	z,
} from "./uplink-steering-stale-journal-fixtures.ts";

test.each([
	["source address", "skipped write"],
	["source address", "failed read after a restart"],
	["re-created netdev", "skipped write"],
	["re-created netdev", "failed read after a restart"],
] as const)(
	"a %s change the journal missed (%s) does not let a later twin reset the incumbent",
	async (change, fault) => {
		await device(async (h) => {
			let marks = h.lifecycle();
			let applied: PreparedSteeringState | undefined = await h.step(
				marks,
				undefined,
				[x, z],
			);
			h.address.set("wwan0", "100.64.0.99");
			if (change === "re-created netdev") h.index.set("wwan0", 180);
			if (fault === "skipped write") h.failNextSave();
			else {
				marks = h.lifecycle();
				applied = undefined;
				h.failObservations(1);
			}
			applied = await h.step(marks, applied, [x, z]);
			h.flows.add(shared);
			h.resets.length = 0;

			await h.step(marks, applied, [x, z, link("id-y", "wwan2", shared)]);
			expect(h.route(shared)).toBe("wwan0");
			expect(h.resets).not.toContain(shared);
			expect(h.flows.has(shared)).toBe(true);
		});
	},
);

test.each([false, true])(
	"a skipped departure write never guards the next same-mark link (restart: %p)",
	async (restart) => {
		await device(async (h) => {
			let marks = h.lifecycle();
			const before = await h.step(marks, undefined, [x, z]);
			h.failNextSave();
			let applied: PreparedSteeringState | undefined = await h.step(
				marks,
				before,
				[z],
			);
			if (restart) {
				marks = h.lifecycle();
				applied = undefined;
			}
			await h.step(marks, applied, [z, link("id-w", "wwan2", shared)]);
			expect(h.route(shared)).toBe("wwan2");
			expect({ kernel: h.guarded(), marks: marks.guarded }).toEqual({
				kernel: false,
				marks: false,
			});
		});
	},
);

test("a same-boot downgrade that replaced the owner leaves its successor alone", async () => {
	await device(async (h) => {
		await h.step(h.lifecycle(), undefined, [x, z]);
		const w = link("id-w", "wwan2", shared);
		await h.mainApplier().apply(undefined, h.plan([z, w]));
		h.flows.add(shared);
		h.resets.length = 0;

		await h.step(h.lifecycle(), undefined, [z, w]);
		expect(h.route(shared)).toBe("wwan2");
		expect(h.resets).not.toContain(shared);
		expect(h.guarded()).toBe(false);
	});
});

test("a contender parked by a one-shot fault is rechecked without a new network event", async () => {
	await device(async (h) => {
		const marks = h.lifecycle();
		const rechecks: { run: () => Promise<void>; delay: number }[] = [];
		const published: string[] = [];
		let links = [x, z];
		const coordinator = new UplinkSteeringCoordinator({
			readDesiredState: async () => {
				const assigned = await marks.marks(links);
				return h.plan(
					links.flatMap((uplink) => {
						const mark = assigned.get(uplink.identity);
						return mark === undefined ? [] : [{ ...uplink, mark }];
					}),
				);
			},
			apply: (previous, next) => marks.apply(previous, next),
			hasPendingApply: () => marks.pending,
			needsRecheck: () => marks.blocked || marks.unverified,
			publishAvailability: (status) =>
				published.push(
					!status.available
						? status.reason
						: marks.blocked
							? "mark_collision"
							: "available",
				),
			waitBeforeRetry: async () => undefined,
			schedule: (run, delay) => {
				rechecks.push({ run, delay });
				return () => undefined;
			},
		});
		await coordinator.requestReconcile();
		links = [x, z, link("id-y", "wwan2", shared)];
		h.failObservations(1);
		await coordinator.requestReconcile();
		expect(published.at(-1)).toBe("mark_collision");
		expect(h.route(0xca123500)).toBeUndefined();

		expect(rechecks.map(({ delay }) => delay)).toEqual([5_000]);
		await rechecks[0]?.run();
		expect(published.at(-1)).toBe("available");
		expect({ x: h.route(shared), y: h.route(0xca123500) }).toEqual({
			x: "wwan0",
			y: "wwan2",
		});
		expect(rechecks).toHaveLength(1);
	});
});
