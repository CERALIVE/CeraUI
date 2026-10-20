// @vitest-environment jsdom
/**
 * "Not reachable" is a reachability claim (early oracle F4, 2026-10-13). A
 * certificate, signature, TLS or portal verdict means the link REACHED a
 * server whose answer cannot be used for updates; the producer emits those
 * after a successful secure response (`update-transport/executor.ts`).
 */
import type {
	UpdateTransportFinding,
	UpdateTransportProbeState,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import ConnectionSection from "./ConnectionSection.svelte";

afterEach(cleanup);

function finding(states: UpdateTransportProbeState[]): UpdateTransportFinding {
	return {
		ifname: "eth0",
		family: 4,
		kind: "ethernet",
		healthy: false,
		captive: false,
		metered: false,
		states,
	};
}

function verdictFor(states: UpdateTransportProbeState[]): string {
	render(ConnectionSection, {
		transport: {
			profile: "apt",
			checkedAt: 1_000,
			status: "none",
			selected: null,
			findings: [finding(states)],
		},
	});
	return screen.getByTestId("update-connection-finding").textContent ?? "";
}

describe("a link that reached a server but cannot be used", () => {
	it.each([
		[["credentials-invalid"]],
		[["tampered"]],
		[["tls-error"]],
		[["captive-http"]],
		[["captive-tls"]],
		[["credentials-invalid", "no-route"]],
		[["tampered", "dns-failed", "probe-unavailable"]],
	] as UpdateTransportProbeState[][][])(
		"%j says not usable for updates, never not reachable",
		(states) => {
			const shown = verdictFor(states);
			expect(shown).toContain("Not usable for updates");
			expect(shown).not.toContain("Not reachable");
		},
	);
});

describe("a real reachability failure", () => {
	it.each([
		[["no-route"]],
		[["dns-failed"]],
		[["blocked"]],
		[["blocked", "no-route", "probe-unavailable"]],
	] as UpdateTransportProbeState[][][])("%j says not reachable", (states) => {
		const shown = verdictFor(states);
		expect(shown).toContain("Not reachable");
		expect(shown).not.toContain("Not usable for updates");
	});
});
