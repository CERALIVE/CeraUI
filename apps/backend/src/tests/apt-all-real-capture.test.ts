/// <reference types="bun" />

import { expect, it } from "bun:test";
import {
	assertPinnedInstallSimulation,
	discoverAptAllPackages,
} from "../modules/system/apt-all-packages.ts";
import { opiAptSection, opiNginxPairs } from "./helpers/apt-opi-capture.ts";

it("discovers all three security upgrades when apt prints temporary breaks", async () => {
	// Given: unchanged read-only Orange Pi command output, 2026-10-22.
	const simulation = opiAptSection("SIM");
	// When
	const result = await discoverAptAllPackages(
		simulation,
		opiAptSection("HOLDS"),
		async (name) => opiAptSection(`PKG-${name}`),
		opiAptSection("POLICY"),
	);
	// Then: eligibility still comes from source policy, not annotation names.
	expect(result.actionable).toEqual([...opiNginxPairs]);
	expect(result.packages).toEqual(
		[opiNginxPairs[1], opiNginxPairs[0], opiNginxPairs[2]].map((pair) => ({
			...pair,
			origin: "Debian trixie-security",
			layer: "app",
			actionable: true,
		})),
	);
});

it("accepts the captured temporary breaks at the pinned install recheck", () => {
	// Given
	const simulation = opiAptSection("SIM");
	// When/Then
	expect(() =>
		assertPinnedInstallSimulation(simulation, opiNginxPairs),
	).not.toThrow();
});
