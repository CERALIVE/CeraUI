/// <reference types="bun" />

import { expect, it } from "bun:test";
import {
	buildAptAllInstallArgs,
	discoverAptAllPackages,
} from "../modules/system/apt-all-packages.ts";
import {
	expectedAptAllScript,
	isExpectedAptAllInstallArgv,
} from "../modules/system/software-update-service-contract.ts";
import { opiAptSection } from "./helpers/apt-opi-capture.ts";

const version = "1.26.3-3+deb13u10";

async function discover(names: readonly string[]) {
	return discoverAptAllPackages(
		names
			.map(
				(name) =>
					`Inst ${name} (${version} Debian-Security:13/stable-security [arm64])`,
			)
			.join("\n"),
		"",
		async () => opiAptSection("PKG-nginx"),
		opiAptSection("POLICY"),
	);
}

it.each([
	["libconfig++11", "libconfig-doc"],
	["libsigc++-2.0-0v5", "libsigc-dev"],
	["libxml++2.6-2v5", "libxml-dev"],
])("launches the discovered punctuation set %j", async (left, right) => {
	// Given: generated package identities using the captured allowed-source policy.
	const names = [left, right];
	const { actionable } = await discover(names);
	// When
	const args = buildAptAllInstallArgs(actionable, "any");
	// Then
	expect(actionable.map(({ name }) => name)).toEqual([...names].sort());
	expect(() => expectedAptAllScript(args, [])).not.toThrow();
});

it("agrees on code-unit order for every generated punctuation/architecture pair", async () => {
	// Given
	const names = ["libconfig", "libsigc", "libxml", "pkg"].flatMap((name) =>
		["++11", "-doc", ".data", ":arm64", ":armhf"].map(
			(suffix) => name + suffix,
		),
	);
	// When/Then: check both input permutations and reject the reversed argv.
	for (const left of names)
		for (const right of names) {
			if (left === right) continue;
			const expected = [left, right].sort();
			const { actionable } = await discover([left, right]);
			expect(actionable.map(({ name }) => name)).toEqual(expected);
			const args = buildAptAllInstallArgs(actionable, "any");
			expect(() => expectedAptAllScript(args, [])).not.toThrow();
			const reversed = buildAptAllInstallArgs([...actionable].reverse(), "any");
			expect(
				isExpectedAptAllInstallArgv(["/usr/bin/apt-get", ...reversed]),
			).toBe(false);
		}
});
