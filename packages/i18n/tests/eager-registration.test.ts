import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateRegistry } from "../scripts/generate-registry.js";

const scratch = fileURLToPath(new URL("../test-results/", import.meta.url));
const directories: string[] = [];

async function freshCatalog() {
	mkdirSync(scratch, { recursive: true });
	const outDir = mkdtempSync(join(scratch, "eager-registration-"));
	directories.push(outDir);
	generateRegistry({ outDir });
	const registry: typeof import("../generated/registry.js") = await import(
		pathToFileURL(join(outDir, "registry.js")).href
	);
	const eager: typeof import("../generated/eager.js") = await import(
		pathToFileURL(join(outDir, "eager.js")).href
	);
	return { registry, eager };
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("eager catalog registration", () => {
	it("registers once when three standalone entries share one catalog", async () => {
		// Given the catalog shared by the Encoder, Audio and Server entrypoints
		const { registry, eager } = await freshCatalog();
		using writes = spyOn(registry, "registerNamespaces");
		// When all three entrypoints activate their messages
		for (let entry = 0; entry < 3; entry++) eager.registerAllNamespaces();
		// Then the real registry is filled once and retains translated functions
		expect(writes).toHaveBeenCalledTimes(1);
		expect(registry.resolveMessageKey("live.setup.title")).toBe("Stream setup");
		expect(registry.NAMESPACES.every(registry.isNamespaceLoaded)).toBe(true);
	});

	it("registers a fresh registry independently of an initialized one", async () => {
		// Given an initialized catalog, as in a preceding isolated worker
		const first = await freshCatalog();
		first.eager.registerAllNamespaces();
		const second = await freshCatalog();
		using writes = spyOn(second.registry, "registerNamespaces");
		// When another independent catalog initializes
		second.eager.registerAllNamespaces();
		// Then no process-global flag suppresses its necessary registration
		expect(writes).toHaveBeenCalledTimes(1);
		expect(second.registry.resolveMessageKey("live.setup.title")).toBe(
			"Stream setup",
		);
	});

	it("retries when registration throws before completion", async () => {
		// Given a registration which did not complete
		const { registry, eager } = await freshCatalog();
		const failure = new Error("registration interrupted");
		using writes = spyOn(registry, "registerNamespaces").mockImplementationOnce(
			() => {
				throw failure;
			},
		);
		expect(() => eager.registerAllNamespaces()).toThrow(failure);
		// When a later entrypoint tries again
		eager.registerAllNamespaces();
		// Then failure was not memoized as successful initialization
		expect(writes).toHaveBeenCalledTimes(2);
		expect(registry.NAMESPACES.every(registry.isNamespaceLoaded)).toBe(true);
	});
});
