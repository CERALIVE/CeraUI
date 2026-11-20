import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { guardNonCritical } from "../helpers/boot-guard.ts";
import * as logging from "../helpers/logger.ts";
import {
	initLogSettings,
	setLogSettingsDirForTest,
} from "../modules/device-logs/settings.ts";

const savedSettings = { maxAgeDays: 7, maxSizeMb: 32, detail: "info" } as const;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ceraui-device-log-startup-"));
	setLogSettingsDirForTest(dir);
});

afterEach(() => {
	setLogSettingsDirForTest(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("device log startup wiring", () => {
	test.each(
		["production", "development", "test"].flatMap((mode) =>
			(["info", "debug", null] as const).map((detail) => ({
				mode,
				detail,
				setting: detail ?? "missing file",
			})),
		),
	)(
		"executes one awaited guarded detail init for $setting immediately after CPU in $mode",
		async ({ mode, detail }) => {
			if (detail !== null) {
				writeFileSync(
					join(dir, "log-settings.json"),
					JSON.stringify({ ...savedSettings, detail }),
				);
			}
			const expectedDetail = detail ?? "debug";
			const calls: string[] = [];
			const setDetail = spyOn(logging, "setJournalDetail").mockImplementation(
				(detail) => {
					calls.push(`detail:${detail}`);
				},
			);
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const guarded: typeof guardNonCritical = (subsystem, run, overrides) => {
				if (subsystem === "log-settings") calls.push("guard:log-settings");
				return guardNonCritical(subsystem, run, overrides).then(
					async (result) => {
						if (subsystem === "log-settings") {
							entered.resolve();
							await gate.promise;
							calls.push("guard:complete");
						}
						return result;
					},
				);
			};
			let startupFinished: Promise<void> | undefined;

			try {
				const startup = executeMainBoot(guarded, mode, calls);
				startupFinished = startup;
				let settled = false;
				void startup.then(() => {
					settled = true;
				});
				await Promise.race([entered.promise, startup]);
				expect(settled).toBe(false);
				expect(calls).toEqual([
					"server",
					"cpu",
					"statement",
					"guard:log-settings",
					"init",
					`detail:${expectedDetail}`,
				]);
				expect(setDetail).toHaveBeenCalledTimes(1);
				expect(setDetail).toHaveBeenNthCalledWith(1, expectedDetail);

				gate.resolve();
				await startup;
				expect(settled).toBe(true);
				expect(calls).toEqual([
					"server",
					"cpu",
					"statement",
					"guard:log-settings",
					"init",
					`detail:${expectedDetail}`,
					"guard:complete",
					"statement",
					"statement",
					"encoder",
					"ready",
				]);
				expect(setDetail).toHaveBeenCalledTimes(1);
				expect(setDetail).toHaveBeenNthCalledWith(1, expectedDetail);
			} finally {
				gate.resolve();
				await startupFinished;
				setDetail.mockRestore();
			}
		},
	);

	test("a direct second init reapplies detail per the todo contract", () => {
		writeFileSync(
			join(dir, "log-settings.json"),
			JSON.stringify(savedSettings),
		);
		const setDetail = spyOn(logging, "setJournalDetail");
		try {
			initLogSettings();
			initLogSettings();
			expect(setDetail).toHaveBeenCalledTimes(2);
			expect(setDetail).toHaveBeenNthCalledWith(1, "info");
			expect(setDetail).toHaveBeenNthCalledWith(2, "info");
		} finally {
			setDetail.mockRestore();
		}
	});
});

function executeMainBoot(
	guard: typeof guardNonCritical,
	mode: string,
	calls: string[],
): Promise<void> {
	const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	const parsed = ts.createSourceFile(
		"main.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	// Unrelated imports are inert; every executable statement is retained.
	const inert: unknown = new Proxy(() => inert, {
		get: (_target, key) => {
			if (key === "then") return undefined;
			if (key === Symbol.toPrimitive) return () => 0;
			return inert;
		},
	});
	let betweenCpuAndEncoder = false;
	const collaborators: Record<string, unknown> = {
		guardNonCritical: guard,
		runCritical: async (_name: string, run: () => unknown) => run(),
		isDevelopment: () => mode === "development",
		shouldUseMocks: () => false,
		isRealDevice: () => false,
		backendSingletonApplies: () => false,
		initServer: () => calls.push("server"),
		initCpu: () => {
			calls.push("cpu");
			betweenCpuAndEncoder = true;
		},
		initEncoderLoad: () => {
			calls.push("encoder");
			betweenCpuAndEncoder = false;
		},
		formatReadyLine: () => calls.push("ready"),
		setJournalDetail: logging.setJournalDetail,
	};
	const bindings: Record<string, unknown> = {
		process: { env: { NODE_ENV: mode }, cwd: () => dir, on: () => {} },
		setInterval: () => ({ unref: () => {} }),
		recordStatement: () => {
			if (betweenCpuAndEncoder) calls.push("statement");
		},
	};
	const body: ts.Statement[] = [];
	for (const statement of parsed.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (clause?.name) bindings[clause.name.text] = inert;
			const named = clause?.namedBindings;
			if (named && ts.isNamedImports(named)) {
				for (const specifier of named.elements) {
					const name = (specifier.propertyName ?? specifier.name).text;
					const isSettings =
						ts.isStringLiteral(statement.moduleSpecifier) &&
						statement.moduleSpecifier.text ===
							"./modules/device-logs/settings.ts";
					bindings[specifier.name.text] =
						isSettings && name === "initLogSettings"
							? () => {
									calls.push("init");
									initLogSettings();
								}
							: (collaborators[name] ?? inert);
				}
			}
		} else {
			body.push(
				ts.factory.createExpressionStatement(
					ts.factory.createCallExpression(
						ts.factory.createIdentifier("recordStatement"),
						undefined,
						[],
					),
				),
				statement,
			);
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
