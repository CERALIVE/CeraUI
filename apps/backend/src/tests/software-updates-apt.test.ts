/*
 * Task 11 — apt-get is now invoked argv-only (no shell interpolation, no
 * `args.split(" ")`). These tests pin the security-critical contract:
 *
 *   - a held-back package list maps to one argv element per package;
 *   - each package name is charset-validated, so a name carrying shell
 *     metacharacters or whitespace is rejected before it can reach apt-get.
 */
import { describe, expect, it } from "bun:test";

import {
	buildAptInstallArgs,
	buildAptUpgradeArgs,
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
