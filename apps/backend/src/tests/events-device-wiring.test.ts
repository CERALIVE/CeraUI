import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { emitDeviceEvent } from "../modules/events/device-emit.ts";
import * as emitter from "../modules/events/emit.ts";

afterEach(() => {
	spyOn(emitter, "emitEvent").mockRestore();
	emitter.resetEventEmitterForTest();
});

// Execute the real composition nodes with recording ports, without booting host services.
function source(path: string) {
	return ts.createSourceFile(
		path,
		readFileSync(new URL(path, import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
}
function evaluate(text: string, ports: Record<string, unknown>): unknown {
	const output = ts.transpile(text, {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.None,
	});
	return new Function(...Object.keys(ports), output)(...Object.values(ports));
}
function declaration(path: string, name: string): string {
	const file = source(path);
	const node = file.statements.find(
		(s) => ts.isFunctionDeclaration(s) && s.name?.text === name,
	);
	if (!node) throw new Error(`missing function ${name}`);
	return node.getText(file).replace(/^export /, "");
}

test("boot observes ready modem discovery once while the guarded version record is pending", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ceraui-event-boot-"));
	try {
		// Mock boot checks that the sender is readable but never runs it.
		const senderPath = join(cwd, "srtla_send");
		await Bun.write(senderPath, "");
		await Bun.write(
			join(cwd, "setup.json"),
			JSON.stringify({ hw: "n100", srtla_path: senderPath }),
		);
		const boot = Bun.spawn(
			[
				process.execPath,
				fileURLToPath(
					new URL("./helpers/events-boot-probe.ts", import.meta.url),
				),
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
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 12_000);

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
				const run = evaluate(
					`${declaration("../modules/system/sensors.ts", "monitorBootconfig")}; return monitorBootconfig();`,
					{
						bootconfigService: "ceralive-firstboot-bootconfig",
						isServiceEnabled: async () => enabled,
						isServiceFailed: async () => failed,
						notificationExists: () => false,
						notificationRemove: (name: string) => removes.push(name),
						notificationBroadcast: (...args: unknown[]) => notices.push(args),
						setTimeout: (...args: unknown[]) => timers.push(args),
						emitDeviceEvent,
					},
				);
				await run;
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
	const sample = { disk: { used: 100, total: 200, type: "SSD" } };
	const calls: unknown[] = [];
	let tick: (() => Promise<void>) | undefined;
	let created = 0;
	const observed = Promise.withResolvers<void>();
	evaluate(
		`${declaration("../modules/system/device-stats.ts", "initDeviceStats")}; initDeviceStats();`,
		{
			DEVICE_STATS_INTERVAL_MS: 5000,
			DEVICE_STATS_EVENT: "device-stats",
			ACTIVE_TO: 0,
			createDiskEventObserver: () => {
				created++;
				return (disk: unknown) => calls.push(disk);
			},
			collectDeviceStats: async () => sample,
			resolveDeviceStatsDeps: () => ({}),
			deviceStatsState: {},
			recordDeviceStatsSnapshot: () => {},
			broadcastMsg: () => observed.resolve(),
			getms: () => 0,
			logger: { error: (error: unknown) => observed.reject(error) },
			setInterval: (run: () => Promise<void>) => {
				tick = run;
			},
		},
	);
	await observed.promise;
	if (!tick) throw new Error("missing stats timer");
	await tick();
	expect(created).toBe(1);
	expect(calls).toEqual([sample.disk, sample.disk]);
});
