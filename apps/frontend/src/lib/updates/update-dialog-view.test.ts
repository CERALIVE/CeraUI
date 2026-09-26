import {
	ORCHESTRATOR_PHASES,
	type UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	actionablePackageOrigins,
	dialogActivityPhase,
	isUpdateWaiting,
	SYSTEM_IMAGE_PHASES,
	systemImagePhase,
} from "./update-dialog-view";

function wire(
	phase: UpdateOrchestratorWireState["phase"],
): UpdateOrchestratorWireState {
	return {
		schema: 1,
		phase,
		progress: null,
		failure_reason: null,
		cellular_override_id: null,
	};
}

describe("systemImagePhase", () => {
	it("answers only for the system-image phases", () => {
		for (const phase of ORCHESTRATOR_PHASES) {
			expect(systemImagePhase(wire(phase)), phase).toBe(
				SYSTEM_IMAGE_PHASES.includes(phase) ? phase : undefined,
			);
		}
	});

	it("says nothing when the backend published no orchestrator state", () => {
		expect(systemImagePhase(undefined)).toBeUndefined();
		expect(systemImagePhase(null)).toBeUndefined();
	});
});

describe("dialogActivityPhase", () => {
	it("states work in progress and failed outcomes, and nothing at rest", () => {
		expect(dialogActivityPhase(wire("downloading"), false)).toBe("downloading");
		expect(dialogActivityPhase(wire("committing"), true)).toBe("committing");
		expect(dialogActivityPhase(wire("failed"), true)).toBe("failed");
		expect(dialogActivityPhase(wire("quarantined"), false)).toBe("quarantined");
		expect(dialogActivityPhase(wire("idle"), false)).toBeUndefined();
		expect(dialogActivityPhase(wire("settled"), false)).toBeUndefined();
		expect(dialogActivityPhase(undefined, false)).toBeUndefined();
	});

	it("leaves the system-image phases to the System section when it is shown", () => {
		expect(dialogActivityPhase(wire("os-staging"), true)).toBeUndefined();
		expect(dialogActivityPhase(wire("os-staging"), false)).toBe("os-staging");
	});
});

describe("isUpdateWaiting", () => {
	it("marks exactly the busy phases that wait instead of work", () => {
		expect(isUpdateWaiting("awaiting-idle")).toBe(true);
		expect(isUpdateWaiting("os-activation-armed")).toBe(true);
		expect(isUpdateWaiting("downloading")).toBe(false);
		expect(isUpdateWaiting("syncing")).toBe(false);
		expect(isUpdateWaiting(undefined)).toBe(false);
	});
});

describe("actionablePackageOrigins", () => {
	it("lists each installable origin once, in first-seen order", () => {
		expect(
			actionablePackageOrigins([
				{
					name: "cerastream",
					origin: "apt.ceralive.tv",
					layer: "app",
					actionable: true,
				},
				{
					name: "curl",
					origin: "Debian:trixie-security",
					layer: "app",
					actionable: true,
				},
				{
					name: "ceraui",
					origin: "apt.ceralive.tv",
					layer: "app",
					actionable: true,
				},
			]),
		).toEqual(["apt.ceralive.tv", "Debian:trixie-security"]);
	});

	it("never names the origin of a package the device will not install", () => {
		expect(
			actionablePackageOrigins([
				{ name: "linux-image", origin: "Debian:trixie", layer: "platform" },
				{ name: "held", origin: "Debian:trixie", kept_back: true },
				{ name: "refused", origin: "elsewhere", actionable: false },
			]),
		).toEqual([]);
	});

	it("reports nothing for a legacy discovery that carries no origin", () => {
		expect(
			actionablePackageOrigins([{ name: "cerastream", layer: "app" }]),
		).toEqual([]);
	});
});
