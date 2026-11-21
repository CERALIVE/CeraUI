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
): LinkTelemetryMessage => ({
	links: ifaces.map((iface, i) => ({
		conn_id: String(i),
		iface,
		rtt_ms: rtt,
		nak_count: 0,
		weight_percent: Math.round(100 / ifaces.length),
		stale: false,
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

	it("a renamed link's names get their own full line at every width, never clipped", async () => {
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
		expect(renamed?.dataset.renamed).toBe("true");
		expect(steady?.dataset.renamed).toBe("false");
		const cell = (r: HTMLElement | null) =>
			r?.querySelector<HTMLElement>("[data-session-link-name-cell]")
				?.className ?? "";
		// The renamed name keeps the full row width above 640 px too.
		expect(cell(renamed)).toContain("basis-full");
		expect(cell(renamed)).not.toMatch(/sm:w-36|sm:basis-auto/);
		expect(renamed?.className).not.toContain("sm:flex-nowrap");
		// A link with one name keeps the narrow column beside its bar.
		expect(cell(steady)).toContain("sm:w-36");
		const name = renamed?.querySelector<HTMLElement>(
			"[data-session-link-name]",
		);
		expect(name?.textContent?.trim()).toBe(
			"SIM 1 · Northwind → SIM 1 · Harbor Cell → SIM 1 · Summit Wireless",
		);
		expect(name?.className).not.toMatch(/line-clamp|truncate|overflow-hidden/);
	});
});
