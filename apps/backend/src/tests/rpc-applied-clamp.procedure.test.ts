import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigMessage, StreamingConfigInput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	getNetworkInterfaces,
	processIfconfigOutput,
} from "../modules/network/network-interfaces.ts";
import { clampBitrate } from "../modules/streaming/encoder.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	getConfigProcedure,
	setBitrateProcedure,
	setConfigProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const configDir = mkdtempSync(join(tmpdir(), "rpc-applied-clamp-"));
const priorConfigPath = getConfigFilePath();
beforeAll(() => setConfigFilePath(join(configDir, "config.json")));
afterAll(() => {
	setConfigFilePath(priorConfigPath);
	rmSync(configDir, { recursive: true, force: true });
});

// A bitrate inside the zod validation window (500–50000) but above the encoder
// hardware ceiling, so the handler must clamp it down to clampBitrate's max.
const OVER_HARDWARE_BITRATE = 40000;

// Inside the encoder hardware window, so a streaming hot-adjust applies it verbatim.
const HOT_ADJUST_BITRATE = 7250;

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

describe("streaming.setConfig — applied (post-clamp) state", () => {
	test("clamps an over-ceiling max_br and resolves with the applied value", async () => {
		const result = await call(
			setConfigProcedure,
			{ max_br: OVER_HARDWARE_BITRATE },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.max_br).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
		expect(result.applied?.max_br).toBeLessThan(OVER_HARDWARE_BITRATE);
		expect(getConfig().max_br).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
	});

	test("still fires the config broadcast as an additional side-effect", async () => {
		const received: string[] = [];
		const client = captureClient(received);
		addClient(client);

		try {
			await call(
				setConfigProcedure,
				{ max_br: OVER_HARDWARE_BITRATE },
				{ context: makeContext() },
			);

			const configPayloads = received
				.map((raw) => JSON.parse(raw))
				.filter(
					(obj): obj is { config: { max_br?: number } } =>
						!!obj && typeof obj === "object" && "config" in obj,
				)
				.map((obj) => obj.config);

			expect(configPayloads.length).toBeGreaterThan(0);
			expect(configPayloads[configPayloads.length - 1].max_br).toBe(
				clampBitrate(OVER_HARDWARE_BITRATE),
			);
		} finally {
			removeClient(client);
		}
	});

	test("floors a sub-2s srt_latency to the SRTLA minimum, persisting + echoing 2000 (T2)", async () => {
		const result = await call(
			setConfigProcedure,
			{ srt_latency: 100 },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.srt_latency).toBe(2000);
		expect(getConfig().srt_latency).toBe(2000);
	});

	test("leaves an at/above-floor srt_latency untouched", async () => {
		const result = await call(
			setConfigProcedure,
			{ srt_latency: 3000 },
			{ context: makeContext() },
		);

		expect(result.applied?.srt_latency).toBe(3000);
		expect(getConfig().srt_latency).toBe(3000);
	});

	test("persists + echoes fec_enabled and recovery_mode (Tasks 18/19)", async () => {
		const result = await call(
			setConfigProcedure,
			{ fec_enabled: true, recovery_mode: "bandwidth-saver" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.fec_enabled).toBe(true);
		expect(result.applied?.recovery_mode).toBe("bandwidth-saver");
		expect(getConfig().fec_enabled).toBe(true);
		expect(getConfig().recovery_mode).toBe("bandwidth-saver");
	});

	test("persists + echoes selected_ingest_endpoint, and getConfig echoes it (Task 18)", async () => {
		const result = await call(
			setConfigProcedure,
			{
				selected_ingest_endpoint: "ep-1",
				srtla_addr: "ingest1.example",
				srtla_port: 5000,
			},
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.selected_ingest_endpoint).toBe("ep-1");
		expect(getConfig().selected_ingest_endpoint).toBe("ep-1");

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.selected_ingest_endpoint).toBe("ep-1");
	});

	test("persists + echoes video_codec and selected_video_input, and getConfig echoes them (Todo 19)", async () => {
		const result = await call(
			setConfigProcedure,
			{ video_codec: "h265", selected_video_input: "cam-0" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.video_codec).toBe("h265");
		expect(result.applied?.selected_video_input).toBe("cam-0");
		expect(getConfig().video_codec).toBe("h265");
		expect(getConfig().selected_video_input).toBe("cam-0");

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.video_codec).toBe("h265");
		expect(echoed.selected_video_input).toBe("cam-0");
	});

	test("persists + echoes source_preference, and getConfig echoes it (config hydration on reload)", async () => {
		const order = ["cam-b", "cam-a"];
		const result = await call(
			setConfigProcedure,
			{ source_preference: order },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.source_preference).toEqual(order);
		expect(getConfig().source_preference).toEqual(order);

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.source_preference).toEqual(order);
	});

	test("getConfig echoes a persisted source + source_preference (F2 Bug 2)", async () => {
		const config = getConfig();
		config.source = "video0";
		config.source_preference = ["video0", "usb0"];

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.source).toBe("video0");
		expect(echoed.source_preference).toEqual(["video0", "usb0"]);

		config.source = undefined;
		config.source_preference = undefined;
	});

	test("clears a stale ingest slot on a non-slot save (round-3 mutual exclusion)", async () => {
		await call(
			setConfigProcedure,
			{
				selected_ingest_endpoint: "ep-1",
				srtla_addr: "ingest1.example",
				srtla_port: 5000,
			},
			{ context: makeContext() },
		);
		expect(getConfig().selected_ingest_endpoint).toBe("ep-1");

		// A managed-relay save sends selected_ingest_endpoint: "" → clears it.
		const result = await call(
			setConfigProcedure,
			{ relay_server: "srv-eu", selected_ingest_endpoint: "" },
			{ context: makeContext() },
		);
		expect(result.applied?.selected_ingest_endpoint).toBe("");
		expect(getConfig().selected_ingest_endpoint).toBeUndefined();
	});

	test("rejects invalid input without a partial write", async () => {
		await call(
			setConfigProcedure,
			{ max_br: 3000 },
			{ context: makeContext() },
		);
		expect(getConfig().max_br).toBe(3000);

		const promise = call(
			setConfigProcedure,
			// max_br above the zod ceiling (50000) — must reject before any write.
			{ max_br: 999999 },
			{ context: makeContext() },
		);
		await expect(promise).rejects.toThrow();

		expect(getConfig().max_br).toBe(3000);
	});

	test.each([
		["catalog", "catalog"],
		["catalog", "slot"],
		["slot", "catalog"],
		["slot", "slot"],
	] as const)(
		"%s → custom → %s persists, echoes and reloads receiver state",
		async (initial, final) => {
			const prior = { ...getConfig() };
			const context = makeContext();
			const saveAndReload = async (
				input: StreamingConfigInput,
				expected: Partial<ConfigMessage>,
			) => {
				const result = await call(setConfigProcedure, input, { context });
				expect(result).toEqual({ success: true, applied: input });
				const echoed = await call(getConfigProcedure, {}, { context });
				expect(echoed).toMatchObject(expected);
				expect(getConfig().remote_provider).toBe("ceralive");

				// Read the bytes written by saveConfig, through the production loader.
				await loadConfig();
				const reloaded = await call(getConfigProcedure, {}, { context });
				expect(reloaded).toMatchObject(expected);
				expect(getConfig().remote_provider).toBe("ceralive");
			};
			const saveManaged = (kind: "catalog" | "slot", latency: number) =>
				saveAndReload(
					kind === "catalog"
						? {
								relay_server: "relay-a",
								relay_account: "account-a",
								relay_streamid_override: "",
								relay_protocol: "srtla",
								selected_ingest_endpoint: "",
								srt_latency: latency,
							}
						: {
								selected_ingest_endpoint: "slot-a",
								srtla_addr: "ingest.example",
								srtla_port: 5000,
								srt_streamid: "publish/managed",
								relay_protocol: "srtla",
								srt_latency: latency,
							},
					{
						relay_server: kind === "catalog" ? "relay-a" : undefined,
						relay_account: kind === "catalog" ? "account-a" : undefined,
						selected_ingest_endpoint: kind === "slot" ? "slot-a" : undefined,
						srtla_addr: kind === "slot" ? "ingest.example" : undefined,
						srtla_port: kind === "slot" ? 5000 : undefined,
						srt_streamid: kind === "slot" ? "publish/managed" : undefined,
						relay_protocol: "srtla",
						srt_latency: latency,
					},
				);

			try {
				getConfig().remote_provider = "ceralive";
				await saveManaged(initial, 2500);
				await saveAndReload(
					{
						srtla_addr: "custom.example",
						srtla_port: 6000,
						srt_streamid: "publish/custom",
						relay_protocol: "srtla",
						selected_ingest_endpoint: "",
						srt_latency: 3000,
					},
					{
						relay_server: undefined,
						relay_account: undefined,
						selected_ingest_endpoint: undefined,
						srtla_addr: "custom.example",
						srtla_port: 6000,
						srt_streamid: "publish/custom",
						relay_protocol: "srtla",
						srt_latency: 3000,
					},
				);
				await saveManaged(final, 4000);
			} finally {
				const config = getConfig();
				for (const key of Object.keys(config))
					Reflect.deleteProperty(config, key);
				Object.assign(config, prior);
			}
		},
	);
});

