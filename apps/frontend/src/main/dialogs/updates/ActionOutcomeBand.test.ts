// @vitest-environment jsdom
/**
 * A lost reply and a device refusal are two different bands (C-M1). Only the
 * device can say "Not started"; a reply that never arrived says the outcome is
 * not confirmed, and carries no spinner that could run forever.
 */
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../../../tests/helpers/catalog";

import ActionOutcomeBand from "./ActionOutcomeBand.svelte";

const updates = en.settings.updates;

afterEach(() => {
	cleanup();
});

describe("ActionOutcomeBand", () => {
	it("renders an unanswered install as unconfirmed, never as not started", () => {
		// Given an install whose reply never arrived.
		render(ActionOutcomeBand, { refusal: undefined, unconfirmed: "install" });

		// Then the band states the uncertainty and nothing else.
		const band = screen.getByTestId("update-action-unconfirmed");
		expect(band.getAttribute("data-action")).toBe("install");
		expect(band.textContent).toContain(updates.unconfirmed.title);
		expect(band.textContent).toContain(updates.unconfirmed.body);
		expect(band.textContent).not.toContain(updates.refusal.title);
		expect(band.querySelector('[aria-busy="true"]')).toBeNull();
		expect(screen.queryByTestId("update-action-refused")).toBeNull();
	});

	it("renders a device refusal as not started, with its reason", () => {
		// Given a refusal the device answered with.
		render(ActionOutcomeBand, {
			refusal: { action: "install", reason: "busy" },
			unconfirmed: undefined,
		});

		// Then the refusal band names it.
		const band = screen.getByTestId("update-action-refused");
		expect(band.textContent).toContain(updates.refusal.title);
		expect(band.textContent).toContain(updates.refusal.busy);
		expect(screen.queryByTestId("update-action-unconfirmed")).toBeNull();
	});

	it("renders nothing when there is no outcome to report", () => {
		// Given no action outcome.
		render(ActionOutcomeBand, { refusal: undefined, unconfirmed: undefined });

		// Then no band exists.
		expect(screen.queryByTestId("update-action-refused")).toBeNull();
		expect(screen.queryByTestId("update-action-unconfirmed")).toBeNull();
	});
});
