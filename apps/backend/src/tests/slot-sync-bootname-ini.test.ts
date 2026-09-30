import { describe, expect, test } from "bun:test";
import {
	type HealthySlotState,
	slotSyncGate,
} from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	classifyReceiptTarget,
	parseRaucSlotBootnames,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";

// N4 (round 13): /etc/rauc/system.conf is a GLib key file, which accepts
// whitespace around the `=` delimiter. A literal `bootname=` match read
// `bootname = A` as no mapping at all.

const expected = new Map([
	["rootfs.0", "A"],
	["rootfs.1", "B"],
]);
const canonical = `[system]
compatible=ceralive-rk3588
bootloader=custom

[slot.rootfs.0]
device=/dev/disk/by-partlabel/rootfs_a
type=ext4
bootname=A

[slot.rootfs.1]
device=/dev/disk/by-partlabel/rootfs_b
type=ext4
bootname=B

[slot.certs.0]
device=/data/ceralive/certs/.rauc-certs-slot
type=raw
`;
const spaced = canonical.replaceAll("bootname=", "bootname = ");
const payloads: ReadonlyArray<readonly [string, string]> = [
	["canonical", canonical],
	["spaced", spaced],
	["tab-separated", canonical.replaceAll("bootname=", "bootname\t=\t")],
	[
		"indented and trailing blanks",
		canonical.replaceAll("bootname=A", "  bootname=A  "),
	],
	["CRLF", canonical.replaceAll("\n", "\r\n")],
	["spaced CRLF", spaced.replaceAll("\n", "\r\n")],
	[
		"comment-interleaved",
		canonical
			.replace("[slot.rootfs.0]", "# rootfs A\n[slot.rootfs.0]\n; bootname=Z")
			.replace("bootname=B", "# bootname=Y\nbootname = B"),
	],
];

describe("N4: the slot map tolerates key-file whitespace and keeps its scoping", () => {
	for (const [label, text] of payloads)
		test(`${label} system.conf yields the same rootfs map`, () => {
			expect(parseRaucSlotBootnames(text)).toEqual(expected);
		});

	test("only [slot.rootfs.N] sections count: certs and [system] keys are ignored", () => {
		const text = `[system]\nbootname = X\n${canonical}\n[slot.certs.1]\nbootname = C\n`;
		expect(parseRaucSlotBootnames(text)).toEqual(expected);
	});

	test("an unchanged same-slot reboot across boots starts no extra mirror with the spaced form", () => {
		const bootnames = parseRaucSlotBootnames(spaced);
		const dpkgSha = "5".repeat(64);
		const healthy = (bootId: string): HealthySlotState => ({
			boot_id: bootId,
			slot: "A",
			build_id: "build",
			dpkg_status_sha256: dpkgSha,
			recorded_at: "2026-09-30T11:33:49Z",
		});
		let receipt: { state_sha256: string; target_slot: string } | null = null;
		const mirrors: string[] = [];
		for (const bootId of ["boot-1", "boot-2", "boot-3", "boot-4"]) {
			const healthyState = healthy(bootId);
			const verdict = slotSyncGate({
				healthyState,
				bootId,
				statusSha256: dpkgSha,
				buildId: "build",
				receiptStateSha256: receipt?.state_sha256 ?? null,
				receiptTarget: classifyReceiptTarget({
					receipt,
					healthyState,
					bootId,
					bootnames,
				}),
				receiptTargetSlot: receipt?.target_slot ?? null,
				capabilities: {
					mode: "capable",
					features: ["apt-all-packages", "slot-sync"],
				},
				phase: "idle",
			});
			if (verdict.allowed) {
				mirrors.push(bootId);
				receipt = { state_sha256: dpkgSha, target_slot: "rootfs.1" };
			} else expect(verdict.reason).toBe("already-synced");
		}
		expect(mirrors).toEqual(["boot-1"]);
	});
});
