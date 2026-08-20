// @vitest-environment jsdom
/**
 * BondedLinksSection — two identical modems must not render as one anonymous
 * pair (todo 12).
 *
 * The bench twins ship ONE factory MAC, ONE factory LAN subnet and ONE model
 * name, so before this both rows read "Huawei E3372 HiLink · Cellular" with
 * nothing on screen saying which was which — and, because the backend resolved
 * a row's interface from the SHARED source address, both rows also pointed at
 * the same interface and one of them showed no telemetry at all.
 */

import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type { LinkSignal } from "$lib/types/hud";

import BondedLinksSection from "./BondedLinksSection.svelte";

const TWIN_MODEL = "Huawei E3372 HiLink";

function modemLink(id: string, index: number, label: string): LinkSignal {
	return {
		id,
		type: "modem",
		linkIndex: index,
		signal: 60 + index,
		label,
		isConnected: true,
		isStale: false,
		throughputKbps: 4000,
		enabled: true,
		connectionState: "connected",
	};
}

const TWINS: LinkSignal[] = [
	modemLink("enx0c5b8f279a64", 0, TWIN_MODEL),
	modemLink("eth1", 1, TWIN_MODEL),
];

function twinTelemetry(): LinkTelemetryMessage {
	return {
		links: [
			{
				conn_id: "0",
				link_id: "lnk_aaaaaaaaaaaaaaaa",
				iface: "enx0c5b8f279a64",
				port_label: "USB 0-1.3.1",
				rtt_ms: 41,
				nak_count: 3,
				weight_percent: 52,
				stale: false,
			},
			{
				conn_id: "1",
				link_id: "lnk_bbbbbbbbbbbbbbbb",
				iface: "eth1",
				port_label: "USB 0-1.3.2",
				rtt_ms: 87,
				nak_count: 11,
				weight_percent: 48,
				stale: false,
			},
		],
	};
}

function cards(container: HTMLElement): HTMLElement[] {
	return [
		...container.querySelectorAll<HTMLElement>(
			'[data-testid="bonded-link-card"]',
		),
	];
}

describe("BondedLinksSection — twin disambiguation (todo 12)", () => {
	it("gives two identically-labelled twins DISTINCT on-screen identities", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: TWINS,
				modemEntries: [],
				linkTelemetry: twinTelemetry(),
			},
		});

		const identities = [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid="bonded-link-identity"]',
			),
		].map((el) => el.textContent?.trim());

		expect(identities).toHaveLength(2);
		expect(identities[0]).toBe("enx0c5b8f279a64 · USB 0-1.3.1");
		expect(identities[1]).toBe("eth1 · USB 0-1.3.2");
		expect(new Set(identities).size).toBe(2);
	});

	it("keys each row on the minted link_id, not on its position", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: TWINS,
				modemEntries: [],
				linkTelemetry: twinTelemetry(),
			},
		});

		expect(cards(container).map((card) => card.dataset.linkKey)).toEqual([
			"lnk_aaaaaaaaaaaaaaaa",
			"lnk_bbbbbbbbbbbbbbbb",
		]);
	});

	it("attaches each twin's OWN telemetry to its own card", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: TWINS,
				modemEntries: [],
				linkTelemetry: twinTelemetry(),
			},
		});

		const [first, second] = cards(container);
		expect(first?.textContent).toContain("41");
		expect(first?.textContent).not.toContain("87");
		expect(second?.textContent).toContain("87");
		expect(second?.textContent).not.toContain("41");
	});

	it("separates the twins even before the first telemetry frame arrives", () => {
		const { container } = render(BondedLinksSection, {
			props: { links: TWINS, modemEntries: [], linkTelemetry: undefined },
		});

		const identities = [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid="bonded-link-identity"]',
			),
		].map((el) => el.textContent?.trim());
		expect(identities).toEqual(["enx0c5b8f279a64", "eth1"]);
	});

	it("adds NO identity line to a roster whose labels already stand alone", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [
					modemLink("usb0", 0, "Quectel RM530N-GL"),
					modemLink("wlan0", 1, "Studio WiFi"),
				],
				modemEntries: [],
				linkTelemetry: undefined,
			},
		});

		expect(
			container.querySelectorAll('[data-testid="bonded-link-identity"]'),
		).toHaveLength(0);
	});

	it("never fabricates a serial for a device that reported none", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: TWINS,
				modemEntries: [],
				linkTelemetry: twinTelemetry(),
			},
		});

		for (const el of container.querySelectorAll(
			'[data-testid="bonded-link-identity"]',
		)) {
			// Two segments only: interface and port. A third would be an identity
			// claim the bench twins cannot support.
			expect(el.textContent?.split("·")).toHaveLength(2);
		}
	});
});
