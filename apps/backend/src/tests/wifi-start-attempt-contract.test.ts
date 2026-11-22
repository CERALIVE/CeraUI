import { expect, spyOn, test } from "bun:test";
import {
	hotspotStartInputSchema,
	hotspotToggleInputSchema,
	wifiMessageSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as nm from "../modules/network/network-manager.ts";
import * as profileInstances from "../modules/network/network-manager-profile-instance.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	handleWifiMonitorEvent,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import * as profiles from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { hotspotStartProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { RUN_ID } from "./helpers/wifi-active-observation.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

test("only Start accepts an optional UUID as its attempt identifier", () => {
	const input = { device: "0", incarnation: "radio-A" };
	const attempt = crypto.randomUUID();
	expect(hotspotStartInputSchema.parse(input)).toEqual(input);
	expect(hotspotStartInputSchema.parse({ ...input, attempt })).toEqual({
		...input,
		attempt,
	});
	expect(
		hotspotStartInputSchema.safeParse({ ...input, attempt: "not-a-uuid" })
			.success,
	).toBe(false);
	expect(hotspotToggleInputSchema.parse({ ...input, attempt })).toEqual(input);
});

test("the Start terminal echoes only the initiating attempt and legacy frames remain valid", async () => {
	const f = await wifiFrameFixture();
	try {
		const attempt = crypto.randomUUID();
		expect(
			await call(
				hotspotStartProcedure,
				{
					device: "0",
					incarnation: f.before,
					attempt,
				},
				{ context: f.context },
			),
		).toEqual({ success: true, accepted: true });
		const outcomes = f.frames.flatMap((raw) => {
			const decoded = wifiMessageSchema.parse(JSON.parse(raw).wifi);
			return decoded.hotspot?.start ? [decoded.hotspot.start] : [];
		});
		expect(outcomes).toEqual([{ device: 0, success: true, attempt }]);
		expect(
			wifiMessageSchema.parse({
				hotspot: { start: { device: 0, error: "radio-changed" } },
			}).hotspot?.start,
		).toEqual({ device: 0, error: "radio-changed" });
	} finally {
		await f.restore();
	}
});

test("a deferred replacement refusal echoes the Start UUID after its accepted reply", async () => {
	const f = await wifiFrameFixture(false);
	const persistedIntent = defaultHotspotDeps.recordIntent;
	if (!persistedIntent) throw new Error("Expected the Start intent recorder");
	spyOn(persistedIntent, "persist").mockImplementation(() => {});
	spyOn(persistedIntent, "restore").mockImplementation(() => {});
	const instance = {
		path: "/org/freedesktop/NetworkManager/Settings/1",
		fingerprint: "test-ap",
		runId: RUN_ID,
		file: { filename: "test", device: "1", inode: "2", ctime: "3" },
	};
	const activePath = "/org/freedesktop/NetworkManager/ActiveConnection/6";
	spyOn(profileInstances, "nmRunId").mockResolvedValue(RUN_ID);
	// Model an acknowledged Up whose exact activation remains visible after the swap.
	spyOn(profiles, "runHotspotProfileOperation").mockImplementation(
		async (operation) => ({
			checked: true,
			success: Boolean(
				await (operation.kind === "modify"
					? operation.run(operation.fields)
					: operation.run(instance)),
			),
			instance,
		}),
	);
	spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue(undefined);
	spyOn(defaultHotspotDeps, "readProfileInstance").mockResolvedValue(instance);
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockResolvedValue(false);
	spyOn(defaultHotspotDeps, "wifiUpdateSavedConns").mockResolvedValue();
	spyOn(defaultHotspotDeps, "nmConnSetFields").mockResolvedValue(true);
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(
		async (_, __, activated) => {
			activated?.(activePath);
			return true;
		},
	);
	spyOn(defaultHotspotDeps, "nmDisconnect").mockResolvedValue(false);
	spyOn(defaultHotspotDeps, "pruneHotspotConns").mockResolvedValue();
	spyOn(defaultHotspotDeps, "broadcastState").mockImplementation(() => {});
	spyOn(defaultHotspotDeps, "setDupIpSuppression").mockImplementation(() => {});
	spyOn(defaultHotspotDeps.credentials, "get").mockReturnValue(undefined);
	const attempt = crypto.randomUUID();
	const outcomes = () =>
		f.frames.flatMap((raw) => {
			const decoded = wifiMessageSchema.parse(JSON.parse(raw).wifi);
			return decoded.hotspot?.start ? [decoded.hotspot.start] : [];
		});
	try {
		expect(
			await call(
				hotspotStartProcedure,
				{ device: "0", incarnation: f.before, attempt },
				{ context: f.context },
			),
		).toEqual({ success: true, accepted: true });
		expect(outcomes()).toEqual([]);
		spyOn(defaultHotspotDeps, "pollHotspotActive").mockResolvedValue(true);
		spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:connected:test-ap"]);
		spyOn(nm, "nmDeviceProp").mockResolvedValue(["100", "test-ap", activePath]);
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
			path.endsWith("/ifindex")
				? "20"
				: path.endsWith("/index")
					? "1"
					: "dc:a6:32:aa:bb:c0",
		);
		await handleWifiMonitorEvent({
			type: "device-state",
			device: f.row.ifname,
			state: "connected",
		});
		expect(outcomes()).toEqual([
			{
				device: 0,
				error: "radio-changed",
				reason: "deactivation-failed",
				attempt,
			},
		]);
	} finally {
		await settlePending(f.row.ifname, false);
		await f.restore();
	}
});
