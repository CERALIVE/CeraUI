import { describe, expect, test } from "bun:test";
import {
	type SlotSyncGate,
	type SlotSyncGateInput,
	slotSyncGate,
} from "../modules/system/update-orchestrator/slot-sync-gate.ts";

const healthy = {
	boot_id: "boot-b",
	slot: "A",
	build_id: "build-2",
	dpkg_status_sha256: "b".repeat(64),
	recorded_at: "2026-09-24T00:00:00Z",
};
const eligible: SlotSyncGateInput = {
	capabilities: {
		mode: "capable",
		features: ["apt-all-packages", "slot-sync"],
	},
	healthyState: healthy,
	bootId: "boot-b",
	statusSha256: healthy.dpkg_status_sha256,
	buildId: healthy.build_id,
	receiptStateSha256: "a".repeat(64),
	phase: "idle",
};

describe("lagged mirror gate table", () => {
	test("allows a healthchecked, not-yet-mirrored state", () => {
		expect(slotSyncGate(eligible)).toEqual({ allowed: true });
		expect(slotSyncGate({ ...eligible, receiptStateSha256: null })).toEqual({
			allowed: true,
		});
	});
	const rows: ReadonlyArray<{
		readonly name: string;
		readonly input: SlotSyncGateInput;
		readonly reason: Extract<
			SlotSyncGate,
			{ readonly allowed: false }
		>["reason"];
	}> = [
		{
			name: "capability",
			input: {
				...eligible,
				capabilities: { mode: "legacy", features: ["slot-sync"] },
			},
			reason: "capability-absent",
		},
		{
			name: "boot",
			input: { ...eligible, bootId: "boot-a" },
			reason: "not-yet-booted",
		},
		{
			name: "packages",
			input: { ...eligible, statusSha256: "c".repeat(64) },
			reason: "packages-changed",
		},
		{
			name: "build",
			input: { ...eligible, buildId: "build-3" },
			reason: "build-changed",
		},
		{
			name: "receipt",
			input: { ...eligible, receiptStateSha256: healthy.dpkg_status_sha256 },
			reason: "already-synced",
		},
		{
			name: "OS",
			input: { ...eligible, phase: "os-staging" },
			reason: "os-install-pending",
		},
		{
			name: "lock",
			input: { ...eligible, phase: "committing" },
			reason: "update-busy",
		},
		{
			name: "already syncing",
			input: { ...eligible, phase: "syncing" },
			reason: "already-syncing",
		},
	];
	for (const { name, input, reason } of rows) {
		test(`refuses ${name} alone`, () => {
			expect(slotSyncGate(input)).toEqual({ allowed: false, reason });
		});
	}
	test("a commit without a subsequent healthchecked reboot is not-yet-booted", () => {
		expect(slotSyncGate({ ...eligible, healthyState: null })).toEqual({
			allowed: false,
			reason: "not-yet-booted",
		});
	});
	test("all pending OS and package-lock phases refuse independently", () => {
		for (const phase of [
			"os-staged",
			"os-activation-armed",
			"os-verifying",
		] as const)
			expect(slotSyncGate({ ...eligible, phase })).toEqual({
				allowed: false,
				reason: "os-install-pending",
			});
		for (const phase of [
			"awaiting-idle",
			"downloading",
			"restarting-services",
		] as const)
			expect(slotSyncGate({ ...eligible, phase })).toEqual({
				allowed: false,
				reason: "update-busy",
			});
	});
	test("a stream is not an input to the local mirror gate", () => {
		expect(slotSyncGate({ ...eligible, phase: "sync-eligible" })).toEqual({
			allowed: true,
		});
	});
});
