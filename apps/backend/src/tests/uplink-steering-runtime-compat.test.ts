import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../helpers/run.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import * as shaper from "../modules/network/uplink-shaper/applier.ts";
import { initUplinkShaper } from "../modules/network/uplink-shaper/runtime.ts";
import { resetUplinkShaperStatusForTest } from "../modules/network/uplink-shaper/status.ts";
import { fileMarkJournal } from "../modules/network/uplink-steering/mark-journal.ts";
import { SteeringMarkLifecycle } from "../modules/network/uplink-steering/mark-lifecycle.ts";
import {
	initUplinkSteering,
	stopUplinkSteeringForTest,
} from "../modules/network/uplink-steering/runtime.ts";
import * as builder from "../modules/network/uplink-steering/state-builder.ts";
import {
	getUplinkSteeringStatus,
	publishUplinkSteeringAvailability,
	resetUplinkSteeringStatusForTest,
} from "../modules/network/uplink-steering/status.ts";
import * as lifecycle from "../modules/streaming/stream-lifecycle-status.ts";
import * as device from "../modules/system/device-detection.ts";
import * as ws from "../modules/ui/websocket-server.ts";

const uplink = {
	identity: "usb:singleton",
	ifname: "wwan0",
	mark: 0xca010000,
	weight: 100,
	selectable: true,
};
const route = {
	...uplink,
	sourceAddress: "100.64.1.2",
	table: "30256",
	managed: true,
};
const state = {
	clientZones: [{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" }],
	uplinks: [uplink],
	routes: [route],
};

afterEach(() => {
	stopUplinkSteeringForTest();
	resetUplinkSteeringStatusForTest();
	resetUplinkShaperStatusForTest();
	jest.restoreAllMocks();
});

test("real-device startup leaves sharing available and silent while netif is pending", async () => {
	spyOn(device, "isRealDevice").mockResolvedValue(true);
	spyOn(netif, "hasNetifSnapshot").mockReturnValue(false);
	const published: unknown[] = [];
	spyOn(ws, "broadcastMsg").mockImplementation((channel, payload) => {
		if (channel === "uplink-steering") published.push(payload);
	});
	const commands = spyOn(runner, "run").mockRejectedValue(
		new Error("no kernel state should be needed before netif readiness"),
	);

	await initUplinkSteering();

	expect(getUplinkSteeringStatus()).toEqual({ state: "available" });
	expect(published).toEqual([]);
	expect(commands).not.toHaveBeenCalled();
});

test("shaper applies live non-colliding links even when steering has a reload error", async () => {
	spyOn(device, "isRealDevice").mockResolvedValue(true);
	const desired = spyOn(builder, "readDesiredSteeringState").mockResolvedValue(
		state,
	);
	spyOn(lifecycle, "getStreamLifecycleState").mockReturnValue("streaming");
	const applied = spyOn(
		shaper.UplinkShaperApplier.prototype,
		"apply",
	).mockResolvedValue("cake");
	publishUplinkSteeringAvailability({
		available: false,
		reason: "ruleset_reload_failed",
	});

	await initUplinkShaper();

	expect(desired).toHaveBeenCalledTimes(1);
	expect(
		applied.mock.calls.map(([request]) =>
			request.uplinks.map(({ ifname, mark }) => [ifname, mark]),
		),
	).toEqual([[[uplink.ifname, uplink.mark]]]);
	expect(getUplinkSteeringStatus()).toEqual({
		state: "steering_unavailable",
		reason: "ruleset_reload_failed",
	});
});

test("an invalid journal does not block an unguarded singleton or change its mark", async () => {
	const dir = await mkdtemp(join(tmpdir(), "steering-legacy-"));
	try {
		const path = join(dir, "marks.json");
		await writeFile(path, "torn");
		const unexpected = async () => {
			throw new Error("unexpected guarded-path effect");
		};
		const applied: unknown[] = [];
		const marks = new SteeringMarkLifecycle({
			journal: fileMarkJournal(path),
			observe: async () => ({ guard: "", fence: false, legacy: "" }),
			linkIndex: async () => 5,
			armFence: unexpected,
			guard: unexpected,
			retire: unexpected,
			ensure: unexpected,
			flush: unexpected,
			publish: unexpected,
			applyLegacy: async (_previous, next) => {
				applied.push(next);
			},
		});

		expect(await marks.marks([uplink])).toEqual(
			new Map([[uplink.identity, uplink.mark]]),
		);
		await marks.apply(undefined, state);

		expect(applied).toEqual([state]);
	} finally {
		await rm(dir, { recursive: true });
	}
});
