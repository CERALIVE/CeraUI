// @vitest-environment jsdom
/**
 * "No newer system image has been found" is a conclusion, and it needs the
 * evidence of a COMPLETED, SUCCESSFUL, LATEST OS check (round-2 review C, M3).
 *
 * The device keeps its candidate in memory only, while the `os-available`
 * phase and the success clock survive a backend restart; and a failed check
 * advances the attempt clock but keeps the old success. Neither combination
 * says there is nothing newer, so both must stay an open question.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../../../tests/helpers/catalog";

import SystemSection from "./SystemSection.svelte";

const system = en.settings.updates.system;

function details(os: {
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
}): UpdateDetails {
	return {
		slots: null,
		os: { bootedVersion: "2026.10.70", staged: null, candidate: null },
		checks: {
			packages: {
				lastAttemptAt: 2_000,
				lastSuccessAt: 2_000,
				nextAttemptAt: null,
			},
			os: { ...os, nextAttemptAt: null },
		},
		pendingCellular: null,
		transport: null,
	};
}

function renderSection(
	phase: UpdateOrchestratorPhase | undefined,
	value: UpdateDetails,
) {
	return render(SystemSection, {
		wire:
			phase === undefined
				? undefined
				: {
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
		onCheck: () => undefined,
		onInstall: () => undefined,
	});
}

function expectUnknown(): void {
	expect(
		screen.getByTestId("update-system-candidate-unknown").textContent?.trim(),
	).toBe(system.candidateUnknown);
	expect(screen.queryByTestId("update-system-no-candidate")).toBeNull();
	expect(screen.queryByTestId("update-system-install")).toBeNull();
}

afterEach(() => {
	cleanup();
});

describe("SystemSection — no newer image needs a completed latest check (M3)", () => {
	it("keeps a resumed os-available phase without its candidate an open question", () => {
		// Given a device that restarted after finding an image: the phase and
		// the success clock survived, the in-memory candidate did not.
		renderSection(
			"os-available",
			details({ lastAttemptAt: 2_000, lastSuccessAt: 2_000 }),
		);

		// Then nothing claims there is no newer image.
		expectUnknown();
	});

	it("withdraws the conclusion when a newer check failed", () => {
		// Given a check that failed after an earlier success.
		renderSection(
			"idle",
			details({ lastAttemptAt: 3_000, lastSuccessAt: 2_000 }),
		);

		// Then the old success is not presented as the current answer.
		expectUnknown();
	});

	it("draws no conclusion while a check is running", () => {
		// Given the device mid-check, details read before the attempt started.
		renderSection(
			"checking",
			details({ lastAttemptAt: 2_000, lastSuccessAt: 2_000 }),
		);

		// Then the outcome of that check is not pre-empted.
		expectUnknown();
	});

	it("draws no conclusion from a failed orchestrator", () => {
		// Given an orchestrator that failed.
		renderSection(
			"failed",
			details({ lastAttemptAt: 2_000, lastSuccessAt: 2_000 }),
		);

		// Then whether an image is offered stays open.
		expectUnknown();
	});

	it("draws no conclusion before the device has reported its phase", () => {
		// Given details but no orchestrator state yet.
		renderSection(
			undefined,
			details({ lastAttemptAt: 2_000, lastSuccessAt: 2_000 }),
		);

		// Then an os-available device cannot be ruled out.
		expectUnknown();
	});

	it("still states it once the latest check succeeded and the device is idle", () => {
		// Given an idle device whose latest OS check succeeded and found nothing.
		renderSection(
			"idle",
			details({ lastAttemptAt: 2_000, lastSuccessAt: 2_000 }),
		);

		// Then the verdict is shown.
		expect(
			screen.getByTestId("update-system-no-candidate").textContent?.trim(),
		).toBe(system.noCandidate);
		expect(screen.queryByTestId("update-system-candidate-unknown")).toBeNull();
	});
});
