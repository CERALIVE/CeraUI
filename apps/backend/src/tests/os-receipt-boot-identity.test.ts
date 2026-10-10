import { expect, test } from "bun:test";
import { stagedReceiptConsumed } from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";

const bootId = "29dd9a67-91db-412a-8729-accdb5825369";
const installedImage = {
	slot: "rootfs.0",
	bundleHash: "a".repeat(64),
	checksum: "b".repeat(64),
	installedAt: "2026-10-08T12:54:01Z",
	installedCount: 7,
};
const evidence = {
	receipt: {
		schema: 1 as const,
		version: "2026.10.68",
		channel: "drill" as const,
		stagedAt: 1791464043236,
		bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	},
	phase: "failed" as const,
	activeAttemptId: null,
	bootedVersion: "2026.10.68",
	bootId,
	healthyBootId: bootId,
	activationArmed: false,
	raucOperation: "idle" as const,
	bootedImage: installedImage,
};

test("keeps a legacy receipt when a valid stamp names an unactivated install", () => {
	// Given the board booted the previous image but the stamp says .68.
	// When a legacy .68 receipt has no binding to the booted image.
	const consumed = stagedReceiptConsumed(evidence);
	// Then stamp equality cannot authorize destructive cleanup.
	expect(consumed).toBe(false);
});

test.each([
	"slot",
	"bundleHash",
	"checksum",
	"installedAt",
	"installedCount",
] as const)("keeps a bound receipt when booted %s differs", (field) => {
	// Given a new receipt binding the candidate to a different installation.
	const changed = {
		...installedImage,
		[field]: field === "installedCount" ? 8 : "different",
	};
	const current = {
		...evidence,
		receipt: { ...evidence.receipt, installedImage },
		bootedImage: changed,
	};
	// When the stamp incorrectly agrees with the candidate's CalVer.
	const consumed = stagedReceiptConsumed(current);
	// Then the independent image identity vetoes retirement.
	expect(consumed).toBe(false);
});
