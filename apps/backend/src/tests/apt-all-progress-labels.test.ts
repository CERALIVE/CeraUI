/// <reference types="bun" />

import { expect, it } from "bun:test";
import {
	assertPinnedInstallSimulation,
	discoverAptAllPackages,
} from "../modules/system/apt-all-packages.ts";
import { opiAptSection } from "./helpers/apt-opi-capture.ts";

// apt 3.0.3 (45bebdfb): pkgcachegen.cc, depcache.cc, upgrade.cc and edsp.cc.
// Source/progress table: docs/agents/software-update-check-contract.md.
const labels = [
	"Reading package lists",
	"Building dependency tree",
	"Reading state information",
	"Calculating upgrade",
	"Solving dependencies",
] as const;
// Correcting dependencies requires FixBroken (-f), never passed by these product paths.
const pairs = [{ name: "nginx", version: "1.26.3-3+deb13u10" }];
const row =
	"Inst nginx [1.26.3-3+deb13u9] (1.26.3-3+deb13u10 Debian-Security:13/stable-security [arm64])";

it.each(labels)(
	"accepts stdout progress %j at both simulation entry points",
	async (label) => {
		// Given: OpTextProgress's non-TTY operation text before a valid row.
		for (const suffix of ["...", "... Done"]) {
			const text = `${label}${suffix}\n${row}\n`;
			// When
			const discovery = await discoverAptAllPackages(
				text,
				"",
				async () => opiAptSection("PKG-nginx"),
				opiAptSection("POLICY"),
			);
			// Then
			expect(discovery.actionable).toEqual(pairs);
			expect(() => assertPinnedInstallSimulation(text, pairs)).not.toThrow();
		}
	},
);

it.each(labels)(
	"still refuses a malformed Inst after progress %j",
	async (label) => {
		// Given
		const text = `${label}...\n${row}\nInst malformed (not-a-version Debian [arm64])\n`;
		// When/Then
		await Promise.resolve(
			expect(
				discoverAptAllPackages(
					text,
					"",
					async () => opiAptSection("PKG-nginx"),
					opiAptSection("POLICY"),
				),
			).rejects.toThrow("discovery_failed"),
		);
		expect(() => assertPinnedInstallSimulation(text, pairs)).toThrow(
			"discovery_failed",
		);
	},
);
