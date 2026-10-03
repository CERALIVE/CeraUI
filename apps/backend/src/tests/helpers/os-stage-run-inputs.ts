import { osChannelManifestSchema } from "../../modules/system/update-orchestrator/os-manifest.ts";
import type { RaucStageSnapshot } from "../../modules/system/update-orchestrator/os-stage-recovery.ts";
import { rankTransports } from "../../modules/system/update-transport/core.ts";

export const manifest = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.51",
	serial: 13,
	published_at: "2026-10-01T00:00:00Z",
	expires_at: "2026-12-01T00:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/bundle.raucb",
		size: 1414733301,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/packages.lock.json",
});

export const baseline: RaucStageSnapshot = {
	instance: "659:10",
	active: true,
	operation: "idle",
	processes: ["659:10"],
	resources: [],
	bootId: "boot-B",
	bootPrimary: "rootfs.1",
	bootedSlot: "rootfs.1",
	bootedDevice: "179:5",
	bootedHealthy: true,
	targetSlot: "rootfs.0",
	targetDevice: "179:4",
	targetInactive: true,
	activationArmed: false,
};

export const ranking = (names: string[], metered = false) =>
	rankTransports(
		names.map((ifname) => ({
			candidate: {
				ifname,
				kind: metered ? ("cellular" as const) : ("ethernet" as const),
				metered,
			},
			family: 4 as const,
			hosts: [{ host: "fixture", state: "clear" as const, latencyMs: 1 }],
		})),
	);
