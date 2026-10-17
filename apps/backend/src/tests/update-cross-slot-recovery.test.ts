import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toPersisted } from "../modules/system/update-orchestrator/persistence.ts";
import { recoverCrossSlot } from "../modules/system/update-orchestrator/recovery.ts";
import { sha256 } from "../modules/system/update-orchestrator/recovery-store.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	candidate,
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

describe("root-only cross-slot unresolved commit adjudication", () => {
	test("archives original bytes before clearing and requires a new discovery", async () => {
		const { identity, deps, dir } = fixture;
		const result = await recoverCrossSlot(identity, deps);
		const receipts = (await readdir(dir)).filter(
			(file) => file.startsWith("recovery-") && file.endsWith(".json"),
		);
		const record = JSON.parse(
			await readFile(join(dir, receipts[0] ?? ""), "utf8"),
		);
		expect(result.kind).toBe("cleared");
		expect(Buffer.from(record.planBase64, "base64").toString()).toBe(
			JSON.stringify(candidate),
		);
		expect(sha256(Buffer.from(record.agentBase64, "base64"))).toBe(
			identity.agentSha256,
		);
		expect((await readdir(dir)).includes("pending-packages.json")).toBe(false);
		const state = JSON.parse(await readFile(join(dir, "agent.json"), "utf8"));
		expect(state.phase).toBe("idle");
		expect(state.failureReason).toBeNull();
		expect(state.packageCheck.nextAttemptAt).toBeNull();
		expect(state.osCheck.nextAttemptAt).toBeNull();
	});

	for (const [reason, field] of [
		["root_required", "root"],
		["backend_must_be_inactive_and_runtime_masked", "stopped"],
		["commit_unit_must_be_absent", "unitAbsent"],
		["concurrent_operation", "idle"],
		["dpkg_dirty", "clean"],
		["candidate_installed_on_current_slot", "unapplied"],
		["lock_busy", "lock"],
	] as const) {
		test(`refuses ${reason} before recording or clearing`, async () => {
			const { flags, identity, deps, dir } = fixture;
			flags[field] = false;
			await expect(recoverCrossSlot(identity, deps)).rejects.toThrow(reason);
			expect(
				(await readdir(dir)).filter((file) => file.startsWith("recovery-")),
			).toEqual([]);
			expect(sha256(await readFile(join(dir, "agent.json")))).toBe(
				identity.agentSha256,
			);
		});
	}

	for (const field of ["bootId", "slot", "compatible", "osVersion"] as const) {
		test(`refuses wrong ${field}`, async () => {
			const { identity, deps, dir } = fixture;
			const changed = {
				...identity,
				[field]: {
					bootId: "ecbb01e5-9b0b-4eb9-a0d5-02bf68d123e5",
					slot: "rootfs.0",
					compatible: "wrong",
					osVersion: "2026.10.6",
				}[field],
			};
			await expect(recoverCrossSlot(changed, deps)).rejects.toThrow(
				field === "compatible" ? undefined : "boot_slot_or_os_changed",
			);
			expect(sha256(await readFile(join(dir, "agent.json")))).toBe(
				identity.agentSha256,
			);
		});
	}

	test("refuses changed agent hash without relaxing the exact failure reason", async () => {
		const { identity, deps, dir } = fixture;
		await writeFile(
			join(dir, "agent.json"),
			Buffer.from(
				JSON.stringify(
					toPersisted({
						...initialOrchestratorState(2),
						phase: "failed",
						failureReason: "commit_unit_absent_on_resume",
					}),
				),
			),
		);
		await expect(recoverCrossSlot(identity, deps)).rejects.toThrow(
			"agent_hash_mismatch",
		);
	});

	test("refuses wrong reason, changed plan and missing plan", async () => {
		const { identity, deps, dir } = fixture;
		await writeFile(
			join(dir, "agent.json"),
			Buffer.from(
				JSON.stringify(
					toPersisted({
						...initialOrchestratorState(1),
						phase: "failed",
						failureReason: "other",
					}),
				),
			),
		);
		await expect(recoverCrossSlot(identity, deps)).rejects.toThrow(
			"wrong_failure",
		);
		await writeFile(join(dir, "agent.json"), "{}");
		await expect(recoverCrossSlot(identity, deps)).rejects.toThrow();
		await writeFile(join(dir, "pending-packages.json"), "[]");
		await expect(recoverCrossSlot(identity, deps)).rejects.toThrow(
			"pending_plan_hash_mismatch",
		);
		await rm(join(dir, "pending-packages.json"));
		await expect(recoverCrossSlot(identity, deps)).rejects.toThrow(
			"pending_plan_missing",
		);
	});
});
