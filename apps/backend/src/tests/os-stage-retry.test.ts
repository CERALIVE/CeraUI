import { describe, expect, test } from "bun:test";
import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	type OsStageSettlementEvidence,
	osStageCandidateKey,
	osStageCandidateVersion,
	osStageFailureSettledSafely,
	osStagePermission,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";

const manifest = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
});
const KEY = osStageCandidateKey(manifest);

function record(overrides: Partial<OsStageRecovery> = {}): OsStageRecovery {
	return {
		candidateKey: KEY,
		activeAttemptId: null,
		failedRounds: 1,
		nextRetryAt: 1_000,
		mode: "automatic",
		reason: "os_transport_failed",
		...overrides,
	};
}

describe("OS stage candidate identity", () => {
	test("a republished pointer for the same version is a different candidate", () => {
		const reissued = osStageCandidateKey({ ...manifest, serial: 4 });
		const rebuilt = osStageCandidateKey({
			...manifest,
			bundle: { ...manifest.bundle, sha256: "d".repeat(64) },
		});
		expect(new Set([KEY, reissued, rebuilt]).size).toBe(3);
		expect(osStageCandidateVersion(KEY)).toBe("2026.10.0");
	});
});

describe("OS stage permission", () => {
	test("an unknown or superseded candidate stages as a fresh round", () => {
		expect(osStagePermission(undefined, KEY, 0, false)).toBe("fresh");
		expect(
			osStagePermission(
				record({ candidateKey: "other", mode: "operator" }),
				KEY,
				0,
				false,
			),
		).toBe("fresh");
	});

	test("an automatic retry waits for its deadline, then retries", () => {
		expect(osStagePermission(record(), KEY, 999, false)).toBe("wait");
		expect(osStagePermission(record(), KEY, 1_000, false)).toBe("retry");
	});

	test("an operator pause never stages automatically but a manual install may", () => {
		const paused = record({ mode: "operator", nextRetryAt: null });
		expect(osStagePermission(paused, KEY, 9e12, false)).toBe("paused");
		expect(osStagePermission(paused, KEY, 0, true)).toBe("retry");
	});

	test("an unsafe record permits nothing, not even a manual install", () => {
		expect(osStagePermission(record({ mode: "unsafe" }), KEY, 9e12, true)).toBe(
			"paused",
		);
	});
});

describe("positive proof that a failed stage settled safely", () => {
	const proof: OsStageSettlementEvidence = {
		raucOperation: "idle",
		writerQuiescent: true,
		rootSlots: [
			{
				name: "rootfs.0",
				bootname: "A",
				state: "booted",
				bootStatus: "good",
				version: null,
				lastSyncedAt: null,
			},
			{
				name: "rootfs.1",
				bootname: "B",
				state: "inactive",
				bootStatus: "bad",
				version: null,
				lastSyncedAt: null,
			},
		],
		healthyBootId: "boot-1",
		bootId: "boot-1",
		stagedReceiptPresent: false,
		activationArmed: false,
	};

	test("the r6 end state is proof", () => {
		expect(osStageFailureSettledSafely(proof)).toBe(true);
	});

	test.each([
		["RAUC still running", { raucOperation: "running" as const }],
		["a surviving writer", { writerQuiescent: false }],
		["a staged receipt", { stagedReceiptPresent: true }],
		["an armed activation", { activationArmed: true }],
		["no healthy record", { healthyBootId: null }],
		["a healthy record from another boot", { healthyBootId: "boot-0" }],
	])("%s is not proof", (_label, change) => {
		expect(osStageFailureSettledSafely({ ...proof, ...change })).toBe(false);
	});

	test("a good inactive target is not proof: it may be an unrecorded stage", () => {
		expect(
			osStageFailureSettledSafely({
				...proof,
				rootSlots: proof.rootSlots.map((slot) =>
					slot.state === "inactive" ? { ...slot, bootStatus: "good" } : slot,
				),
			}),
		).toBe(false);
	});

	test("an unhealthy booted slot is not proof", () => {
		expect(
			osStageFailureSettledSafely({
				...proof,
				rootSlots: proof.rootSlots.map((slot) =>
					slot.state === "booted" ? { ...slot, bootStatus: "bad" } : slot,
				),
			}),
		).toBe(false);
	});
});