describe("streaming.setBitrate — applied (post-clamp) state", () => {
	test("resolves with success + the clamped applied bitrate when not streaming", async () => {
		const result = await call(
			setBitrateProcedure,
			{ max_br: OVER_HARDWARE_BITRATE },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
		expect(result.applied).toBeLessThan(OVER_HARDWARE_BITRATE);
	});

	// Regression: a mid-stream hot-adjust persisted config.max_br but published
	// nothing, so every client kept the pre-adjust bitrate and the Live control
	// re-seeded from it on remount — the operator's change vanished on screen.
	test("echoes the hot-adjusted max_br on a config broadcast while streaming", async () => {
		const received: string[] = [];
		const client = captureClient(received);
		updateStatus(true);
		addClient(client);

		try {
			const result = await call(
				setBitrateProcedure,
				{ max_br: HOT_ADJUST_BITRATE },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(result.applied).toBe(HOT_ADJUST_BITRATE);
			expect(getConfig().max_br).toBe(HOT_ADJUST_BITRATE);

			const configPayloads = received
				.map((raw) => JSON.parse(raw))
				.filter(
					(obj): obj is { config: { max_br?: number } } =>
						!!obj && typeof obj === "object" && "config" in obj,
				)
				.map((obj) => obj.config);

			expect(configPayloads.length).toBeGreaterThan(0);
			expect(configPayloads[configPayloads.length - 1].max_br).toBe(
				HOT_ADJUST_BITRATE,
			);
		} finally {
			removeClient(client);
			updateStatus(false);
		}
	});
});

describe("network.configure — applied state", () => {
	const APPLIED_IFACE = "eth-applied-state";
	const APPLIED_IP = "192.168.44.10";

	function seedInterface(): void {
		processIfconfigOutput(
			[
				`${APPLIED_IFACE}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
				`        inet ${APPLIED_IP}  netmask 255.255.255.0  broadcast 192.168.44.255`,
				"        ether aa:bb:cc:dd:ee:44  txqueuelen 1000  (Ethernet)",
				"        RX packets 200  bytes 20000 (20.0 KB)",
				"        TX packets 100  bytes 1000 (1.0 KB)",
				"",
				"eth-applied-peer: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500",
				"        inet 192.168.45.10  netmask 255.255.255.0  broadcast 192.168.45.255",
				"        ether aa:bb:cc:dd:ee:45  txqueuelen 1000  (Ethernet)",
				"        RX packets 200  bytes 20000 (20.0 KB)",
				"        TX packets 100  bytes 1000 (1.0 KB)",
			].join("\n"),
		);
	}

	test("resolves with the applied interface config it wrote", async () => {
		// Driven against an interface that EXISTS, so `applied` describes a write
		// that really happened. The fixture used to be a deliberately-missing
		// interface, which made this assertion vacuous — nothing was written, and
		// the procedure's `{success:true}` was the fabricated-success defect.
		seedInterface();

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: APPLIED_IFACE, ip: APPLIED_IP, enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toEqual({
			name: APPLIED_IFACE,
			ip: APPLIED_IP,
			enabled: false,
		});
		expect(getNetworkInterfaces()[APPLIED_IFACE]?.enabled).toBe(false);
	});

	test("an interface the device does not have is refused, not reported applied", async () => {
		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth-test-missing", enabled: true },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("unknown_interface");
		expect(result.applied).toBeUndefined();
	});
});
