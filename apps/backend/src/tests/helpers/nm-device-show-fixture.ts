import { readFileSync } from "node:fs";
import type { ModemNmDeviceReader } from "../../modules/modems/modem-nm-device.ts";
import twinReplay from "../fixtures/real-device/nm-1.52.1-twin-profile-replay.json";

const allowedFields = new Set(
	readFileSync(
		new URL(
			"../fixtures/real-device/nm-1.52.1-device-show-fields.txt",
			import.meta.url,
		),
		"utf8",
	)
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("#")),
);

export function assertNmDeviceShowFields(fields: string): void {
	for (const field of fields.split(",")) {
		if (!allowedFields.has(field)) {
			throw Object.assign(new Error(`invalid field '${field}'`), {
				code: 2,
				stderr: `Error: 'device show': invalid field '${field}'`,
			});
		}
	}
}

export const TWIN_REPLAY_UUID = twinReplay.connectionId;

/**
 * Redacted replay shaped from the NM 1.52.1 multiline measurement and #434.
 * The real capture cannot show overlapping profiles; keep this replay for ambiguity coverage.
 */
export function twinProfileReplay(): {
	reader: ModemNmDeviceReader;
	properties: Record<string, Record<string, string>>;
	reads: Array<[string, string, "multiline" | undefined]>;
} {
	const properties: Record<string, Record<string, string>> = structuredClone(
		twinReplay.properties,
	);
	const reads: Array<[string, string, "multiline" | undefined]> = [];
	return {
		properties,
		reads,
		reader: {
			listDevices: async () => twinReplay.devices,
			deviceProp: async (device, fields, mode) => {
				assertNmDeviceShowFields(fields);
				reads.push([device, fields, mode]);
				if (
					fields === "CONNECTIONS.AVAILABLE-CONNECTIONS" &&
					mode !== "multiline"
				)
					throw new Error(
						"available connections must be read in multiline mode",
					);
				return (properties[device]?.[fields] ?? "").split("\n");
			},
		},
	};
}
