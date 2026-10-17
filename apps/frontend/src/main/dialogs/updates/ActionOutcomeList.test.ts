// @vitest-environment jsdom
/**
 * Each action keeps its own band, named after the control that started it,
 * and each states only what is known: "Not started" with the device's reason,
 * or "Outcome not confirmed" worded for a lost reply or for an error the device
 * raised while handling the request.
 */
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import type { ActionBand } from "$lib/updates/update-action-outcome";
import { en } from "../../../tests/helpers/catalog";

import ActionOutcomeList from "./ActionOutcomeList.svelte";

const updates = en.settings.updates;

const WATCH = {
	afterRead: 1,
	clocks: undefined,
	staged: undefined,
	settled: false,
} as const;

afterEach(() => {
	cleanup();
});

describe("ActionOutcomeList", () => {
	it("keeps an unconfirmed install beside a newer refused check, each named", () => {
		// Given an install nobody confirmed, then a check the device refused.
		const bands: ActionBand[] = [
			{
				action: "install",
				call: 1,
				state: "unconfirmed",
				cause: "lost",
				watch: WATCH,
			},
			{ action: "check", call: 2, state: "refused", reason: "busy" },
		];
		render(ActionOutcomeList, { bands });

		// Then both stand, in dispatch order, each under its own control's name.
		const unconfirmed = screen.getByTestId("update-action-unconfirmed");
		const refused = screen.getByTestId("update-action-refused");
		expect(unconfirmed.getAttribute("data-action")).toBe("install");
		expect(refused.getAttribute("data-action")).toBe("check");
		expect(
			unconfirmed.compareDocumentPosition(refused) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const labels = screen
			.getAllByTestId("update-action-label")
			.map((label) => label.textContent?.trim());
		expect(labels).toEqual([
			updates.system.installNow,
			updates.system.checkNow,
		]);
		expect(refused.textContent).toContain(updates.refusal.busy);
	});

	it("words an error the device raised as uncertain, not as a lost reply or a refusal", () => {
		// Given a check that failed inside the device's handler.
		render(ActionOutcomeList, {
			bands: [
				{
					action: "check",
					call: 1,
					state: "unconfirmed",
					cause: "error",
					watch: WATCH,
				},
			],
		});

		// Then the band says the device reported an error and nothing is known yet.
		const band = screen.getByTestId("update-action-unconfirmed");
		expect(band.getAttribute("data-cause")).toBe("error");
		expect(band.textContent).toContain(updates.unconfirmed.title);
		expect(band.textContent).toContain(updates.unconfirmed.errorBody);
		expect(band.textContent).not.toContain(updates.unconfirmed.body);
		expect(band.textContent).not.toContain(updates.refusal.title);
		expect(band.querySelector('[aria-busy="true"]')).toBeNull();
	});

	it("says a request that never left the browser was not started, and why", () => {
		// Given a download the client could not send.
		render(ActionOutcomeList, {
			bands: [
				{
					action: "cellular",
					call: 1,
					state: "refused",
					reason: "not_connected",
				},
			],
		});

		// Then it is not started, because the device was not connected.
		const band = screen.getByTestId("update-action-refused");
		expect(band.textContent).toContain(updates.refusal.title);
		expect(band.textContent).toContain(updates.refusal.notConnected);
		expect(screen.getByTestId("update-action-label").textContent?.trim()).toBe(
			updates.cellular.approve,
		);
	});

	it("renders nothing when no outcome is on screen", () => {
		// Given no bands.
		render(ActionOutcomeList, { bands: [] });

		// Then not even the wrapper is drawn.
		expect(screen.queryByTestId("update-action-outcomes")).toBeNull();
	});
});
