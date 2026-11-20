import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeviceEvent, EVENT_PUSH } from "@ceraui/rpc/schemas";
import ts from "typescript";
import * as emitter from "../modules/events/emit.ts";
import * as store from "../modules/events/store.ts";
import * as bridge from "../rpc/compat.ts";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const cases = ["production", "development", "test"].flatMap((mode) =>
	["linux", "darwin", "win32"].map((platform) => ({ mode, platform })),
);

test.each(cases)(
	"startup installs one working local sink before post-bind events in $mode on $platform",
	async ({ mode, platform }) => {
		const dir = mkdtempSync(join(tmpdir(), "ceraui-events-startup-"));
		const previousDir = process.env.CERALIVE_EVENTS_DIR;
		process.env.CERALIVE_EVENTS_DIR = dir;
		const order = ["store:ready"];
		store.appendEvent(
			{
				id: "seed",
				seq: 40,
				bootId: BOOT,
				at: 1,
				code: "seed",
				family: "device",
				severity: "info",
				params: {},
			},
			{ sync: false },
		);
		const append = store.appendEvent;
		const appendSpy = spyOn(store, "appendEvent").mockImplementation(
			(event, options) => {
				append(event, options);
				order.push("stored");
			},
		);
		const install = emitter.setEventSink;
		const installSpy = spyOn(emitter, "setEventSink").mockImplementation(
			(sink) => {
				order.push("sink");
				install(sink);
			},
		);
		const broadcast = spyOn(bridge, "broadcastMsgLocal").mockImplementation(
			() => {
				order.push("broadcast");
				return "";
			},
		);
		emitter.resetEventEmitterForTest({
			now: () => 1000,
			bootId: () => BOOT,
			log: () => {},
		});
		order.push("emitter:ready");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let startup: Promise<void> | undefined;
		try {
			startup = executeStartup(mode, platform, {
				process: {
					env: { NODE_ENV: mode },
					platform,
					cwd: () => dir,
					on: () => {},
				},
				initServer: async () => {
					order.push("bind:entered");
					entered.resolve();
					await gate.promise;
					order.push("bind:ready");
				},
				notifyServiceReady: () => {
					order.push("post-bind");
					emitter.emitEvent("engine_lost", { streaming: true });
				},
				formatReadyLine: () => order.push("boot:ready"),
			});
			await Promise.race([entered.promise, startup]);
			expect(installSpy.mock.calls.length).toBeLessThanOrEqual(1);
			expect(broadcast).not.toHaveBeenCalled();
			gate.resolve();
			await startup;

			expect(installSpy).toHaveBeenCalledTimes(1);
			expect(installSpy).toHaveBeenNthCalledWith(1, expect.any(Function));
			expect(order.slice(0, 2)).toEqual(["store:ready", "emitter:ready"]);
			expect(order.indexOf("sink")).toBeGreaterThan(1);
			expect(order.indexOf("sink")).toBeLessThan(order.indexOf("post-bind"));
			expect(order.indexOf("bind:ready")).toBeLessThan(
				order.indexOf("post-bind"),
			);
			expect(order.slice(-4)).toEqual([
				"post-bind",
				"stored",
				"broadcast",
				"boot:ready",
			]);
			const event: DeviceEvent = {
				id: "66d8d180-41",
				seq: 41,
				bootId: BOOT,
				at: 1000,
				code: "engine_lost",
				family: "stream",
				severity: "error",
				params: { streaming: true },
			};
			expect(store.readEvents().map((record) => record.seq)).toEqual([40, 41]);
			expect(store.readEvents()[1]).toEqual(event);
			expect(appendSpy).toHaveBeenCalledTimes(1);
			expect(broadcast.mock.calls).toEqual([
				[EVENT_PUSH, { append: [event] }, 0, undefined, true],
			]);
		} finally {
			gate.resolve();
			try {
				await startup;
			} finally {
				emitter.resetEventEmitterForTest();
				installSpy.mockRestore();
				appendSpy.mockRestore();
				broadcast.mockRestore();
				if (previousDir === undefined) delete process.env.CERALIVE_EVENTS_DIR;
				else process.env.CERALIVE_EVENTS_DIR = previousDir;
				rmSync(dir, { recursive: true, force: true });
			}
		}
	},
);

function executeStartup(
	mode: string,
	platform: string,
	collaborators: Record<string, unknown>,
): Promise<void> {
	const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	const parsed = ts.createSourceFile(
		"main.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const inert: unknown = new Proxy(() => inert, {
		get: (_target, key) => {
			if (key === "then") return undefined;
			if (key === Symbol.toPrimitive) return () => 0;
			return inert;
		},
	});
	const dependencies: Record<string, unknown> = {
		runCritical: async (_name: string, run: () => unknown) => run(),
		guardNonCritical: async (_name: string, run: () => unknown) => run(),
		isDevelopment: () => mode === "development",
		shouldUseMocks: () => mode === "development",
		isRealDevice: () => false,
		backendSingletonApplies: () => false,
		...collaborators,
	};
	// One recording spy is shared with the actual module export and every import binding.
	const modules: Record<string, Record<string, unknown>> = {
		"./modules/events/emit.ts": { setEventSink: emitter.setEventSink },
		"./rpc/compat.ts": { broadcastMsgLocal: bridge.broadcastMsgLocal },
		"@ceraui/rpc/schemas": { EVENT_PUSH },
		"node:os": { platform: () => platform },
	};
	const bindings: Record<string, unknown> = {
		process: dependencies.process,
		setInterval: () => ({ unref: () => {} }),
	};
	const body: ts.Statement[] = [];
	for (const statement of parsed.statements) {
		if (!ts.isImportDeclaration(statement)) {
			body.push(statement);
			continue;
		}
		const clause = statement.importClause;
		if (clause?.name) bindings[clause.name.text] = inert;
		const named = clause?.namedBindings;
		if (
			named &&
			ts.isNamedImports(named) &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			for (const specifier of named.elements) {
				const name = (specifier.propertyName ?? specifier.name).text;
				const module = modules[statement.moduleSpecifier.text];
				bindings[specifier.name.text] = module
					? (module[name] ?? inert)
					: (dependencies[name] ?? inert);
			}
		}
	}
	const executable = ts
		.createPrinter()
		.printFile(ts.factory.updateSourceFile(parsed, body));
	const { outputText } = ts.transpileModule(executable, {
		compilerOptions: { target: ts.ScriptTarget.ESNext },
	});
	const execute = new Function(
		...Object.keys(bindings),
		`return (async () => { ${outputText} })();`,
	);
	return execute(...Object.values(bindings));
}
