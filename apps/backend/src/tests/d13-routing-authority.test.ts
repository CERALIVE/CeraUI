import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AptRoutingEntry,
	aptRoutingFileStore,
} from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";

const rules: readonly AptRoutingEntry[] = [4, 6].map((family) => ({
	family: family === 4 ? 4 : 6,
	args: [
		"rule",
		"add",
		"priority",
		"120",
		"uidrange",
		"42042-42042",
		"prohibit",
	],
}));

test("reconciliation spends one shared deadline and dispatches nothing at exact expiry", async () => {
	// Given two durable intents and a command consuming the entire recovery budget.
	const dir = await mkdtemp(join(tmpdir(), "d13-budget-"));
	try {
		const store = aptRoutingFileStore(join(dir, "journal.json"));
		store.save(rules);
		let now = 0;
		const timeouts: (number | undefined)[] = [];
		const owner = createAptRoutingOwnership(store, () => now);
		// When the first exact delete completes at the deadline.
		await expect(
			owner.acquire(async (_bin, _args, options) => {
				timeouts.push(options?.timeout);
				now = 10_000;
				return "";
			}, 42042),
		).rejects.toHaveProperty("reason", "cleanup-pending");
		// Then the next entry remains owned and no second delete is dispatched.
		expect(timeouts).toEqual([10_000]);
		expect(await store.read()).toEqual(rules.slice(0, 1));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.each([
	'{"schema":1,"entries":[],"extra":true}',
	'{"schema":1,"schema":1,"entries":[]}',
	'{"schema":1,"entries":[{"family":4,"args":["route","add","default","dev","eth0","table","main","metric","0"]}]}',
	'{"schema":1,"entries":[{"family":4,"args":["rule","add","priority","120","uidrange","0-0","prohibit"]}]}',
	'{"schema":1,"entries":',
])(
	"invalid journal authority never reaches a routing port (%#)",
	async (raw) => {
		// Given untrusted journal bytes outside the closed authority schema.
		const dir = await mkdtemp(join(tmpdir(), "d13-authority-"));
		try {
			const path = join(dir, "journal.json");
			await Bun.write(path, raw);
			let calls = 0;
			// When a new process-local owner parses them.
			await expect(
				createAptRoutingOwnership(aptRoutingFileStore(path)).acquire(
					async () => {
						calls++;
						return "";
					},
					42042,
				),
			).rejects.toHaveProperty("reason", "journal-unavailable");
			// Then no query or mutation is submitted, and evidence is not rewritten.
			expect(calls).toBe(0);
			expect(await Bun.file(path).text()).toBe(raw);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("one owner fences overlapping APT acquisitions until release", async () => {
	// Given one admitted APT routing lease.
	const owner = createAptRoutingOwnership({
		read: async () => [],
		save: () => {},
	});
	const runner = async () => "";
	const lease = await owner.acquire(runner, 42042);
	// When another transaction asks for the same ownership lifetime.
	await expect(owner.acquire(runner, 42042)).rejects.toHaveProperty(
		"reason",
		"busy",
	);
	// Then releasing the original owner permits a clean admission.
	lease.release();
	(await owner.acquire(runner, 42042)).release();
});
