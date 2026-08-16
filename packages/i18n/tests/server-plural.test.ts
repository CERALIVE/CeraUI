import { describe, expect, it } from "bun:test";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATED = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"generated",
);

const { m } = (await import(join(GENERATED, "registry.js"))) as {
	m: Record<
		string,
		((inputs?: Record<string, unknown>, options?: { locale: string }) => string)
	>;
};

describe("live.server.bondedAcross", () => {
	it("renders the singular noun at count=1", () => {
		expect(m["live.server.bondedAcross"]?.({ count: 1 })).toBe(
			"Bonded across 1 link",
		);
	});

	it("renders the plural noun at count=3", () => {
		expect(m["live.server.bondedAcross"]?.({ count: 3 })).toBe(
			"Bonded across 3 links",
		);
	});

	it("renders the plural noun at count=0", () => {
		expect(m["live.server.bondedAcross"]?.({ count: 0 })).toBe(
			"Bonded across 0 links",
		);
	});
});
