import { describe, expect, test } from "bun:test";
import { parseBothSlotStatus } from "../modules/system/update-orchestrator/slot-status.ts";
import { parseInstalledPackages } from "../modules/system/update-orchestrator/slot-sync-cleanup.ts";
import {
	buildIdFromOsRelease,
	syncReceiptSchema,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";

describe("image-owned slot-sync evidence", () => {
	test("reads the first os-release BUILD_ID and falls back to image-build-commit only when empty", () => {
		expect(
			buildIdFromOsRelease(
				'NAME=CeraLive\nBUILD_ID="release-1"\nBUILD_ID="release-2"\n',
				"fallback\n",
			),
		).toBe("release-1");
		expect(buildIdFromOsRelease('BUILD_ID=""\n', "fallback\n")).toBe(
			"fallback",
		);
		expect(buildIdFromOsRelease("NAME=CeraLive\n", "fallback\n")).toBe(
			"fallback",
		);
	});
	test("consumes the exact five receipt fields and refuses malformed SHA", () => {
		const receipt = {
			state_sha256: "a".repeat(64),
			build_id: "build-1",
			image_version: "2026.9.4",
			target_slot: "rootfs.1",
			completed_at: "2026-09-24T00:00:00Z",
		};
		expect(syncReceiptSchema.parse(receipt)).toEqual(receipt);
		expect(
			syncReceiptSchema.safeParse({ ...receipt, state_sha256: "bad" }).success,
		).toBe(false);
	});
	test("exposes both rootfs slots without widening the device-stats scalar", () => {
		const rauc = JSON.stringify({
			booted: "rootfs.0",
			slots: [
				{
					"rootfs.0": {
						class: "rootfs",
						bootname: "A",
						state: "booted",
						boot_status: "good",
						bundle: { version: "2026.9.4" },
					},
				},
				{
					"rootfs.1": {
						class: "rootfs",
						bootname: "B",
						state: "inactive",
						boot_status: "good",
						bundle: { version: "2026.8.1" },
					},
				},
				{ "certs.0": { class: "certs", state: "inactive" } },
			],
		});
		const receipt = {
			state_sha256: "a".repeat(64),
			build_id: "build-1",
			image_version: "2026.9.4",
			target_slot: "rootfs.1",
			completed_at: "2026-09-24T00:00:00Z",
		};
		expect(parseBothSlotStatus(rauc, receipt)).toEqual([
			{
				name: "rootfs.0",
				bootname: "A",
				state: "booted",
				bootStatus: "good",
				version: "2026.9.4",
				lastSyncedAt: null,
			},
			{
				name: "rootfs.1",
				bootname: "B",
				state: "inactive",
				bootStatus: "good",
				version: "2026.9.4",
				lastSyncedAt: "2026-09-24T00:00:00Z",
			},
		]);
		expect(parseBothSlotStatus(rauc, null)[1]?.version).toBe("2026.8.1");
		const replaced = JSON.stringify({
			slots: [
				{
					"rootfs.1": {
						class: "rootfs",
						state: "inactive",
						bundle: { version: "2026.11.0" },
						installed: { timestamp: "2026-11-01T00:00:00Z" },
					},
				},
			],
		});
		expect(parseBothSlotStatus(replaced, receipt)[0]?.version).toBe(
			"2026.11.0",
		);
	});
	test("reconciles only installed package versions, never a pending or removed one", () => {
		expect(
			parseInstalledPackages(
				"Package: cerastream\nStatus: install ok installed\nVersion: 2026.9.5\n\nPackage: old\nStatus: deinstall ok config-files\nVersion: 1.0\n\nPackage: held\nStatus: hold ok installed\nVersion: 2.0\n",
			),
		).toEqual([
			{ name: "cerastream", version: "2026.9.5" },
			{ name: "held", version: "2.0" },
		]);
	});
});
