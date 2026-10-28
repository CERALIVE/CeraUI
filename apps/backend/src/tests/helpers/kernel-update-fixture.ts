import type { UpdateCapabilities } from "@ceraui/rpc/schemas";
import type { KernelPackageRecord } from "../../modules/system/update-orchestrator/kernel-packages.ts";
import type {
	KernelState,
	SlotOverlay,
} from "../../modules/system/update-orchestrator/kernel-state.ts";
export const kernelRecord: KernelPackageRecord = {
	package: "linux-image-7.2.0-ceralive-rk3588",
	version: "7.2.0-ceralive2",
	deb_sha256: "a".repeat(64),
	filename: "pool/kernel.deb",
	size: 4,
};
export const kernelState: KernelState = {
	schema: 1,
	attempt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	package: kernelRecord.package,
	version: kernelRecord.version,
	deb_sha256: kernelRecord.deb_sha256,
	target_slot: "B",
	booted_slot_at_stage: "A",
	boot_id_at_activation: null,
	state: "staged",
	reason: null,
	timestamps: { staged: "2026-10-20T00:00:00Z" },
};
export const baseImage = {
	slot: "rootfs.0",
	bundleHash: "b".repeat(64),
	checksum: "c".repeat(64),
	installedAt: "2026-10-01T00:00:00Z",
	installedCount: 1,
};
export const kernelOverlay = {
	status: "pending",
	attempt: kernelState.attempt,
	base_bundle_identity: baseImage,
	kernel: {
		package: kernelRecord.package,
		version: kernelRecord.version,
		deb_sha256: kernelRecord.deb_sha256,
	},
} satisfies SlotOverlay;
export const kernelCapabilities: UpdateCapabilities = {
	mode: "capable",
	features: ["apt-all-packages", "kernel-apt-stage"],
};
export function packagesEntry(record = kernelRecord): string {
	return `Package: ${record.package}\nVersion: ${record.version}\nArchitecture: arm64\nFilename: ${record.filename}\nSHA256: ${record.deb_sha256}\nSize: ${record.size}\n`;
}
