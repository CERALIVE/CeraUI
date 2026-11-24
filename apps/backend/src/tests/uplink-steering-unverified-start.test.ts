import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as runner from "../helpers/run.ts";
import { UplinkSteeringApplier } from "../modules/network/uplink-steering/applier.ts";
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
import * as detection from "../modules/system/device-detection.ts";
import * as ws from "../modules/ui/websocket-server.ts";
import { device, z } from "./uplink-steering-stale-journal-fixtures.ts";

const journalPath = "/run/ceralive/uplink-steering-marks.json";
const solo = { identity: "solo", ifname: "wwan0", mark: 0xca010000 };
const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
const guardListing =
	"table inet ceralive_share_guard {\n\tchain assignment_2 {\n\t}\n}\n";
const fenceRule = "110:\tfrom all fwmark 0xca000000/0xff000000 lookup 30000\n";
const readFile = fsp.readFile;

afterEach(() => {
	stopUplinkSteeringForTest();
	resetUplinkSteeringStatusForTest();
	jest.restoreAllMocks();
});

/** A backend restart with the guard still in the kernel and no journal. */
function restartedDevice() {
	const state = { ready: false, failNextListing: false };
	spyOn(detection, "isRealDevice").mockResolvedValue(true);
	spyOn(UplinkSteeringApplier.prototype, "apply").mockResolvedValue();
	spyOn(
		UplinkSteeringApplier.prototype,
		"retryPendingCleanup",
	).mockResolvedValue();
	spyOn(fsp, "readFile").mockImplementation((async (
		path: string,
		options: BufferEncoding,
	) => {
		if (path !== journalPath) return readFile(path, options);
		throw Object.assign(new Error("absent"), { code: "ENOENT" });
	}) as typeof fsp.readFile);
	spyOn(runner, "run").mockImplementation(async (bin) => {
		if (!state.ready) throw new Error("no kernel command before readiness");
		if (bin !== "nft") return fenceRule;
		if (!state.failNextListing) return guardListing;
		state.failNextListing = false;
		throw new Error("netlink: Resource temporarily unavailable");
	});
	spyOn(builder, "readDesiredSteeringState").mockImplementation(
		async (_deps, context) => {
			if (!state.ready)
				return { pending: true, netifReady: false, reason: "netif" };
			const mark = (
				await context?.resolveMarks?.([
					{ ...solo, weight: 100, selectable: true },
				])
			)?.get(solo.identity);
			const uplinks =
				mark === undefined
					? []
					: [{ ...solo, mark, weight: 100, selectable: true }];
			return { clientZones: [zone], uplinks, routes: [] };
		},
	);
	const timers: { readonly run: () => void; readonly delay: number }[] = [];
	spyOn(globalThis, "setTimeout").mockImplementation(((
		run: () => void,
		delay: number,
	) => {
		timers.push({ run, delay });
		return { unref: () => {} };
	}) as unknown as typeof setTimeout);
	let settle: (() => void) | undefined;
	const collided = new Promise<void>((resolve) => {
		settle = resolve;
	});
	spyOn(ws, "broadcastMsg").mockImplementation((_channel, payload) => {
		if ((payload as { reason?: string }).reason === "mark_collision")
			settle?.();
	});
	return { state, timers, collided };
}

test("a missing journal under a surviving guard stays unverified through a failed first kernel read and rechecks unprompted", async () => {
	const h = restartedDevice();
	await initUplinkSteering();

	h.state.ready = true;
	h.state.failNextListing = true;
	await requestUplinkSteeringReconcile();
	expect(getUplinkSteeringStatus()).toMatchObject({
		state: "steering_unavailable",
		reason: "ruleset_reload_failed",
	});

	const recheck = h.timers.find(({ delay }) => delay === 5_000);
	expect(recheck).toBeDefined();
	recheck?.run();
	await Promise.race([
		h.collided,
		Bun.sleep(5_000).then(() => {
			throw new Error("no recheck read the kernel");
		}),
	]);
	await requestUplinkSteeringReconcile();
	expect(getUplinkSteeringStatus()).toMatchObject({
		state: "steering_unavailable",
		reason: "mark_collision",
	});
});

test.each([
	["missing", true],
	["unreadable", true],
	["corrupt", true],
	["readable", false],
] as const)(
	"a failed first kernel read with a %s journal leaves the marks unverified: %p",
	async (journal, unverified) => {
		await device(async (h) => {
			await h.step(h.lifecycle(), undefined, [z]);
			if (journal === "missing") await rm(h.path);
			if (journal === "unreadable") {
				await rm(h.path);
				await mkdir(h.path);
			}
			if (journal === "corrupt") await writeFile(h.path, "torn");
			const marks = h.lifecycle();
			h.failObservations(1);
			await marks.marks([z]);
			expect(marks.unverified).toBe(unverified);
			await marks.marks([z]);
			expect(marks.unverified).toBe(false);
		});
	},
);
