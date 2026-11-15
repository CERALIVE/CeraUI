import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
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

test("main boot guard logs versions before recording device start", async () => {
	const file = source("../main.ts");
	let expression: ts.CallExpression | undefined;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(file) === "guardNonCritical" &&
			node.arguments[0] &&
			ts.isStringLiteral(node.arguments[0]) &&
			node.arguments[0].text === "boot-record"
		)
			expression = node;
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (!expression) throw new Error("missing boot guard");
	const calls: string[] = [];
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const boot = evaluate(`return ${expression.getText(file)}`, {
		guardNonCritical: async (name: string, run: () => Promise<void>) => {
			calls.push(name);
			await run();
			calls.push("guard-complete");
		},
		initRevisions: async () => {
			calls.push("revisions");
		},
		logBootRecord: async () => {
			calls.push("log");
		},
		recordDeviceStart: async () => {
			calls.push("start");
			started.resolve();
			await finish.promise;
			calls.push("recorded");
		},
	});
	await started.promise;
	expect(calls).toEqual(["boot-record", "revisions", "log", "start"]);
	finish.resolve();
	await boot;
	expect(calls).toEqual([
		"boot-record",
		"revisions",
		"log",
		"start",
		"recorded",
		"guard-complete",
	]);
});

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
