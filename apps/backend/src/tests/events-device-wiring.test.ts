import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "winston";
import { emitDeviceEvent } from "../modules/events/device-emit.ts";
import * as emitter from "../modules/events/emit.ts";
import {
	type DeviceStatsPayload,
	initDeviceStats,
} from "../modules/system/device-stats.ts";
import { monitorBootconfig } from "../modules/system/sensors.ts";

afterEach(() => {
	spyOn(emitter, "emitEvent").mockRestore();
	emitter.resetEventEmitterForTest();
});

test.each([
	{
		name: "boot observes ready modem discovery once while the guarded version record is pending",
		signal: undefined,
	},
	{
		name: "the shipped SIGTERM handler revokes a held engine recovery probe",
		signal: "SIGTERM",
	},
	{
		name: "the shipped SIGINT handler revokes a held engine recovery probe",
		signal: "SIGINT",
	},
])(
	"$name",
	async ({ signal }) => {
		const cwd = await mkdtemp(resolve(tmpdir(), "ceraui_event_boot_"));
		try {
			// Mock boot checks that the sender is readable but never runs it.
			const senderPath = join(cwd, "srtla_send");
			await Bun.write(senderPath, "");
			await Bun.write(
				join(cwd, "setup.json"),
				JSON.stringify({
					hw: "n100",
					srtla_path: senderPath,
					cerastream_socket: join(cwd, "engine.sock"),
				}),
			);
			const boot = Bun.spawn(
				[
					"nice",
					"-n",
					"19",
					process.execPath,
					fileURLToPath(
						new URL("./helpers/events-boot-probe.ts", import.meta.url),
					),
					...(signal === undefined ? [] : [signal]),
				],
				{
					cwd,
					env: {
						...process.env,
						NODE_ENV: "development",
						MOCK_SCENARIO: "single-modem",
						CERALIVE_DEVICE_TYPE: "emulated",
						CERALIVE_EVENTS_DIR: join(cwd, "events"),
						CERALIVE_STREAMING_MARKER: join(cwd, "streaming"),
						NOTIFY_SOCKET: "",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 8_000,
					killSignal: "SIGKILL",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				boot.exited,
				new Response(boot.stdout).text(),
				new Response(boot.stderr).text(),
			]);
			const diagnostic = [boot.signalCode, stderr, stdout]
				.filter(Boolean)
				.join("\n");
			expect(exitCode, diagnostic || "mock boot did not finish").toBe(0);
			if (signal !== undefined) {
				expect(
					stdout
						.split("\n")
						.filter((line) => line.startsWith("ENGINE_RECOVERY_SHUTDOWN ")),
				).toEqual([`ENGINE_RECOVERY_SHUTDOWN ${signal} false`]);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
	12_000,
);

for (const enabled of [false, true]) {
	for (const failed of [false, true]) {
		for (const throws of [false, true]) {
			test(`bootloader enabled=${enabled} failed=${failed} throwing emitter=${throws}`, async () => {
				const events: unknown[][] = [];
				const notices: unknown[][] = [];
				const timers: unknown[][] = [];
				const removes: string[] = [];
				spyOn(emitter, "emitEvent").mockImplementation((...args) => {
					events.push(args);
					if (throws) throw new Error("broken bootloader consumer");
				});
				await monitorBootconfig({
					bootconfigService: "ceralive-firstboot-bootconfig",
					isServiceEnabled: async () => enabled,
					isServiceFailed: async () => failed,
					notificationExists: () => undefined,
					notificationRemove: (name) => removes.push(name),
					notificationBroadcast: (...args) => notices.push(args),
					setTimeout: (...args) => timers.push(args),
					emitDeviceEvent,
				});
				expect(events).toEqual(
					enabled && failed ? [["bootloader_update_failed", {}]] : [],
				);
				expect(notices).toHaveLength(enabled ? 1 : 0);
				expect(timers).toHaveLength(enabled && !failed ? 1 : 0);
				expect(removes).toEqual(enabled ? [] : ["bootconfig"]);
			});
		}
	}
}

test("stats tick passes each completed disk sample to its one retained observer", async () => {
	const sample: DeviceStatsPayload = {
		disk: { used: 100, total: 200, type: "SSD" },
		cpuLoad1: null,
		socTemp: null,
		ifaceRxTx: null,
		raucSlot: "unavailable",
	};
	const calls: unknown[] = [];
	let tick: (() => Promise<void>) | undefined;
	let created = 0;
	const observed = Promise.withResolvers<void>();
	const logger = createLogger({ silent: true });
	initDeviceStats({
		DEVICE_STATS_INTERVAL_MS: 5000,
		DEVICE_STATS_EVENT: "device-stats",
		ACTIVE_TO: 0,
		createDiskEventObserver: () => {
			created++;
			return (disk) => calls.push(disk);
		},
		collectDeviceStats: async () => sample,
		resolveDeviceStatsDeps: () => ({
			readText: async () => "",
			readDir: async () => [],
			execFile: async () => ({ stdout: "", stderr: "" }),
			getSocTempRaw: () => undefined,
			now: () => 0,
		}),
		deviceStatsState: {},
		recordDeviceStatsSnapshot: () => {},
		broadcastMsg: () => observed.resolve(),
		getms: () => 0,
		logger: {
			error: (error: unknown) => {
				observed.reject(error);
				return logger;
			},
		},
		setInterval: (run) => {
			tick = run;
		},
	});
	await observed.promise;
	if (!tick) throw new Error("missing stats timer");
	await tick();
	expect(created).toBe(1);
	expect(calls).toEqual([sample.disk, sample.disk]);
});
