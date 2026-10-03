import { osChannelManifestSchema } from "../../modules/system/update-orchestrator/os-manifest.ts";
import type { OsUnlaunchedWitnessInput } from "../../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";

export const manifest = osChannelManifestSchema.parse({
	schema: 1,
	board: "orange-pi-5-plus",
	compatible: "ceralive-orangepi5-plus",
	channel: "drill",
	version: "2026.10.52",
	serial: 13,
	published_at: "2026-10-01T14:03:25Z",
	expires_at: "2026-12-30T14:03:25Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.4",
	bundle: {
		url: "https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.52/bundle.raucb",
		size: 1464380919,
		sha256: "3acb98f25ca876a2b36ea215d62a4aff9997bb6cb5041d7ee8df3d0873b9aef0",
	},
	flash: {
		url: "https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.52/flash.raw.xz",
		size: 2068082832,
		sha256: "05164f7d682b07f525f957dea4df7825bb5bf5bb1f04bc458821cc4d27aa1ea8",
		raw_sha256:
			"ea23e94f84a75c38c7b5fff68567549824ac889cbc28a78ec2f61a57cb932ae0",
	},
	lock_url:
		"https://images.ceralive.tv/releases/orange-pi-5-plus/2026.10.52/packages.lock.json",
});
export const input: OsUnlaunchedWitnessInput = {
	attemptId: "00000000-0000-4000-8000-000000000001",
	manifestJson: JSON.stringify(manifest),
	bootId: "00000000-0000-4000-8000-000000000002",
	baselineInstance: "645:671",
};
