// @vitest-environment jsdom
import type { UpdateTransportSummary } from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";
import ConnectionSection from "./ConnectionSection.svelte";

afterEach(cleanup);

it("missing memory-only history says not known, never no download happened", () => {
	// Given no retained history, when rendered, then historical absence is unknown.
	render(ConnectionSection, { transport: null });
	expect(screen.getByTestId("update-connection-none").textContent).toContain(
		"not known",
	);
});

it.each([true, false, null])(
	"cost %s preserves the device evidence",
	(metered) => {
		// Given unavailable probes and a tri-state cost, when rendered, then no failed reachability is invented.
		const transport: UpdateTransportSummary = {
			profile: "os",
			checkedAt: 1000,
			status: "none",
			selected: null,
			findings: [
				{
					ifname: "eth0",
					family: 4,
					kind: "ethernet",
					healthy: false,
					captive: false,
					metered,
					states: ["probe-unavailable"],
				},
			],
		};
		render(ConnectionSection, { transport });
		expect(
			screen.getByTestId("update-connection-finding").textContent,
		).not.toContain("Not reachable");
		expect(
			screen.getByTestId("update-connection-no-healthy").textContent,
		).toContain("confirmed");
		if (metered === null)
			expect(
				screen.getByTestId("update-connection-finding").textContent,
			).toContain("Cost unknown");
	},
);

it("positive failed probe still reports not reachable", () => {
	// Given a failed route probe, when rendered, then report its actual negative verdict.
	render(ConnectionSection, {
		transport: {
			profile: "os",
			checkedAt: 1000,
			status: "none",
			selected: null,
			findings: [
				{
					ifname: "eth0",
					family: 4,
					kind: "ethernet",
					healthy: false,
					captive: false,
					metered: false,
					states: ["no-route"],
				},
			],
		},
	});
	expect(screen.getByTestId("update-connection-finding").textContent).toContain(
		"Not reachable",
	);
});

it("a historical selected row never claims live use", () => {
	const finding = {
		ifname: "eth0",
		family: 4 as const,
		kind: "ethernet" as const,
		healthy: true,
		captive: false,
		metered: false,
		states: [],
	};
	render(ConnectionSection, {
		transport: {
			profile: "os",
			checkedAt: 1000,
			status: "selected",
			selected: finding,
			findings: [finding],
		},
	});
	expect(screen.getByTestId("update-connection-finding").textContent).toContain(
		"Selected by this check",
	);
	expect(
		screen.getByTestId("update-connection-finding").textContent,
	).not.toContain("In use");
});
