import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import type {
	ProbeState,
	TransportSample,
	UplinkKind,
} from "../../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../../modules/system/update-transport/pin.ts";

export const APT_UID = 42042;
export const PINNED_CAPABILITIES = {
	schema: 1,
	features: ["apt-all-packages", "transport-uidrange"],
	apt_uid: APT_UID,
	ota_uid: 42041,
} as const;

export function sample(
	ifname: string,
	kind: UplinkKind,
	family: 4 | 6,
	state: ProbeState = "clear",
): TransportSample {
	return {
		candidate: { ifname, kind, metered: false },
		family,
		hosts: [{ host: "apt.ceralive.tv", state, latencyMs: 10 }],
	};
}

export const FETCH_FAILURE = {
	exitCode: 100,
	stdout: "",
	stderr:
		"E: Failed to fetch https://apt.ceralive.tv/pool/a.deb  Could not connect to apt.ceralive.tv:443 (2001:db8::1) - connect (101: Network is unreachable)\n",
};

/** A swept pin controller over a recorded `ip` runner; `active()` reads the apt rule. */
export async function pinFixture(swept = true) {
	const calls: string[] = [];
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse(PINNED_CAPABILITIES),
		now: () => 1000,
		run: async (_bin, args) => {
			const line = args.join(" ");
			calls.push(line);
			return line.endsWith("route show default")
				? "default dev eth0\ndefault dev wlan0"
				: "";
		},
	});
	if (swept) await pin.sweep();
	calls.length = 0;
	const lookup = `uidrange ${APT_UID}-${APT_UID} lookup 100000`;
	const active = () =>
		calls.reduce(
			(depth, line) =>
				!line.includes(lookup)
					? depth
					: line.includes("rule add")
						? depth + 1
						: line.includes("rule del")
							? depth - 1
							: depth,
			0,
		) > 0;
	return { pin, calls, active };
}
