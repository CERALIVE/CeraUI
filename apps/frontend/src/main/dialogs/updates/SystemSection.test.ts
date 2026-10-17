// @vitest-environment jsdom
/**
 * The System image section never renders an unknown as a fact (C-M3).
 *
 * Every block of `getUpdateDetails` is independently nullable and `null` means
 * "not established": the backend maps an unreadable release stamp to `null`
 * exactly as it maps a missing one. A rejected read leaves `details` undefined
 * altogether. Neither is evidence that the image carries no version or that no
 * newer image exists, so neither may be worded as one.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { osCheckFoundNothing } from "$lib/updates/update-dialog-view";
import { en } from "../../../tests/helpers/catalog";

import SystemSection from "./SystemSection.svelte";

const system = en.settings.updates.system;

function details(
	overrides: {
		os?: Partial<UpdateDetails["os"]>;
		osLastSuccessAt?: number | null;
	} = {},
): UpdateDetails {
	const lastSuccessAt =
		overrides.osLastSuccessAt === undefined ? 1_000 : overrides.osLastSuccessAt;
	return {
		slots: null,
		os: {
			bootedVersion: "2026.10.70",
			staged: null,
			candidate: null,
			...overrides.os,
		},
		checks: {
			packages: {
				lastAttemptAt: 1_000,
				lastSuccessAt: 1_000,
				nextAttemptAt: null,
			},
			os: { lastAttemptAt: 1_000, lastSuccessAt, nextAttemptAt: null },
		},
		pendingCellular: null,
		transport: null,
	};
}

function renderSection(
	value: UpdateDetails | undefined,
	phase: UpdateOrchestratorPhase = "os-available",
) {
	return render(SystemSection, {
		wire: {
			schema: 1,
			phase,
			progress: null,
			failure_reason: null,
			cellular_override_id: null,
		},
		details: value,
		channel: "stable",
		checking: false,
		installing: false,
		// The clock/phase half of the verdict; the same-link witness half is the
		// surface's (`update-conclusions.test.ts`), granted here.
		nothingNewer: osCheckFoundNothing(value, phase),
		onCheck: () => undefined,
		onInstall: () => undefined,
	});
}

afterEach(() => {
	cleanup();
});

describe("SystemSection — unknown is never a fact (C-M3)", () => {
	it("renders details the device could not answer as unavailable, with no conclusion drawn", () => {
		// Given a details read that was rejected.
		renderSection(undefined);

		// Then the running version is unavailable, not "no release version".
		expect(
			screen
				.getByTestId("update-system-version-unavailable")
				.textContent?.trim(),
		).toBe(system.versionUnavailable);
		expect(screen.queryByTestId("update-system-version-unknown")).toBeNull();
		// And whether a newer image exists stays an open question.
		expect(
			screen.getByTestId("update-system-candidate-unknown").textContent?.trim(),
		).toBe(system.candidateUnknown);
		expect(screen.queryByTestId("update-system-no-candidate")).toBeNull();
		// And nothing can be installed from a candidate nobody read.
		expect(screen.queryByTestId("update-system-install")).toBeNull();
		// Checking stays offered: the device decides whether it can.
		expect(screen.getByTestId("update-system-check")).not.toBeNull();
	});

	it("says a null running version could not be established, not that the image has none", () => {
		// Given an answer whose release stamp could not be read.
		renderSection(details({ os: { bootedVersion: null } }));

		// Then the copy states the uncertainty.
		const cell = screen.getByTestId("update-system-version-unknown");
		expect(cell.textContent?.trim()).toBe(system.versionUnknown);
		expect(system.versionUnknown).toMatch(/could not be established/);
		expect(cell.textContent).not.toMatch(/carries no release version/);
		expect(
			screen.queryByTestId("update-system-version-unavailable"),
		).toBeNull();
	});

	it("claims no newer image only after an OS check has succeeded", () => {
		// Given an answer with no candidate from a device that never completed an OS check.
		renderSection(details({ osLastSuccessAt: null }));

		// Then no conclusion is drawn from an unestablished check.
		expect(screen.queryByTestId("update-system-no-candidate")).toBeNull();
		expect(
			screen.getByTestId("update-system-candidate-unknown"),
		).not.toBeNull();
	});

	it("still reports a successful check that found nothing newer", () => {
		// Given an answer with no candidate after a successful OS check, from the
		// idle device that check leaves behind (`CHECK_SUCCEEDED_NONE` → idle).
		renderSection(details(), "idle");

		// Then that verdict is shown, and nothing is called unknown.
		expect(
			screen.getByTestId("update-system-no-candidate").textContent?.trim(),
		).toBe(system.noCandidate);
		expect(screen.queryByTestId("update-system-candidate-unknown")).toBeNull();
		expect(screen.queryByTestId("update-system-version-unknown")).toBeNull();
	});

	it("shows the running version and the offered candidate when both are known", () => {
		// Given a complete answer with an offered image.
		renderSection(
			details({
				os: { candidate: { version: "2026.10.76", sizeBytes: 734_003_200 } },
			}),
		);

		// Then both facts render, and the install control is offered.
		expect(screen.getByTestId("update-system-current").textContent).toContain(
			"2026.10.70",
		);
		expect(screen.getByTestId("update-system-candidate").textContent).toContain(
			"2026.10.76",
		);
		expect(screen.getByTestId("update-system-install")).not.toBeNull();
		expect(screen.queryByTestId("update-system-candidate-unknown")).toBeNull();
	});
});
