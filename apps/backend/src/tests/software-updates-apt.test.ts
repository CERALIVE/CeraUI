/*
 * Task 11 — apt-get is now invoked argv-only (no shell interpolation, no
 * `args.split(" ")`). These tests pin the security-critical contract:
 *
 *   - a held-back package list maps to one argv element per package;
 *   - each package name is charset-validated, so a name carrying shell
 *     metacharacters or whitespace is rejected before it can reach apt-get.
 */
import { describe, expect, it } from "bun:test";
import { isParseError } from "../modules/system/cli-parse.ts";
import {
	buildAptInstallArgs,
	buildAptUpgradeArgs,
	classifyAptUpdateResult,
	parseAptUpgradeSummary,
	parseHeldBackPackages,
} from "../modules/system/software-updates.ts";

describe("parseHeldBackPackages() — charset validation", () => {
	it("splits a whitespace-separated list into individual package names", () => {
		expect(parseHeldBackPackages("pkg-a pkg-b")).toEqual(["pkg-a", "pkg-b"]);
	});

	it("accepts Debian-name punctuation (. + : ~ -)", () => {
		expect(parseHeldBackPackages("lib.foo g++ a:b1 x~rc-1")).toEqual([
			"lib.foo",
			"g++",
			"a:b1",
			"x~rc-1",
		]);
	});

	it("collapses irregular whitespace and drops empty tokens", () => {
		expect(parseHeldBackPackages("  pkg-a   pkg-b \n pkg-c ")).toEqual([
			"pkg-a",
			"pkg-b",
			"pkg-c",
		]);
	});

	it("rejects a name carrying shell metacharacters", () => {
		expect(() => parseHeldBackPackages("pkg; rm -rf /")).toThrow(
			/invalid package name/,
		);
	});

	it("rejects a single poisoned name embedded in a valid list", () => {
		expect(() => parseHeldBackPackages("good-pkg $(reboot)")).toThrow(
			/invalid package name/,
		);
	});
});

describe("buildAptInstallArgs() — argv mapping", () => {
	it("maps the package list to one argv element each, after install --assume-no", () => {
		expect(buildAptInstallArgs(["pkg-a", "pkg-b"])).toEqual([
			"install",
			"--assume-no",
			"pkg-a",
			"pkg-b",
		]);
	});
});

describe("buildAptUpgradeArgs() — argv mapping", () => {
	const base = [
		"-y",
		"-o",
		"Dpkg::Options::=--force-confdef",
		"-o",
		"Dpkg::Options::=--force-confold",
	];

	it("dist-upgrades when there are no held-back packages", () => {
		expect(buildAptUpgradeArgs()).toEqual([...base, "dist-upgrade"]);
		expect(buildAptUpgradeArgs([])).toEqual([...base, "dist-upgrade"]);
	});

	it("installs held-back packages as separate argv elements", () => {
		expect(buildAptUpgradeArgs(["pkg-a", "pkg-b"])).toEqual([
			...base,
			"install",
			"pkg-a",
			"pkg-b",
		]);
	});
});

describe("classifyAptUpdateResult() — Bun.$ exit/stderr classification (Task 16)", () => {
	it("exit 0 with no stderr → null (success)", () => {
		expect(classifyAptUpdateResult(0, "")).toBeNull();
	});

	it("exit 0 but stderr present → true (treated as error, legacy semantics)", () => {
		expect(classifyAptUpdateResult(0, "W: some warning")).toBe(true);
	});

	it("non-zero exit with no stderr → ExecException-shaped error carrying the code", () => {
		const res = classifyAptUpdateResult(100, "");
		expect(res).toBeInstanceOf(Error);
		expect((res as Error & { code?: number }).code).toBe(100);
	});

	it("non-zero exit with stderr → true (stderr dominates the classification)", () => {
		expect(classifyAptUpdateResult(100, "E: failed")).toBe(true);
	});
});

describe("parseAptUpgradeSummary() — named fail-loud apt parser", () => {
	it("parses upgraded + newly-installed count, download size, and CeraLive package presence", () => {
		const result = parseAptUpgradeSummary(`
The following packages will be upgraded:
  ceraui unrelated
2 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.
Need to get 12.3 MB/44.0 MB of archives.
`);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				upgradeCount: 3,
				downloadSize: "12.3 MB",
				ceralivePackages: true,
			});
		}
	});

	it("treats zero updates as a valid summary without requiring size or package headings", () => {
		const result = parseAptUpgradeSummary(
			"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				upgradeCount: 0,
				ceralivePackages: false,
			});
		}
	});

	it("fails loud when apt's count line drifts", () => {
		const result = parseAptUpgradeSummary("apt output changed shape");
		expect(isParseError(result)).toBe(true);
		if (!result.ok) expect(result.reason).toContain("upgraded/newly installed");
	});

	it("fails loud when upgrades exist but the download-size line is missing", () => {
		const result = parseAptUpgradeSummary(`
The following packages will be upgraded:
  ceraui
1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
`);
		expect(isParseError(result)).toBe(true);
		if (!result.ok) expect(result.reason).toContain("Need to get");
	});
});
