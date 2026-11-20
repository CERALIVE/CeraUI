import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { guardNonCritical } from "../helpers/boot-guard.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";

test.each(["production", "development", "test"])(
	"retention is awaited immediately after settings and fails soft in %s",
	async (mode) => {
		for (const fails of [false, true]) {
			resetBootReadiness();
			const order: string[] = [];
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const startup = executeMain(mode, {
				initServer: () => order.push("server"),
				initLogSettings: () => order.push("settings"),
				initLogRetention: async () => {
					order.push("retention");
					entered.resolve();
					await release.promise;
					if (fails) throw new Error("retention filesystem unavailable");
				},
				initEncoderLoad: () => order.push("encoder"),
				guardNonCritical: (name: string, run: () => void | Promise<void>) => {
					if (name === "log-retention") order.push("guard:log-retention");
					return guardNonCritical(name, run, {
						logger: { info() {}, error() {} },
					});
				},
			});
			try {
				await Promise.race([entered.promise, startup]);
				expect(order).toEqual([
					"server",
					"settings",
					"guard:log-retention",
					"retention",
				]);
				release.resolve();
				await startup;
				expect(order).toEqual([
					"server",
					"settings",
					"guard:log-retention",
					"retention",
					"encoder",
				]);
				expect(getBootReadiness().degradedSubsystems).toEqual(
					fails ? ["log-retention"] : [],
				);
			} finally {
				release.resolve();
				await startup;
				resetBootReadiness();
			}
		}
	},
);

function executeMain(
	mode: string,
	collaborators: Record<string, unknown>,
): Promise<void> {
	const source = ts.createSourceFile(
		"main.ts",
		readFileSync(new URL("../main.ts", import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const inert: unknown = new Proxy(() => inert, {
		get: (_target, key) =>
			key === "then" ? undefined : key === Symbol.toPrimitive ? () => 0 : inert,
	});
	const dependencies: Record<string, unknown> = {
		runCritical: async (_name: string, run: () => unknown) => run(),
		isDevelopment: () => mode === "development",
		shouldUseMocks: () => false,
		isRealDevice: () => false,
		backendSingletonApplies: () => false,
		...collaborators,
	};
	const bindings: Record<string, unknown> = {
		process: { env: { NODE_ENV: mode }, cwd: () => "/tmp", on() {} },
		setInterval: () => ({ unref() {} }),
	};
	const body: ts.Statement[] = [];
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) {
			body.push(statement);
			continue;
		}
		const clause = statement.importClause;
		if (clause?.name) bindings[clause.name.text] = inert;
		const named = clause?.namedBindings;
		if (named && ts.isNamedImports(named))
			for (const specifier of named.elements) {
				const name = (specifier.propertyName ?? specifier.name).text;
				bindings[specifier.name.text] = dependencies[name] ?? inert;
			}
	}
	const code = ts
		.createPrinter()
		.printFile(ts.factory.updateSourceFile(source, body));
	const { outputText } = ts.transpileModule(code, {
		compilerOptions: { target: ts.ScriptTarget.ESNext },
	});
	return new Function(
		...Object.keys(bindings),
		`return (async () => { ${outputText} })();`,
	)(...Object.values(bindings));
}
