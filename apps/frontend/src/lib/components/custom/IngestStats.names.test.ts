// @vitest-environment jsdom
/**
 * IngestStats names links for people (link-names.ts) and keeps the interface
 * id as a second line. The session summary is bound to what was measured: a
 * link whose name changed during the session (a SIM that registered on another
 * operator) shows every name it had, not the name at viewing time.
 */
import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import IngestStats from "./IngestStats.svelte";

const frame = (
	rtt: number,
	ifaces: readonly string[] = ["usb0"],
	ids?: readonly string[],
): LinkTelemetryMessage => ({
	links: ifaces.map((iface, i) => ({
		conn_id: String(i),
		iface,
		rtt_ms: rtt,
		nak_count: 0,
		weight_percent: Math.round(100 / ifaces.length),
		stale: false,
		...(ids?.[i] ? { link_id: ids[i] } : {}),
	})),
});

let operator = "Northwind";
const linkName = (iface: string) =>
	iface === "usb0" ? `SIM 1 · ${operator}` : iface;

describe("IngestStats link names", () => {
	afterEach(() => {
		operator = "Northwind";
	});

	it("leads with the name and keeps the interface id underneath", () => {
		const { container } = render(IngestStats, {
			props: { telemetry: frame(20), isStreaming: true, linkName },
		});
		const row = container.querySelector<HTMLElement>(
			'[data-testid="ingest-row"]',
		);
		expect(row?.querySelector("[data-link-name]")?.textContent?.trim()).toBe(
			"SIM 1 · Northwind",
		);
		expect(row?.textContent).toContain("usb0");
	});

	it("the session summary lists every name a link had, in order", async () => {
		const { container, rerender } = render(IngestStats, {
			props: {
				telemetry: frame(20),
				isStreaming: true,
				bitrateKbps: 4000,
				linkName,
			},
		});
		await rerender({ telemetry: frame(21) });
		operator = "Harbor Cell";
		await rerender({
			telemetry: frame(22),
			linkName: (iface: string) => linkName(iface),
		});
		await rerender({ telemetry: frame(23) });
		await rerender({ isStreaming: false });
		const names = [
			...container.querySelectorAll("[data-session-link-name]"),
		].map((el) => el.textContent?.trim());
		expect(names).toEqual(["SIM 1 · Northwind → SIM 1 · Harbor Cell"]);
	});

	it("a session survives an interface named like an object property", async () => {
		const ifaces = ["constructor", "__proto__", "toString"];
		const { container, rerender } = render(IngestStats, {
			props: {
				telemetry: frame(20, ifaces),
				isStreaming: true,
				bitrateKbps: 4000,
				linkName: (iface: string) => `Link ${iface}`,
			},
		});
		await rerender({ telemetry: frame(21, ifaces) });
		await rerender({ isStreaming: false });
		const names = [
			...container.querySelectorAll("[data-session-link-name]"),
		].map((el) => el.textContent?.trim());
		expect(names.sort()).toEqual(
			["Link __proto__", "Link constructor", "Link toString"].sort(),
		);
	});

	it("preserves the full observed name sequence and the steady link's name", async () => {
		const { container, rerender } = render(IngestStats, {
			props: {
				telemetry: frame(20, ["usb0", "eth0"]),
				isStreaming: true,
				bitrateKbps: 4000,
				linkName,
			},
		});
		operator = "Harbor Cell";
		await rerender({
			telemetry: frame(21, ["usb0", "eth0"]),
			linkName: (iface: string) => linkName(iface),
		});
		operator = "Summit Wireless";
		await rerender({
			telemetry: frame(22, ["usb0", "eth0"]),
			linkName: (iface: string) => linkName(iface),
		});
		await rerender({ isStreaming: false });
		const row = (iface: string) =>
			container.querySelector<HTMLElement>(
				`[data-testid="ingest-contribution-row"][data-iface="${iface}"]`,
			);
		const renamed = row("usb0");
		const steady = row("eth0");
		expect(
			steady?.querySelector("[data-session-link-name]")?.textContent?.trim(),
		).toBe("eth0");
		const name = renamed?.querySelector<HTMLElement>(
			"[data-session-link-name]",
		);
		expect(name?.textContent?.trim()).toBe(
			"SIM 1 · Northwind → SIM 1 · Harbor Cell → SIM 1 · Summit Wireless",
		);
	});

	it.each([
		{
			scenario: "separates different links that reuse an ifname",
			iface: "usb0",
			secondId: "replacement",
			expected: ["Northwind", "Harbor Cell"],
		},
		{
			scenario: "keeps one row when the same link_id changes ifname",
			iface: "usb3",
			secondId: "original",
			expected: ["Northwind → Harbor Cell"],
		},
	])("$scenario", async ({ iface, secondId, expected }) => {
		const { container, rerender } = render(IngestStats, {
			props: {
				telemetry: frame(20, ["usb0"], ["original"]),
				isStreaming: true,
				linkName: () => "Northwind",
			},
		});
		await rerender({
			telemetry: frame(21, [iface], [secondId]),
			linkName: () => "Harbor Cell",
		});
		await rerender({
			isStreaming: false,
			linkName: () => "Today's unrelated roster",
		});
		expect(
			[...container.querySelectorAll("[data-session-link-name]")].map((el) =>
				el.textContent?.trim(),
			),
		).toEqual(expected);
	});
});
