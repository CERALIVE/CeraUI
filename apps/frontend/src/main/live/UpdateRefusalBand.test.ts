// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { expect, it } from "vitest";
import UpdateRefusalBand from "./UpdateRefusalBand.svelte";

it("keeps the past update progress without presenting its estimate as current", () => {
	const { getByText, queryByTestId } = render(UpdateRefusalBand, {
		refusal: {
			source: "refusal",
			phase: "committing",
			percent: 42,
			etaMinutes: 2,
		},
	});

	expect(getByText("42%")).toBeDefined();
	expect(queryByTestId("update-refusal-eta")).toBeNull();
});
