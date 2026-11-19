// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import ParamText from "./ParamText.svelte";

afterEach(() => {
	cleanup();
});

describe("ParamText", () => {
	it("renders the sentence with only its data param inside a bdi", () => {
		const { container } = render(ParamText, {
			props: {
				format: (value: string) => `Before ${value} after`,
				value: "2026.11.3-beta",
			},
		});

		const bdi = container.querySelectorAll("bdi");
		expect(bdi).toHaveLength(1);
		expect(bdi[0]?.textContent).toBe("2026.11.3-beta");
		expect(container.textContent).toBe("Before 2026.11.3-beta after");
		expect(bdi[0]?.previousSibling?.textContent).toBe("Before ");
		expect(bdi[0]?.nextSibling?.textContent).toBe(" after");
	});
});
