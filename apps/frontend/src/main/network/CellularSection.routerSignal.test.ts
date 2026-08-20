// @vitest-environment jsdom
/**
 * CellularSection — the router dongle's own signal, rendered honestly (todo 21).
 *
 * A `router-ethernet` row has no `status` block and never will, so before this
 * it drew no signal glyph at all: "attached with a strong radio" and "attached
 * with no SIM in it" were the same empty row. Todo 20 normalized what the
 * dongle's OWN admin API reports; this file pins how it reaches the operator.
 *
 * FOUR PROPERTIES, and every one of them is an honesty invariant rather than a
 * layout preference:
 *
 *   1. PROVENANCE SURVIVES. This reading came from a vendor web API over a USB
 *      LAN link and `status.signal` comes from ModemManager's radio stack. One
 *      row can never draw both, and the router one is marked as a second-hand
 *      instrument ON SCREEN — the shipped kiosk touchscreen cannot hover.
 *   2. NOTHING IS FABRICATED. No degraded state renders a digit, a bar, or a
 *      spinner. A metric the dialect cannot express at all is ABSENT, never a
 *      dash that would read as "the radio reported nothing".
 *   3. A NON-READING IS A WORD. No SIM, an unanswered device, a refused session
 *      and an unreadable body each say so.
 *   4. A CARRIED-OVER READING IS NOT A LIVE ONE. It keeps its value (todo 20
 *      carries it exactly one cycle so a missed poll does not blank the row) and
 *      loses its tier colour, and the row says "Last known" out loud.
 *
 * FIXTURE PROVENANCE: every HiLink/ZTE unit on the bench is SIM-LESS, so no
 * capture exists in which one reported a populated radio metric. The blank and
 * SIM-less fixtures below ARE the bench truth; the populated ones are
 * SHAPE-DERIVED (real field names, real per-dialect support, supplied numbers).
 */
import type {
	Modem,
	NetifMessage,
	RouterSignal,
	RouterSignalMetric,
} from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const known = (value: number): RouterSignalMetric => ({
	state: "known",
	value,
});
const unknown = (
	reason: Extract<RouterSignalMetric, { state: "unknown" }>["reason"],
): RouterSignalMetric => ({ state: "unknown", reason });
const UNSUPPORTED = unknown("unsupported");

function hilinkSignal(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "hilink-admin-api",
		freshness: "live",
		bars: known(4),
		max_bars: known(5),
		dbm: known(-71),
		rsrp: known(-95),
		rsrq: known(-11),
		snr: UNSUPPORTED,
		sinr: known(9),
		...over,
	};
}

function zteSignal(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "zte-goform",
		freshness: "live",
		bars: known(3),
		max_bars: known(5),
		dbm: known(-79),
		rsrp: known(-98),
		rsrq: known(-12),
		snr: known(7),
		sinr: UNSUPPORTED,
		...over,
	};
}

function ufiSignal(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "ufi-himiapi",
		freshness: "live",
		bars: UNSUPPORTED,
		max_bars: UNSUPPORTED,
		dbm: known(-96),
		rsrp: UNSUPPORTED,
		rsrq: UNSUPPORTED,
		snr: UNSUPPORTED,
		sinr: UNSUPPORTED,
		...over,
	};
}

function degraded(
	base: RouterSignal,
	reason: Extract<RouterSignalMetric, { state: "unknown" }>["reason"],
): RouterSignal {
	const next = { ...base, freshness: "unknown" as const };
	for (const id of [
		"bars",
		"max_bars",
		"dbm",
		"rsrp",
		"rsrq",
		"snr",
		"sinr",
	] as const) {
		if (base[id].state === "unknown" && base[id].reason === "unsupported")
			continue;
		next[id] = unknown(reason);
	}
	return next;
}

function dongle(
	signal: RouterSignal | undefined,
	adminOver: Record<string, unknown> = {},
): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			...(signal !== undefined ? { signal } : {}),
			...adminOver,
		},
	} as unknown as Modem;
}

function radio(): Modem {
	return {
		ifname: "wwan0",
		name: "RM530N-GL - 16855",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: { connection: "connected", network: "Movistar", signal: 81 },
	} as unknown as Modem;
}

const NETIF: NetifMessage = {
	enx0c5b8f279a64: { tp: 0, enabled: true, ip: "192.168.8.100" },
	wwan0: { tp: 4, enabled: true, ip: "10.0.0.5" },
};

