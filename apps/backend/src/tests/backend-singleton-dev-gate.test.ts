import { expect, test } from "bun:test";
import { backendSingletonApplies } from "../helpers/backend-singleton.ts";

test.each([
	["development", false],
	["production", true],
	[undefined, true],
	["", true],
	["Development", true],
	["DEVELOPMENT", true],
	["test", true],
	["staging", true],
	[" development", true],
] as const)(
	"singleton applicability for NODE_ENV=%p is %p",
	(nodeEnv, applies) => {
		// Given no ambient default that could hide the undefined case.
		const original = process.env.NODE_ENV;
		delete process.env.NODE_ENV;
		try {
			// When the explicitly supplied environment is classified.
			const actual = backendSingletonApplies(nodeEnv);
			// Then only exact source development is exempt.
			expect(actual).toBe(applies);
		} finally {
			if (original === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = original;
		}
	},
);

test.each([
	["development", false],
	["production", true],
	[undefined, true],
] as const)("singleton default reads NODE_ENV=%p as %p", (nodeEnv, applies) => {
	// Given the process environment, restored even after an assertion failure.
	const original = process.env.NODE_ENV;
	if (nodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = nodeEnv;
	try {
		// When boot omits the predicate argument.
		const actual = backendSingletonApplies();
		// Then the direct environment read controls applicability.
		expect(actual).toBe(applies);
	} finally {
		if (original === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = original;
	}
});

test("main gates the critical singleton after signal guards and before executable preflight", async () => {
	// Given the shipped entry module rather than a simulated boot sequence.
	const source = await Bun.file(new URL("../main.ts", import.meta.url)).text();
	const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
	// When the source-development branch and its surrounding boot steps are read.
	const branch = code.match(
		/if\s*\(backendSingletonApplies\(\)\)\s*\{\s*await runCritical\("backend-singleton", enforceBackendSingleton\);\s*\}\s*else\s*\{/,
	);
	const guards = code.indexOf("installBootSignalGuards();");
	const preflight = code.indexOf("checkExecPath(");
	const singleton = code.indexOf(
		'await runCritical("backend-singleton", enforceBackendSingleton)',
	);
	// Then enforcement remains critical and in its original boot position.
	expect(branch).not.toBeNull();
	expect(guards).toBeGreaterThan(-1);
	expect(branch?.index).toBeGreaterThan(guards);
	expect(preflight).toBeGreaterThan(singleton);
	expect(code.match(/await runCritical\("backend-singleton",/g)).toHaveLength(
		1,
	);
});
