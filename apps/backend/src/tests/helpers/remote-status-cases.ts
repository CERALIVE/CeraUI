export const HOTSPOT_PASSWORD = "REMOTE_HOTSPOT_SENTINEL_7e912b46";
export const OTHER_PASSWORD = "UNRELATED_APN_PASSWORD_05ab";

const exclusiveSafe = {
	before: "radio-first",
	mode: "hotspot",
	hotspot: {
		name: "Exclusive AP",
		channel: "auto",
		details: { password: OTHER_PASSWORD, nested: [{ z: 1, a: 2 }] },
	},
	after: undefined,
};
const exclusive = {
	...exclusiveSafe,
	hotspot: {
		name: exclusiveSafe.hotspot.name,
		password: HOTSPOT_PASSWORD,
		channel: exclusiveSafe.hotspot.channel,
		details: exclusiveSafe.hotspot.details,
	},
};
const concurrentSafe = {
	mode: "station",
	saved: { Upstream: "upstream-uuid" },
	hotspot: { name: "Concurrent AP", channel: "auto_24" },
	link: { tx: { rate: 80, password: OTHER_PASSWORD } },
};
const concurrent = {
	...concurrentSafe,
	hotspot: { password: HOTSPOT_PASSWORD, ...concurrentSafe.hotspot },
};
const inactive = {
	mode: "station",
	hotspot: undefined,
	nested: { z: 1, a: 2 },
};

/** Explicit expected rows keep the byte oracle independent of the projector. */
export const remoteStatusCases: ReadonlyArray<{
	readonly name: string;
	readonly local: unknown;
	readonly remote: unknown;
}> = [
	{
		name: "exclusive record with nested unrelated passwords",
		local: { z: exclusive, a: inactive },
		remote: { z: exclusiveSafe, a: inactive },
	},
	{
		name: "exclusive array",
		local: [exclusive, inactive],
		remote: [exclusiveSafe, inactive],
	},
	{
		name: "concurrent record",
		local: { z: concurrent, a: inactive },
		remote: { z: concurrentSafe, a: inactive },
	},
	{
		name: "concurrent array",
		local: [concurrent, inactive],
		remote: [concurrentSafe, inactive],
	},
	{
		name: "mixed array with undefined and null rows",
		local: [exclusive, undefined, concurrent, null, inactive],
		remote: [exclusiveSafe, undefined, concurrentSafe, null, inactive],
	},
	{ name: "empty record", local: {}, remote: {} },
	{ name: "empty array", local: [], remote: [] },
	{ name: "undefined collection", local: undefined, remote: undefined },
	{
		name: "record with undefined row and password",
		local: {
			z: undefined,
			a: {
				hotspot: { name: "Unset", password: undefined },
				retained: undefined,
			},
		},
		remote: {
			z: undefined,
			a: { hotspot: { name: "Unset" }, retained: undefined },
		},
	},
];
