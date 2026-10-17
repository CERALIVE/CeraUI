import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	RecoveryRefusal,
	recoverCrossSlot,
} from "../modules/system/update-orchestrator/recovery.ts";
import { sha256 } from "../modules/system/update-orchestrator/recovery-store.ts";
import {
	createRecoveryFixture,
	type RecoveryFixture,
} from "./update-cross-slot-fixture.ts";

let fixture: RecoveryFixture;
beforeEach(async () => {
	fixture = await createRecoveryFixture();
});
afterEach(async () => {
	await fixture.close();
});

describe("receipt and archive crash boundaries", () => {
	for (const boundary of [
		"after-receipt",
		"after-archive",
		"before-transition",
		"after-transition",
	] as const) {
		test(`replays ${boundary} crash with one immutable receipt`, async () => {
			const { identity, dir } = fixture;
			const original = fixture.deps.store;
			let fired = false;
			const deps = {
				...fixture.deps,
				store: {
					...original,
					writeReceipt: async (
						receipt: Parameters<typeof original.writeReceipt>[0],
					) => {
						await original.writeReceipt(receipt);
						if (boundary === "after-receipt" && !fired) {
							fired = true;
							throw new RecoveryRefusal("injected_crash");
						}
					},
					archivePlan: async () => {
						await original.archivePlan();
						if (boundary === "after-archive" && !fired) {
							fired = true;
							throw new RecoveryRefusal("injected_crash");
						}
					},
					writeState: async (bytes: Buffer) => {
						if (boundary === "before-transition" && !fired) {
							fired = true;
							throw new RecoveryRefusal("injected_crash");
						}
						await original.writeState(bytes);
						if (boundary === "after-transition" && !fired) {
							fired = true;
							throw new RecoveryRefusal("injected_crash");
						}
					},
				},
			};
			await expect(recoverCrossSlot(identity, deps)).rejects.toThrow(
				"injected_crash",
			);
			if (boundary !== "after-transition")
				expect(sha256(await readFile(join(dir, "agent.json")))).toBe(
					identity.agentSha256,
				);
			await recoverCrossSlot(identity, deps);
			expect((await recoverCrossSlot(identity, deps)).kind).toBe(
				"already-cleared",
			);
			expect(
				(await readdir(dir)).filter(
					(file) => file.startsWith("recovery-") && file.endsWith(".json"),
				),
			).toHaveLength(1);
		});
	}

	test("receipt-first crash cannot finish after the backend restarts", async () => {
		const original = fixture.deps.store;
		const deps = {
			...fixture.deps,
			store: {
				...original,
				writeReceipt: async (
					receipt: Parameters<typeof original.writeReceipt>[0],
				) => {
					await original.writeReceipt(receipt);
					throw new RecoveryRefusal("injected_crash");
				},
			},
		};
		await expect(recoverCrossSlot(fixture.identity, deps)).rejects.toThrow(
			"injected_crash",
		);
		fixture.flags.stopped = false;
		await expect(recoverCrossSlot(fixture.identity, deps)).rejects.toThrow(
			"backend_must_be_inactive_and_runtime_masked",
		);
		expect((await readdir(fixture.dir)).includes("pending-packages.json")).toBe(
			true,
		);
	});
});
