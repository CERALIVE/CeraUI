import type { setOsStageEntryDepsForTest } from "../../modules/system/update-orchestrator/os-agent.ts";
import { manifest } from "./os-stage-run-inputs.ts";

export const settings = {
	packagesAuto: false,
	systemAuto: false,
	channel: "stable",
	schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
	allowPackagesOverCellular: false,
	allowSystemOverCellular: false,
} as const;

export const trustedEntry = {
	settings: async () => settings,
	readSigned: async () => ({
		data: new TextEncoder().encode(JSON.stringify(manifest)),
		signature: new Uint8Array([1]),
		context: {
			board: manifest.board,
			compatible: manifest.compatible,
			channel: manifest.channel,
			serial: manifest.serial - 1,
			bootedVersion: "2026.10.0",
			installedVersion: "2026.9.3",
			now: Date.parse("2026-10-02T00:00:00Z"),
		},
		verification: {
			verifyCms: async () => ({
				cn: "CeraLive OTA Manifest Signer",
				eku: ["codeSigning"],
				issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
			}),
			compare: async (left, right) => left > right,
			isQuarantined: async () => false,
		},
	}),
	board: async () => ({
		board: manifest.board,
		compatible: manifest.compatible,
	}),
	booted: async () => "2026.10.0",
	compare: async (left, right) => left > right,
} satisfies NonNullable<Parameters<typeof setOsStageEntryDepsForTest>[0]>;
