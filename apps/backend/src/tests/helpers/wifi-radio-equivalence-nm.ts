import type { run } from "../../helpers/run.ts";
import { nmcliFieldOutput } from "./nmcli-field-output.ts";
import type { RadioFixture } from "./wifi-radio-equivalence.ts";

type EquivalenceNm = {
	readonly run: typeof run;
	readonly activate: (ifname: string, uuid: string) => void;
	readonly reset: () => void;
};

/** NM inputs for the parity fixture, including explicit AP-up observations. */
export function createEquivalenceNm(
	radios: () => readonly RadioFixture[],
	unexpected: string[],
): EquivalenceNm {
	const activeUuids = new Map<string, string>();
	return {
		activate: (ifname, uuid) => {
			activeUuids.set(ifname, uuid);
		},
		reset: () => activeUuids.clear(),
		run: async (bin, args) => {
			if (bin === "nmcli") {
				if (
					args.join(" ") ===
					"--terse --fields device,type,state,con-uuid device status"
				)
					return radios()
						.map((r) => {
							const uuid = activeUuids.get(r.ifname);
							return `${r.ifname}:wifi:${uuid ? "connected" : r.state}:${uuid ?? ""}`;
						})
						.join("\n");
				if (
					args.includes(
						"GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ",
					)
				)
					return nmcliFieldOutput(
						args,
						(field) =>
							(
								({
									"GENERAL.VENDOR": "Fixture",
									"GENERAL.PRODUCT": "Radio",
									"WIFI-PROPERTIES.AP": "yes",
									"WIFI-PROPERTIES.5GHZ": "no",
									"WIFI-PROPERTIES.2GHZ": "yes",
								}) as Record<string, string>
							)[field],
					);
				if (args.join(" ") === "--terse --fields uuid,type connection show")
					return "";
				if (
					args.includes("IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY")
				)
					return "";
			}
			unexpected.push(`${bin} ${args.join(" ")}`);
			throw new Error(
				`Unexpected equivalence command: ${bin} ${args.join(" ")}`,
			);
		},
	};
}
