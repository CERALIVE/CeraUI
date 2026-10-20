import { expect, test } from "bun:test";
import { parseInstalledImage } from "../modules/system/update-orchestrator/os-installed-image.ts";
import { stagedReceiptConsumed } from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import fixture from "./fixtures/real-device/rock-admission-20261009.json";

const stdout =
	fixture.commands["rauc status --detailed --output-format=json"].stdout;

test("reads image-byte identity from the unchanged real Rock status", () => {
	// Given the real bundle version is a commit abbreviation, not CalVer.
	// When the booted slot's recorded installation is parsed.
	const selected = parseInstalledImage(stdout, "booted");
	// Then exact image bytes and install identity survive, without a version guess.
	expect(selected?.identity).toEqual({
		slot: "rootfs.0",
		bundleHash:
			"1a60254de15c639431b3038e3050597e70b629e1db2e8b2b5ae642927c83d4a8",
		checksum:
			"c00130526707daf2c71c13a5cc97019d5be5e828588a44b8f4d95b680b1ce11e",
		installedAt: "2026-10-08T12:54:01Z",
		installedCount: 7,
	});
});

test("keeps the legacy Rock receipt despite stamp equality and healthy boot", () => {
	// Given the exact old receipt does not record installed image identity.
	const receipt = {
		schema: 1 as const,
		version: "2026.10.64",
		channel: "drill" as const,
		stagedAt: 1791464043236,
		bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	};
	// When all present real evidence is evaluated.
	const consumed = stagedReceiptConsumed({
		receipt,
		phase: "failed",
		activeAttemptId: null,
		bootedVersion: receipt.version,
		bootId: fixture.bootId,
		healthyBootId: fixture.healthy.boot_id,
		activationArmed: false,
		raucOperation: "idle",
		bootedImage: parseInstalledImage(stdout, "booted")?.identity,
	});
	// Then timestamp correlation cannot bind the receipt to the image.
	expect(consumed).toBe(false);
});

test("retires only a receipt positively bound to the booted installation", () => {
	// Given a new receipt captured the exact installed identity after success.
	const installedImage = parseInstalledImage(stdout, "booted")?.identity;
	if (!installedImage) throw new Error("real fixture lacks identity");
	const receipt = {
		schema: 1 as const,
		version: "2026.10.64",
		channel: "drill" as const,
		stagedAt: 1791464043236,
		bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
		installedImage,
	};
	// When that installation is now the healthy booted image.
	const consumed = stagedReceiptConsumed({
		receipt,
		phase: "failed",
		activeAttemptId: null,
		bootedVersion: receipt.version,
		bootId: fixture.bootId,
		healthyBootId: fixture.healthy.boot_id,
		activationArmed: false,
		raucOperation: "idle",
		bootedImage: installedImage,
	});
	// Then bundle commit/CalVer naming differences do not block positive proof.
	expect(consumed).toBe(true);
});
