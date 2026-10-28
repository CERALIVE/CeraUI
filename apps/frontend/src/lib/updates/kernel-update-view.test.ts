import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	kernelInstallable,
	kernelReasonKey,
	kernelUpdatePhase,
} from "./kernel-update-view";

const kernel: NonNullable<UpdateDetails["kernel"]> = {
	booted: {
		package: "linux-image-7.2.0-ceralive-rk3588",
		version: "7.2.0-ceralive1",
	},
	candidate: {
		package: "linux-image-7.2.0-ceralive-rk3588",
		version: "7.2.0-ceralive2",
		sizeBytes: 50_000_000,
	},
	state: null,
	version: null,
	reason: null,
};

const wire = (phase: UpdateOrchestratorPhase): UpdateOrchestratorWireState => ({
	schema: 1,
	phase,
	progress: null,
	failure_reason: null,
	cellular_override_id: null,
});

describe("kernel state presentation", () => {
	it.each([
		["staging", "kernel-staging"],
		["staged", "kernel-staged"],
		["armed", "kernel-staged"],
		["activating", "kernel-verifying"],
		["activated", "kernel-verifying"],
		["succeeded", "kernel-succeeded"],
		["rolled_back", "kernel-rolled-back"],
		["failed", "kernel-failed"],
	] as const)("retains the device's %s outcome at idle", (state, phase) => {
		// Given a retained record after the public orchestrator returned to idle.
		const details = { ...kernel, state, version: "7.2.0-ceralive2" };
		// When the section selects its status, then the record remains visible.
		expect(kernelUpdatePhase(wire("idle"), details)).toBe(phase);
	});

	it("prefers live progress over a retained older terminal record", () => {
		// Given a new download while details still hold the previous result.
		const details = { ...kernel, state: "succeeded" };
		// When rendering the live phase, then it must not claim success.
		expect(kernelUpdatePhase(wire("kernel-downloading"), details)).toBe(
			"kernel-downloading",
		);
	});

	it("keeps an unread or unknown state distinct from success", () => {
		// Given missing details or a future device state.
		// When rendering either, then neither becomes an established outcome.
		expect(kernelUpdatePhase(undefined, undefined)).toBeUndefined();
		expect(
			kernelUpdatePhase(wire("idle"), {
				...kernel,
				state: "future-kernel-phase",
			}),
		).toBeUndefined();
	});

	it("identifies an offer without inventing a staged update", () => {
		// Given a candidate but no device state record.
		// When rendering the offer, then it is only available.
		expect(kernelUpdatePhase(wire("idle"), kernel)).toBe("available");
		expect(
			kernelUpdatePhase(wire("idle"), { ...kernel, candidate: null }),
		).toBeUndefined();
	});
});

describe("kernel installation affordance", () => {
	it.each(["idle", "available", "os-available"] as const)(
		"allows an offered kernel only in the backend's %s admission phase",
		(phase) => {
			// Given a trusted offer and a phase accepted by kernelRuntime.install.
			// When deriving the affordance, then installation is available.
			expect(kernelInstallable(wire(phase), kernel)).toBe(true);
		},
	);

	it.each([
		"kernel-downloading",
		"kernel-staging",
		"kernel-staged",
		"kernel-verifying",
		"kernel-succeeded",
		"kernel-rolled-back",
		"kernel-failed",
		"os-staging",
		"syncing",
		"checking",
		"failed",
	] as const)("does not offer a second install during %s", (phase) => {
		// Given the same valid candidate, varying only the current phase.
		// When deriving the affordance, then a conflicting install is unavailable.
		expect(kernelInstallable(wire(phase), kernel)).toBe(false);
	});

	it("requires both a current phase and an actual candidate", () => {
		// Given otherwise eligible idle state, vary only the missing authority.
		// When deriving the affordance, then neither absence permits installation.
		expect(kernelInstallable(undefined, kernel)).toBe(false);
		expect(kernelInstallable(wire("idle"), undefined)).toBe(false);
		expect(
			kernelInstallable(wire("idle"), { ...kernel, candidate: null }),
		).toBe(false);
	});

	it.each(["staging", "staged", "armed", "activating", "activated", "future"])(
		"retained %s state cannot authorize another install at idle",
		(state) => {
			// Given a candidate and idle push, but a pending or unknown record.
			// When deriving the affordance, then the record keeps it closed.
			expect(kernelInstallable(wire("idle"), { ...kernel, state })).toBe(false);
		},
	);
});

describe("kernel failure copy", () => {
	it.each([
		["kernel_origin_mismatch", "originMismatch"],
		["kernel_download_failed", "downloadFailed"],
		["kernel_staging_failed", "stagingFailed"],
		["kernel_identity_mismatch", "identityMismatch"],
		["kernel_boot_failed", "bootFailed"],
		["kernel_interrupted", "interrupted"],
	])("maps %s to localized reason copy", (reason, key) => {
		// Given a named device reason, when selecting copy, then use its key.
		expect(kernelReasonKey(reason)).toBe(
			`settings.updates.kernel.reason.${key}`,
		);
	});

	it.each([null, undefined, "future_reason", "__proto__", "<b>failed</b>"])(
		"never prints an absent or unknown reason (%s)",
		(reason) => {
			// Given a reason outside the known vocabulary.
			// When selecting copy, then only the generic key may be rendered.
			expect(kernelReasonKey(reason)).toBe(
				"settings.updates.kernel.reason.generic",
			);
		},
	);
});
