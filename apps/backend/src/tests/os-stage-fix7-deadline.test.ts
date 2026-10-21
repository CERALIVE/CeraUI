import { afterEach, expect, jest, test } from "bun:test";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

useSessionOwnerForFile();
afterEach(() => {
	jest.useRealTimers();
});

test.each(["admission", "revalidation", "selection", "receipt", "release"])(
	"bounds outer %s and rejects its late continuation",
	async (boundary) => {
		// Given a controlled clock with 40 ms of the original recovery budget left.
		const h = await harness();
		jest.useFakeTimers();
		let now = 0;
		let recovered = false;
		let revalidations = 0;
		let selections = 0;
		const held = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const hold = async () => {
			reached.resolve();
			await held.promise;
		};
		const work = runOsStageJob(manifest, h.control, {
			...h.deps,
			now: () => now,
			restart: async () => {
				await h.deps.restart();
				now = 359_960;
			},
			observe: async (...args) => {
				const snapshot = await h.deps.observe(...args);
				if (now) recovered = true;
				return snapshot;
			},
			blocked: async () => {
				if (recovered && boundary === "admission") await hold();
				return false;
			},
			revalidate: async () => {
				if (++revalidations === 2 && boundary === "revalidation") await hold();
			},
			selection: async () => {
				if (++selections === 2 && boundary === "selection") await hold();
				return h.deps.selection();
			},
			prepareReceipt: async () => {
				if (boundary === "receipt" || boundary === "release") now += 359_960;
				if (boundary === "receipt") await hold();
				return h.deps.prepareReceipt();
			},
			owner: (record) => {
				const owner = h.deps.owner(record);
				return {
					...owner,
					release: async (...args) => {
						if (boundary === "release") await hold();
						await owner.release(...args);
					},
				};
			},
		});
		const settled = work.then(
			() => "published",
			(error: unknown) => error,
		);
		await reached.promise;
		// When the port is still held beyond the remaining deadline.
		now += 40;
		jest.advanceTimersByTime(40);
		const result = await settled;
		try {
			expect(result).toHaveProperty("mode", "unsafe");
			expect(h.events).not.toContain("release");
			expect(h.events).not.toContain("receipt+serial+OS_STAGED");
		} finally {
			held.resolve();
		}
		// Then resuming the stale operation cannot dispatch or publish after settlement.
		await settled;
		jest.useRealTimers();
		await Bun.sleep(0);
		expect(h.attempts()).toBe(
			boundary === "receipt" || boundary === "release" ? 2 : 1,
		);
		expect(h.events).not.toContain("release");
		expect(h.events).not.toContain("receipt+serial+OS_STAGED");
	},
);
