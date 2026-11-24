import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as runner from "../helpers/run.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import {
	initUplinkSteering,
	requestUplinkSteeringReconcile,
	stopUplinkSteeringForTest,
} from "../modules/network/uplink-steering/runtime.ts";
import * as builder from "../modules/network/uplink-steering/state-builder.ts";
import {
	getUplinkSteeringStatus,
	resetUplinkSteeringStatusForTest,
} from "../modules/network/uplink-steering/status.ts";
import * as device from "../modules/system/device-detection.ts";
import * as ws from "../modules/ui/websocket-server.ts";

const journalPath = "/run/ceralive/uplink-steering-marks.json";
const natural = 0xca671800;
const probe = 0xca671900;
const solo = 0xca010000;
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const table = (mark: number) => String(30_000 + ((mark >>> 8) & 0xffff));
const link = (identity: string, ifname: string, mark: number) => ({
	identity,
	ifname,
	mark,
	weight: 100,
	selectable: true,
});
const claim = (identity: string, ifname: string, mark: number) => ({
	identity,
	ifname,
	ifindex: 7,
	sourceAddress: "100.64.1.2",
	table: table(mark),
	mark,
	epoch: 0,
});
const unverified = {
	state: "steering_unavailable",
	reason: "ruleset_reload_failed",
} as const;
const readFile = fsp.readFile;
const open = fsp.open;

afterEach(() => {
	stopUplinkSteeringForTest();
	resetUplinkSteeringStatusForTest();
	jest.restoreAllMocks();
});

function savedJournal(bytes: string | undefined): void {
	spyOn(fsp, "readFile").mockImplementation((async (
		path: string,
		options: BufferEncoding,
	) => {
		if (path !== journalPath) return readFile(path, options);
		if (bytes === undefined)
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		return bytes;
	}) as typeof fsp.readFile);
}

function journal(affected: number[], claims: ReturnType<typeof claim>[]) {
	return JSON.stringify({
		version: 1,
		base: { seq: 1, digest: "", claims, zones: [zone], affected },
		provisional: [],
	});
}

function broadcasts(): unknown[] {
	const published: unknown[] = [];
	spyOn(ws, "broadcastMsg").mockImplementation((channel, payload) => {
		if (channel === "uplink-steering") published.push(payload);
	});
	return published;
}

test.each([
	[
		"a journaled collision is unverified",
		journal(
			[natural, probe],
			[claim("twin-a", "wwan0", natural), claim("twin-b", "wwan1", probe)],
		),
		[unverified],
	],
	[
		"a non-colliding journal stays available and silent",
		journal([], [claim("solo", "wwan0", solo)]),
		[],
	],
] as const)(
	"at start-up, %s before netif readiness",
	async (_name, bytes, expected) => {
		spyOn(device, "isRealDevice").mockResolvedValue(true);
		spyOn(netif, "hasNetifSnapshot").mockReturnValue(false);
		const commands = spyOn(runner, "run").mockRejectedValue(
			new Error("no kernel state should be needed before netif readiness"),
		);
		savedJournal(bytes);
		const published = broadcasts();

		await initUplinkSteering();

		expect(published).toEqual([...expected]);
		expect(getUplinkSteeringStatus()).toEqual(
			expected[0] ?? { state: "available" },
		);
		expect(commands).not.toHaveBeenCalled();
	},
);

test.each([
	[
		"distinct marks",
		[link("a", "wwan0", natural), link("c", "wwan2", solo)],
		"available",
	],
	[
		"one natural mark",
		[link("a", "wwan0", natural), link("b", "wwan1", natural)],
		"steering_unavailable",
	],
] as const)(
	"an intent with %s reaches disk with the expected status",
	async (_name, links, expected) => {
		savedJournal(undefined);
		broadcasts();
		spyOn(runner, "run").mockImplementation(async (bin, args) => {
			const command = `${bin} ${args.join(" ")}`;
			if (command === "nft -nn list ruleset" || command === "ip rule show")
				return "";
			const ifname = /^ip -o link show dev (\S+)$/.exec(command)?.[1];
			if (ifname !== undefined) return `7: ${ifname}: <UP> mtu 1500\n`;
			throw new Error(`unexpected command ${command}`);
		});
		spyOn(builder, "readDesiredSteeringState").mockImplementation(
			async (_deps, context) => {
				const candidates: SteeringUplink[] = [...links];
				const assigned = await context?.resolveMarks?.(candidates);
				const uplinks = candidates.map((uplink) => ({
					...uplink,
					mark: assigned?.get(uplink.identity) ?? uplink.mark,
				}));
				return {
					clientZones: [zone],
					uplinks,
					routes: uplinks.map((uplink) => ({
						...uplink,
						sourceAddress: "100.64.1.2",
						table: table(uplink.mark),
						managed: true,
					})),
				};
			},
		);
		const atIntent: string[] = [];
		spyOn(fsp, "open").mockImplementation((async (
			path: string,
			...rest: Parameters<typeof fsp.open> extends [unknown, ...infer R]
				? R
				: never
		) => {
			if (!path.endsWith(".pending")) return open(path, ...rest);
			atIntent.push(getUplinkSteeringStatus().state);
			throw new Error("backend killed while writing the intent");
		}) as typeof fsp.open);

		await requestUplinkSteeringReconcile();

		expect(atIntent[0]).toBe(expected);
	},
);
