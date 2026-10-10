import { expect, test } from "bun:test";
import { parkedDrain } from "./helpers/os-stage-fix8-drain.ts";

test.each(["ownership", "final-show"] as const)(
	"retained drainage refuses late %s without remembering or tearing down routes",
	async (boundary) => {
		// Given an expired job parked in the real pin controller and production observer.
		const h = await parkedDrain(boundary);
		try {
			expect(
				await Promise.race([
					h.entered.promise.then(() => "entered"),
					h.startup.then(() => "settled-before-drain"),
				]),
			).toBe("entered");
			// When reconciliation expires at the selected awaited boundary.
			expect(
				await Promise.race([h.startup, Bun.sleep(160).then(() => "pending")]),
			).toHaveProperty("mode", "unsafe");
			expect(h.controlHeld()).toBe(false);
			const commands = h.h.events.length;
			const remembered = h.remember();
			if (boundary === "ownership") h.introduceChild();
			h.gate.resolve();
			await Bun.sleep(0);
			// Then the late observer cannot persist evidence or submit routing teardown.
			expect(h.remember()).toBe(remembered);
			expect(h.h.events.length).toBe(commands);
			expect(h.h.events).not.toContain("release");
		} finally {
			await h.cleanup();
		}
	},
);

test("retained drainage observes a live child after awaited ownership before releasing the pin", async () => {
	// Given a quiet earlier snapshot and a held ownership read within a fresh budget.
	const h = await parkedDrain("ownership", false);
	try {
		expect(
			await Promise.race([
				h.entered.promise.then(() => "entered"),
				h.startup.then(() => "settled-before-drain"),
			]),
		).toBe("entered");
		const commands = h.h.events.length;
		// When a real Bash child joins before ownership preparation completes.
		h.introduceChild();
		h.gate.resolve();
		expect(await h.startup).toHaveProperty("mode", "unsafe");
		// Then final physical evidence refuses routing release, despite the earlier quiet snapshot.
		expect(h.h.events.length).toBe(commands);
		expect(h.h.events).not.toContain("release");
	} finally {
		await h.cleanup();
	}
});
