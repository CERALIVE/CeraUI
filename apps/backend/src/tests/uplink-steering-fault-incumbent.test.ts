import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../helpers/run.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import { buildShareRuleset } from "../modules/network/uplink-steering/ruleset.ts";
import {
	requestUplinkSteeringReconcile,
	stopUplinkSteeringForTest,
} from "../modules/network/uplink-steering/runtime.ts";
import * as builder from "../modules/network/uplink-steering/state-builder.ts";
import {
	getUplinkSteeringStatus,
	resetUplinkSteeringStatusForTest,
} from "../modules/network/uplink-steering/status.ts";
import * as ws from "../modules/ui/websocket-server.ts";

const RUN_DIR = "/run/ceralive";
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const table = (mark: number) => String(30_000 + ((mark >>> 8) & 0xffff));
const link = (identity: string, ifname: string, mark: number) => ({
	identity,
	ifname,
	mark,
	weight: 100,
	selectable: true,
});
const real = {
	readFile: fsp.readFile,
	open: fsp.open,
	rename: fsp.rename,
	writeFile: fsp.writeFile,
};

afterEach(() => {
	stopUplinkSteeringForTest();
	resetUplinkSteeringStatusForTest();
	jest.restoreAllMocks();
});

/** Real runtime; only the journal directory, kernel reads and the applier are faked. */
async function device(fault: string) {
	const dir = await fsp.mkdtemp(join(tmpdir(), `steering-fault-${fault}-`));
	const at = (path: string) =>
		path === RUN_DIR ? dir : path.replace(`${RUN_DIR}/`, `${dir}/`);
	spyOn(fsp, "readFile").mockImplementation((async (
		path: string,
		encoding: BufferEncoding,
	) => real.readFile(at(path), encoding)) as typeof fsp.readFile);
	spyOn(fsp, "open").mockImplementation((async (
		path: string,
		flags: string,
		mode?: number,
	) => real.open(at(path), flags, mode)) as typeof fsp.open);
	spyOn(fsp, "rename").mockImplementation((async (from: string, to: string) =>
		real.rename(at(from), at(to))) as typeof fsp.rename);
	spyOn(ws, "broadcastMsg").mockImplementation(() => {});
	let applied: PreparedSteeringState | undefined;
	spyOn(UplinkSteeringApplier.prototype, "apply").mockImplementation(
		async (_previous, next) => {
			applied = next;
		},
	);
	spyOn(
		UplinkSteeringApplier.prototype,
		"retryPendingCleanup",
	).mockResolvedValue();
	let failObservation = false;
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		const command = `${bin} ${args.join(" ")}`;
		if (command === "ip rule show") return "";
		const ifname = /^ip -o link show dev (\S+)$/.exec(command)?.[1];
		if (ifname !== undefined) return `7: ${ifname}: <UP> mtu 1500\n`;
		if (command !== "nft -nn list ruleset")
			throw new Error(`unexpected command ${command}`);
		if (failObservation) {
			failObservation = false;
			throw Object.assign(new Error("netlink: resource busy"), { code: 1 });
		}
		return applied === undefined
			? ""
			: buildShareRuleset(applied)
					.split("\n")
					.filter((line) => !/^(add|delete) table /.test(line))
					.join("\n");
	});
	let links: SteeringUplink[] = [];
	spyOn(builder, "readDesiredSteeringState").mockImplementation(
		async (_deps, context) => {
			const assigned = await context?.resolveMarks?.(links);
			const uplinks = links.flatMap((uplink) => {
				const mark = assigned?.get(uplink.identity);
				return mark === undefined ? [] : [{ ...uplink, mark }];
			});
			return {
				clientZones: [zone],
				uplinks,
				routes: uplinks.map((uplink) => ({
					...uplink,
					sourceAddress: `100.64.${uplink.ifname.slice(4)}.2`,
					table: table(uplink.mark),
					managed: true,
				})),
			};
		},
	);
	return {
		dir,
		failNextObservation: () => {
			failObservation = true;
		},
		corruptJournal: () =>
			real.writeFile(join(dir, "uplink-steering-marks.json"), "torn"),
		step: async (next: SteeringUplink[]) => {
			links = next;
			await requestUplinkSteeringReconcile();
			return {
				status: getUplinkSteeringStatus(),
				routes: Object.fromEntries(
					(applied?.routes ?? []).map((route) => [
						route.identity,
						`${route.mark.toString(16)} ${route.ifname}`,
					]),
				),
			};
		},
	};
}

test.each([
	["observe", 0xca123400, 0xca00aa00],
	["corrupt-journal", 0xca223400, 0xca00bb00],
] as const)(
	"a %s fault when a same-mark twin first appears leaves the incumbent as main does",
	async (fault, shared, other) => {
		const h = await device(fault);
		try {
			const x = link(`${fault}-x`, "wwan0", shared);
			const z = link(`${fault}-z`, "wwan1", other);
			const twin = link(`${fault}-y`, "wwan2", shared);
			const steered = {
				[x.identity]: `${shared.toString(16)} wwan0`,
				[z.identity]: `${other.toString(16)} wwan1`,
			};

			expect(await h.step([x, z])).toEqual({
				status: { state: "available" },
				routes: steered,
			});

			if (fault === "observe") h.failNextObservation();
			else await h.corruptJournal();
			// Main refuses the collision and leaves every route and flow in place.
			expect(await h.step([x, z, twin])).toMatchObject({
				status: { state: "steering_unavailable", reason: "mark_collision" },
				routes: steered,
			});

			expect(await h.step([x, z])).toEqual({
				status: { state: "available" },
				routes: steered,
			});
		} finally {
			await fsp.rm(h.dir, { recursive: true });
		}
	},
);
