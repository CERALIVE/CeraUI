import { expect, test } from "bun:test";
import { AptRoutingRefusal } from "../modules/system/apt-routing-ownership.ts";
import { withRoutingScenario } from "./helpers/d13-routing-scenario.ts";

test("journals every intent before its routing effect", async () => {
	// Given an empty journal and kernel port.
	await withRoutingScenario(async (h) => {
		// When all installs and normal cleanup run.
		expect(await h.run()).toBe("ok");
		// Then each effect saw durable authority and retirement leaves no state.
		expect(h.journaled()).toBe(true);
		expect(await h.disk.read()).toEqual([]);
		expect(h.fake.state).toEqual({ rules: [], tables: [] });
	});
});

test("cleans an applied rule whose add acknowledgement was lost", async () => {
	// Given a lookup add which applies before rejecting.
	await withRoutingScenario(async (h) => {
		h.fault.lostAck = true;
		// When the attempt fails before transfer entry.
		const failed = h.run();
		await expect(failed).rejects.toBeInstanceOf(AptRoutingRefusal);
		await expect(failed).rejects.toHaveProperty("reason", "operation-failed");
		await expect(failed).rejects.toHaveProperty(
			"cause.message",
			"add acknowledgement lost",
		);
		// Then the journal still authorized exact cleanup.
		expect(h.fake.state).toEqual({ rules: [], tables: [] });
		expect(await h.disk.read()).toEqual([]);
	});
});

test.each(["transient", "persistent"])(
	"retains %s teardown failure behind admission",
	async (deletion) => {
		// Given a failed other-family deletion.
		await withRoutingScenario(async (h) => {
			h.fault.deletion = deletion;
			await expect(h.run()).rejects.toHaveProperty("reason", "cleanup-pending");
			let dispatched = false;
			// When another transaction is submitted.
			await expect(
				h.run(async () => {
					dispatched = true;
					return "bad";
				}),
			).rejects.toBeInstanceOf(Error);
			// Then no new work is admitted; a persistent failure keeps exact intent.
			expect(dispatched).toBe(false);
			expect((await h.disk.read()).length).toBe(
				deletion === "persistent" ? 1 : 0,
			);
			expect(h.fake.state.rules.length).toBe(deletion === "persistent" ? 1 : 0);
		});
	},
);

test.each([false, true])(
	"refuses effects after journal write failure (renamed=%s)",
	async (afterWrite) => {
		// Given failure at the first write, optionally after durable publication.
		await withRoutingScenario(async (h) => {
			h.fault.write = 1;
			h.fault.afterWrite = afterWrite;
			// When installation is attempted.
			await expect(h.run()).rejects.toBeInstanceOf(Error);
			// Then nothing was installed, and a recovery-only admission precedes retry.
			expect(h.commands.some((line) => line.includes(" add "))).toBe(false);
			await expect(h.run()).rejects.toHaveProperty("reason", "cleanup-pending");
			expect(await h.run()).toBe("ok");
		});
	},
);

test.each([false, true])(
	"retains journal retirement failure (renamed=%s)",
	async (afterWrite) => {
		// Given failure acknowledging the first successful delete's journal update.
		await withRoutingScenario(async (h) => {
			h.fault.write = 5;
			h.fault.afterWrite = afterWrite;
			// When cleanup encounters the write fault.
			await expect(h.run()).rejects.toHaveProperty("reason", "cleanup-pending");
			// Then admission reconciles without repeating transfer and later retry works.
			await expect(h.run()).rejects.toHaveProperty("reason", "cleanup-pending");
			expect(await h.run()).toBe("ok");
			expect(await h.disk.read()).toEqual([]);
		});
	},
);

test("reloads retained ownership after restart and reconciles idempotently", async () => {
	// Given failed cleanup persisted on disk, with another owner clearing the kernel rule.
	await withRoutingScenario(async (h) => {
		h.fault.deletion = "persistent";
		await expect(h.run()).rejects.toHaveProperty("reason", "cleanup-pending");
		h.fault.deletion = "none";
		h.fake.state.rules.length = 0;
		h.restart();
		// When the fresh owner encounters the journal, it performs recovery only.
		await expect(h.run()).rejects.toHaveProperty("reason", "cleanup-pending");
		// Then repeated clean admissions do not repeat stale cleanup or retain state.
		expect(await h.run()).toBe("ok");
		expect(await h.run()).toBe("ok");
		expect(await h.disk.read()).toEqual([]);
		expect(h.fake.state).toEqual({ rules: [], tables: [] });
	});
});

test("leaves foreign UID rules and nonjournaled table routes untouched", async () => {
	// Given foreign state appears alongside the owned routes during a step.
	await withRoutingScenario(async (h) => {
		const rule = "6:priority 120 uidrange 49999-49999 prohibit";
		const route = "4:default dev foreign0 table 100000 metric 17";
		// When exact owned cleanup runs.
		await h.run(async () => {
			h.fake.state.rules.push(rule);
			h.fake.state.tables.push(route);
			return "ok";
		});
		// Then neither a foreign rule nor a foreign route was deleted or flushed.
		expect(h.fake.state).toEqual({ rules: [rule], tables: [route] });
		expect(h.commands.some((line) => line.includes("route flush"))).toBe(false);
		await expect(h.run()).rejects.toHaveProperty("reason", "unjournaled-state");
	});
});

test("refuses shape-matching reserved rules without adopting them", async () => {
	// Given a matching rule with no APT journal authority.
	await withRoutingScenario(async (h) => {
		const rule = "6:priority 120 uidrange 42042-42042 prohibit";
		h.fake.state.rules.push(rule);
		// When admission checks the existing state.
		await expect(h.run()).rejects.toHaveProperty("reason", "unjournaled-state");
		// Then only the existing OS sweep may handle it, not APT.
		expect(h.fake.state.rules).toEqual([rule]);
		expect(h.commands.some((line) => line.includes(" del "))).toBe(false);
	});
});
