import type {
	EquivalenceFixture,
	RadioFixture,
} from "../../helpers/wifi-radio-equivalence.ts";

const radio = {
	ifname: "wlan0",
	operational: "02:00:00:00:00:01",
	permanent: "58:02:05:e1:79:1c",
	ifindex: 10,
	phy: 0,
	state: "disconnected",
} satisfies RadioFixture;

export const radioEquivalenceCases: readonly EquivalenceFixture[] = [
	{ name: "verified fresh", frames: [[radio]], admitted: true },
	{
		name: "sysfs fail ifname cache hit",
		frames: [
			[radio],
			[{ ...radio, permanent: undefined, operational: "02:00:00:00:00:02" }],
		],
		admitted: true,
	},
	{
		name: "operational-MAC cache hit",
		frames: [
			[radio],
			[{ ...radio, ifname: "wlp-cache", permanent: undefined }],
		],
		admitted: true,
	},
	{
		name: "no-cache/unverified",
		frames: [[{ ...radio, permanent: undefined }]],
		admitted: true,
	},
	{
		name: "duplicate MAC",
		frames: [
			[
				radio,
				{
					...radio,
					ifname: "wlan1",
					operational: "02:00:00:00:00:03",
					ifindex: 11,
					phy: 1,
				},
			],
		],
		admitted: true,
	},
	{
		name: "rename",
		frames: [[radio], [{ ...radio, ifname: "wlp-renamed" }]],
		admitted: true,
	},
	{
		name: "replug",
		frames: [[radio], [], [{ ...radio, ifindex: 20, phy: 2 }]],
		admitted: true,
	},
	{
		name: "unavailable",
		frames: [[{ ...radio, state: "unavailable" }]],
		admitted: false,
	},
	{
		name: "missing operational MAC",
		frames: [[{ ...radio, operational: undefined }]],
		admitted: false,
	},
];
