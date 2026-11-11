import { expect } from "bun:test";

export const secrets = {
	ssh_pass: "P2S_SSH_68a2",
	pairing_secret: "P2S_PAIRING_9471",
	srt_streamid: "P2S_MEDIA_ID_f176",
	relay_streamid_override: "P2S_MEDIA_OVERRIDE_b21a",
} as const;

const APN_USER = "P2S_APN_USER_c32b";

export const APN_PASSWORD = "P2S_APN_PASSWORD_49ef";

export const AUTH_KEY = "P2S_REMOTE_AUTH_KEEP_72ba";

export const UNRELATED = "P2S_NESTED_PASSWORD_KEEP_0d32";

export const CID = "00000000-0000-4000-8000-000000000002";

export const modem = {
	ifname: "wwan0",
	name: "Privacy modem",
	network_type: { supported: ["lte"], active: "lte" },
	status: {
		connection: "connected",
		network_type: "lte",
		signal: 80,
		roaming: false,
	},
	config: {
		apn: "carrier.example",
		username: APN_USER,
		password: APN_PASSWORD,
		roaming: false,
		network: "auto",
		autoconfig: false,
		autoconfig_supported: true,
	},
};

export const collections: ReadonlyArray<{ name: string; value: unknown }> = [
	{ name: "record", value: { z: modem, a: { status: { signal: 42 } } } },
	{ name: "array", value: [modem, { status: { signal: 42 } }] },
	{ name: "multiple modems", value: { z: modem, a: modem } },
	{ name: "empty record", value: {} },
	{ name: "empty array", value: [] },
	{ name: "undefined", value: undefined },
	{ name: "null", value: null },
	{ name: "undefined and null rows", value: [undefined, modem, null] },
	{
		name: "empty and undefined credentials",
		value: {
			z: { config: { username: "", password: undefined, apn: "" } },
			a: { config: null },
			b: { config: undefined },
		},
	},
];

export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Serialize independently, omitting keys only on known DTO holders. */
export function expectedBytes(frame: unknown, config: unknown): string {
	return JSON.stringify(frame, function (this: unknown, key, value) {
		return this === config && key === "pairing_secret" ? undefined : value;
	});
}

export function expectNoPairingSecret(bytes: string): void {
	expect(bytes).not.toContain(secrets.pairing_secret);
}
