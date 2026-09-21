import { describe, expect, test } from "vitest";

import { splitVersionValue } from "./version-display";

describe("splitVersionValue — the Versions dialog row format", () => {
	/**
	 * Captured by RUNNING the shipped `srtla_4.1.0_amd64.deb`, not inferred from
	 * the `-v` grammar: the release builds in a container with no usable git
	 * context, so `build.rs` resolves no commit and omits the parenthetical.
	 */
	test("drops the package tag on the shipped release, which carries no git context", () => {
		expect(splitVersionValue("4.1.0 [srtla_send]")).toEqual({ value: "4.1.0" });
	});

	/**
	 * A tag build checks out a detached HEAD, so when git IS resolvable the
	 * metadata is a bare commit with no `branch@` prefix.
	 */
	test("promotes the version and demotes a bare-commit tag build", () => {
		expect(splitVersionValue("4.1.0 (7d4c1af) [srtla_send]")).toEqual({
			value: "4.1.0",
			detail: "7d4c1af",
		});
	});

	test("promotes the version and demotes a dev build's branch@commit metadata", () => {
		expect(splitVersionValue("4.1.0 (main@974c8b9) [srtla_send]")).toEqual({
			value: "4.1.0",
			detail: "main@974c8b9",
		});
	});

	test("keeps a dirty marker with the rest of the build metadata", () => {
		expect(
			splitVersionValue("4.1.0 (main@974c8b9-dirty) [srtla_send]"),
		).toEqual({
			value: "4.1.0",
			detail: "main@974c8b9-dirty",
		});
	});

	test("leaves a bare version untouched", () => {
		expect(splitVersionValue("2026.7.2")).toEqual({ value: "2026.7.2" });
	});

	test("leaves a kernel release untouched — its hyphens are not metadata", () => {
		expect(splitVersionValue("6.1.115-vendor-rk35xx")).toEqual({
			value: "6.1.115-vendor-rk35xx",
		});
	});

	test("leaves an honest failure value readable rather than parsing it apart", () => {
		expect(splitVersionValue("engine unreachable")).toEqual({
			value: "engine unreachable",
		});
		expect(splitVersionValue("unknown revision")).toEqual({
			value: "unknown revision",
		});
	});

	/**
	 * The regression this module exists for: the placeholder string that shipped
	 * on device must never be silently promoted into a clean-looking version.
	 */
	test("a legacy placeholder line still surfaces its metadata rather than hiding it", () => {
		expect(
			splitVersionValue("3.2.0 (unknown@unknown-dirty) [srtla_send]"),
		).toEqual({
			value: "3.2.0",
			detail: "unknown@unknown-dirty",
		});
	});

	test("a line that is only a parenthetical is left whole", () => {
		expect(splitVersionValue("(main@974c8b9)")).toEqual({
			value: "(main@974c8b9)",
		});
	});

	test("an empty parenthetical yields no secondary line", () => {
		expect(splitVersionValue("3.2.0 () [srtla_send]")).toEqual({
			value: "3.2.0",
		});
	});

	test("trims surrounding whitespace", () => {
		expect(splitVersionValue("  2026.7.2  ")).toEqual({ value: "2026.7.2" });
	});
});