function renderRows(entries: [string, Modem][]) {
	return render(CellularSection, {
		props: {
			modemEntries: entries,
			netif: NETIF,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

function chip(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		'[data-testid="modem-router-signal"]',
	);
}

describe("provenance — two instruments, never one surface", () => {
	it("draws the router glyph for a dongle and marks where it came from", () => {
		const { container } = renderRows([["1000", dongle(hilinkSignal())]]);
		const el = chip(container);

		expect(el).not.toBeNull();
		expect(el?.dataset.provenance).toBe("hilink-admin-api");
		expect(el?.dataset.signalState).toBe("reading");
		expect(el?.dataset.signalTier).toBe("high");
	});

	it("keeps the ModemManager glyph off a router row and vice versa", () => {
		const { container } = renderRows([
			["1000", dongle(hilinkSignal())],
			["0", radio()],
		]);
		const rows = [
			...container.querySelectorAll<HTMLElement>('[data-testid="modem-row"]'),
		];
		const routerRow = rows.find(
			(row) => row.dataset.ifname === "enx0c5b8f279a64",
		);
		const radioRow = rows.find((row) => row.dataset.ifname === "wwan0");

		expect(
			routerRow?.querySelector('[data-testid="modem-router-signal"]'),
		).not.toBeNull();
		expect(routerRow?.querySelector('[data-testid="modem-signal"]')).toBeNull();
		expect(
			radioRow?.querySelector('[data-testid="modem-signal"]'),
		).not.toBeNull();
		expect(
			radioRow?.querySelector('[data-testid="modem-router-signal"]'),
		).toBeNull();
	});

	it("names the instrument on screen, not only in a hover target", () => {
		const { container } = renderRows([["1000", dongle(hilinkSignal())]]);
		const note = container.querySelector<HTMLElement>(
			'[data-testid="router-signal-detail"]',
		);

		expect(note?.dataset.provenance).toBe("hilink-admin-api");
		expect(note?.textContent).toContain("web interface");
	});

	it.each([
		["hilink", hilinkSignal(), "hilink-admin-api", "high"],
		["zte", zteSignal(), "zte-goform", "medium"],
		["ufi", ufiSignal(), "ufi-himiapi", "low"],
	] as const)(
		"renders a %s reading with its own provenance",
		(_name, signal, provenance, tier) => {
			const { container } = renderRows([["1000", dongle(signal)]]);
			expect(chip(container)?.dataset.provenance).toBe(provenance);
			expect(chip(container)?.dataset.signalTier).toBe(tier);
		},
	);
});

describe("honest states — a word, never a bare mark and never a spinner", () => {
	it("says NO SIM for the real bench dongle instead of drawing zero bars", () => {
		const benchTruth = hilinkSignal({
			bars: known(0),
			max_bars: known(5),
			dbm: unknown("not-reported"),
			rsrp: unknown("not-reported"),
			rsrq: unknown("not-reported"),
			sinr: unknown("not-reported"),
		});
		const { container } = renderRows([
			["1000", dongle(benchTruth, { sim: "absent" })],
		]);
		const el = chip(container);

		expect(el?.dataset.signalState).toBe("no-sim");
		expect(el?.dataset.signalTier).toBeUndefined();
		expect(el?.textContent?.trim()).toBe("No SIM");
	});

	it.each([
		["unreachable", "Dongle didn't answer"],
		["auth-expired", "Session refused"],
		["malformed", "Unreadable reply"],
		["not-reported", "Not reported"],
	] as const)("states %s in words", (reason, copy) => {
		const { container } = renderRows([
			["1000", dongle(degraded(hilinkSignal(), reason))],
		]);
		const el = chip(container);

		expect(el?.dataset.signalState).toBe("unknown");
		expect(el?.dataset.unknownReason).toBe(reason);
		expect(el?.textContent?.trim()).toBe(copy);
	});

	it("renders NO digit and NO tier for any degraded state", () => {
		for (const reason of [
			"unreachable",
			"auth-expired",
			"malformed",
			"not-reported",
		] as const) {
			const { container, unmount } = renderRows([
				["1000", dongle(degraded(zteSignal(), reason))],
			]);
			const el = chip(container);

			expect(el?.dataset.signalTier, reason).toBeUndefined();
			expect(el?.textContent ?? "", reason).not.toMatch(/\d/);
			unmount();
		}
	});

	it("never renders a spinner or a progress role on this surface", () => {
		const { container } = renderRows([
			["1000", dongle(degraded(hilinkSignal(), "not-reported"))],
		]);

		expect(container.querySelector('[role="progressbar"]')).toBeNull();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("keeps the state readable to assistive tech even when it is glyph-only", () => {
		const { container } = renderRows([["1000", dongle(zteSignal())]]);
		const word = chip(container)?.querySelector<HTMLElement>(
			'[data-testid="modem-router-signal-state"]',
		);

		expect(word?.className).toContain("sr-only");
		expect(word?.textContent?.trim()).toBe("Good signal");
	});
});

describe("a carried-over reading is labelled as the past tense it is", () => {
	it("keeps the value, drops the live claim, and says so", () => {
		const { container } = renderRows([
			["1000", dongle(hilinkSignal({ freshness: "stale" }))],
		]);
		const el = chip(container);

		expect(el?.dataset.freshness).toBe("stale");
		expect(el?.dataset.live).toBe("false");
		expect(el?.className).not.toContain("text-signal-good");
		expect(
			container.querySelector('[data-testid="modem-router-signal-stale"]')
				?.textContent,
		).toContain("Last known");
	});

	it("explains the carry-forward in the detail strip", () => {
		const { container } = renderRows([
			["1000", dongle(zteSignal({ freshness: "stale" }))],
		]);
		expect(
			container.querySelector('[data-testid="router-signal-stale-note"]')
				?.textContent,
		).toContain("previous reading");
	});

	it("marks a LIVE reading live", () => {
		const { container } = renderRows([["1000", dongle(hilinkSignal())]]);
		expect(chip(container)?.dataset.live).toBe("true");
		expect(
			container.querySelector('[data-testid="modem-router-signal-stale"]'),
		).toBeNull();
	});
});

describe("the detail strip — absent means absent", () => {
	it("omits the metric a dialect cannot express, rather than dashing it", () => {
		const { container } = renderRows([["1000", dongle(hilinkSignal())]]);

		expect(
			container.querySelector('[data-testid="router-signal-sinr"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="router-signal-snr"]'),
		).toBeNull();
	});

	it("does the mirror image for ZTE, which publishes lte_snr and no sinr", () => {
		const { container } = renderRows([["1000", dongle(zteSignal())]]);

		expect(
			container.querySelector('[data-testid="router-signal-snr"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="router-signal-sinr"]'),
		).toBeNull();
	});

	it("leaves UFI with the one scalar it has", () => {
		const { container } = renderRows([["1000", dongle(ufiSignal())]]);
		const rows = [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid^="router-signal-"]',
			),
		].filter((el) => el.dataset.metricState !== undefined);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.textContent?.trim()).toBe("-96 dBm");
	});

	it("carries each metric's own unit", () => {
		const { container } = renderRows([["1000", dongle(hilinkSignal())]]);
		const text = (id: string) =>
			container
				.querySelector<HTMLElement>(`[data-testid="router-signal-${id}"]`)
				?.textContent?.trim();

		expect(text("bars")).toBe("4 / 5");
		expect(text("dbm")).toBe("-71 dBm");
		expect(text("rsrp")).toBe("-95 dBm");
		expect(text("rsrq")).toBe("-11 dB");
		expect(text("sinr")).toBe("9 dB");
	});

	it("reports a degraded metric by name instead of dropping it", () => {
		const { container } = renderRows([
			["1000", dongle(degraded(zteSignal(), "auth-expired"))],
		]);
		const rsrp = container.querySelector<HTMLElement>(
			'[data-testid="router-signal-rsrp"]',
		);

		expect(rsrp?.dataset.metricState).toBe("unknown");
		expect(rsrp?.textContent?.trim()).toBe("Session refused");
	});
});

describe("the legacy bar scalars step aside for the model", () => {
	it("suppresses the old segment when the normalized reading is present", () => {
		const { container } = renderRows([
			["1000", dongle(hilinkSignal(), { signal_bars: 4, signal_max_bars: 5 })],
		]);

		expect(
			container.querySelector('[data-testid="router-admin-signal"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="router-signal-bars"]'),
		).not.toBeNull();
	});

	it("keeps the old segment for a backend that publishes no model", () => {
		const { container } = renderRows([
			["1000", dongle(undefined, { signal_bars: 4, signal_max_bars: 5 })],
		]);

		expect(
			container.querySelector('[data-testid="router-admin-signal"]'),
		).not.toBeNull();
		expect(chip(container)).toBeNull();
		expect(
			container.querySelector('[data-testid="router-signal-detail"]'),
		).toBeNull();
	});
});

describe("no operator ever reads a machine token", () => {
	it("resolves every string on this surface to real copy", () => {
		for (const signal of [
			hilinkSignal(),
			zteSignal(),
			ufiSignal(),
			hilinkSignal({ freshness: "stale" }),
			degraded(hilinkSignal(), "unreachable"),
			degraded(zteSignal(), "auth-expired"),
			degraded(ufiSignal(), "malformed"),
			degraded(hilinkSignal(), "not-reported"),
		]) {
			const { container, unmount } = renderRows([["1000", dongle(signal)]]);
			expect(container.textContent).not.toMatch(/network\.[a-zA-Z.]+/);
			unmount();
		}
	});
});
