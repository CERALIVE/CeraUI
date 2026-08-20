import type { LinkTelemetryEntry } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	ambiguousLinkLabels,
	linkDisambiguation,
	linkRowKey,
} from "./link-disambiguation";

function entry(partial: Partial<LinkTelemetryEntry>): LinkTelemetryEntry {
	return {
		conn_id: "0",
		iface: "eth0",
		rtt_ms: 0,
		nak_count: 0,
		weight_percent: 100,
		stale: false,
		...partial,
	};
}

const TWIN_A = { id: "enx0c5b8f279a64", label: "Huawei E3372 HiLink" };
const TWIN_B = { id: "eth1", label: "Huawei E3372 HiLink" };

describe("ambiguousLinkLabels", () => {
	it("names only the labels more than one link renders", () => {
		const ambiguous = ambiguousLinkLabels([
			TWIN_A,
			TWIN_B,
			{ id: "wlan0", label: "Studio WiFi" },
		]);
		expect([...ambiguous]).toEqual(["Huawei E3372 HiLink"]);
	});

	it("a roster with no repeats needs no disambiguation at all", () => {
		expect(
			ambiguousLinkLabels([
				{ id: "eth0", label: "eth0" },
				{ id: "wlan0", label: "Studio WiFi" },
			]).size,
		).toBe(0);
	});
});

describe("linkDisambiguation", () => {
	const ambiguous = ambiguousLinkLabels([TWIN_A, TWIN_B]);

	it("separates two identically-labelled twins by interface AND port", () => {
		expect(
			linkDisambiguation(
				TWIN_A,
				entry({ iface: TWIN_A.id, port_label: "USB 0-1.3.1" }),
				ambiguous,
			),
		).toBe("enx0c5b8f279a64 · USB 0-1.3.1");
		expect(
			linkDisambiguation(
				TWIN_B,
				entry({ iface: TWIN_B.id, port_label: "USB 0-1.3.2" }),
				ambiguous,
			),
		).toBe("eth1 · USB 0-1.3.2");
	});

	it("separates them before any telemetry has arrived", () => {
		expect(linkDisambiguation(TWIN_A, undefined, ambiguous)).toBe(
			"enx0c5b8f279a64",
		);
		expect(linkDisambiguation(TWIN_B, undefined, ambiguous)).toBe("eth1");
	});

	it("appends a serial ONLY when the device reported one", () => {
		expect(
			linkDisambiguation(
				TWIN_A,
				entry({ port_label: "USB 0-1.3.1", serial: "2b16081" }),
				ambiguous,
			),
		).toBe("enx0c5b8f279a64 · USB 0-1.3.1 · 2b16081");
		// The bench HiLink twins publish none, and none is invented for them.
		expect(
			linkDisambiguation(
				TWIN_A,
				entry({ port_label: "USB 0-1.3.1" }),
				ambiguous,
			),
		).toBe("enx0c5b8f279a64 · USB 0-1.3.1");
	});

	it("renders NO line for a link whose label already stands alone", () => {
		const lone = { id: "wlan0", label: "Studio WiFi" };
		expect(
			linkDisambiguation(
				lone,
				entry({ iface: "wlan0", port_label: "USB 0-1.1" }),
				ambiguousLinkLabels([lone, TWIN_A]),
			),
		).toBeUndefined();
	});

	it("never repeats the label it is disambiguating", () => {
		const named = { id: "eth1", label: "eth1" };
		const both = ambiguousLinkLabels([named, { id: "eth2", label: "eth1" }]);
		expect(linkDisambiguation(named, undefined, both)).toBeUndefined();
	});
});

describe("linkRowKey", () => {
	it("keys a row on the minted link_id when the bond published one", () => {
		expect(linkRowKey(TWIN_A, entry({ link_id: "lnk_aaaa" }))).toBe("lnk_aaaa");
	});

	it("falls back to the interface name for an unmapped legacy link", () => {
		expect(linkRowKey(TWIN_A, entry({}))).toBe("enx0c5b8f279a64");
		expect(linkRowKey(TWIN_A, undefined)).toBe("enx0c5b8f279a64");
	});
});
