// @vitest-environment jsdom
/**
 * LinkTelemetry — loading skeleton (Todo 29).
 *
 * The bonded-link card must NOT flash "--" placeholders before the telemetry
 * feed has arrived. While `loading` is true (feed === undefined upstream) the
 * three value cells are replaced by skeletons; once the feed lands the cells
 * render values (or a calm "--" for a link with no entry).
 */
import type { LinkTelemetryEntry } from "@ceraui/rpc/schemas";
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import LinkTelemetry from "./LinkTelemetry.svelte";

function skeletons(dl: HTMLElement): number {
	return dl.querySelectorAll('[data-slot="skeleton"]').length;
}

describe("LinkTelemetry — loading skeleton", () => {
	it("renders skeletons (not --) while the feed has not arrived", () => {
		render(LinkTelemetry, { props: { entry: undefined, loading: true } });

		const dl = screen.getByTestId("link-telemetry");
		expect(dl.getAttribute("data-loading")).toBe("true");
		expect(dl.getAttribute("aria-busy")).toBe("true");
		// One skeleton per value cell (RTT / NAK / weight); no value cells yet.
		expect(skeletons(dl)).toBe(3);
		expect(screen.queryByTestId("link-rtt")).toBeNull();
	});

	it("renders -- placeholders (no skeleton) when the feed arrived but this link has no entry", () => {
		render(LinkTelemetry, { props: { entry: undefined, loading: false } });

		const dl = screen.getByTestId("link-telemetry");
		expect(dl.getAttribute("data-loading")).toBe("false");
		expect(skeletons(dl)).toBe(0);
		expect(screen.getByTestId("link-rtt").textContent).toContain("--");
	});

	it("renders the live values once the entry is present", () => {
		const entry: LinkTelemetryEntry = {
			conn_id: "1",
			iface: "wwan0",
			rtt_ms: 12,
			nak_count: 3,
			weight_percent: 100,
			stale: false,
		};
		render(LinkTelemetry, { props: { entry, loading: false } });

		expect(skeletons(screen.getByTestId("link-telemetry"))).toBe(0);
		expect(screen.getByTestId("link-rtt").textContent).toContain("12");
		expect(screen.getByTestId("link-nak").textContent).toContain("3");
		expect(screen.getByTestId("link-weight").textContent).toContain("100");
	});
});
