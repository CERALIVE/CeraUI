import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aptRoutingFileStore } from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import { routingFake } from "./helpers/d13-fix-routing-fake.ts";

const phases = [
	"before-0",
	"after-0",
	"before-1",
	"after-1",
	"before-2",
	"after-2",
	"before-3",
	"after-3",
	"step",
];
test.each(phases)(
	"restart reconciles exact intents after SIGKILL at %s",
	async (phase) => {
		// Given a real child paused before/after every routing installation boundary.
		const dir = await mkdtemp(join(tmpdir(), "d13-routing-death-"));
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "helpers/d13-routing-child.ts"),
				dir,
				phase,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		try {
			const reader = child.stdout.getReader();
			let text = "";
			while (!text.includes("READY\n")) {
				const part = await reader.read();
				if (part.done)
					throw new Error(
						`child exited before boundary: ${await new Response(child.stderr).text()}`,
					);
				text += new TextDecoder().decode(part.value);
			}
			// When the process dies with durable intents and fake kernel state surviving.
			child.kill("SIGKILL");
			await child.exited;
			const fake = await routingFake(join(dir, "kernel.json"));
			const store = aptRoutingFileStore(join(dir, "journal.json"));
			const owner = createAptRoutingOwnership(store);
			await expect(owner.acquire(fake.runner, 42042)).rejects.toHaveProperty(
				"reason",
				"cleanup-pending",
			);
			const clean = await owner.acquire(fake.runner, 42042);
			clean.release();
			// Then all exact owned effects are gone and a second recovery has no residue.
			expect(fake.state).toEqual({ rules: [], tables: [] });
			expect(await store.read()).toEqual([]);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			await rm(dir, { recursive: true, force: true });
		}
	},
	10_000,
);

test("routing fake models Linux one-match deletion and explicit absence", async () => {
	// Given two duplicate rules in the fake kernel.
	const dir = await mkdtemp(join(tmpdir(), "d13-routing-fake-"));
	try {
		const fake = await routingFake(join(dir, "kernel.json"));
		const tokens = [
			"rule",
			"add",
			"priority",
			"120",
			"uidrange",
			"42042-42042",
			"prohibit",
		];
		await fake.runner("ip", tokens);
		await fake.runner("ip", tokens);
		// When one delete is submitted.
		const deletion = ["rule", "del", ...tokens.slice(2)];
		await fake.runner("ip", deletion);
		// Then one duplicate remains, and deleting an absent entry rejects explicitly.
		expect(fake.state.rules).toHaveLength(1);
		await fake.runner("ip", deletion);
		await expect(fake.runner("ip", deletion)).rejects.toHaveProperty(
			"stderr",
			"RTNETLINK answers: No such file or directory\n",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
