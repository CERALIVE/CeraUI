// @vitest-environment jsdom
/**
 * ModemConfigDialog — the ModemManager normalized reading, rendered.
 *
 * Todo 20 put three blocks on the wire whose whole purpose is that an ABSENT
 * value still says something: every metric is a value OR one of seven typed
 * reasons, and `unsupported` / `not-reported` / `not-observed` lead to three
 * different operator actions. So the surface has exactly one way to fail, and it
 * is not a wrong number — it is a placeholder that renders those seven reasons
 * as one em-dash, or worse as a `0`, which is a measurement the radio never took.
 *
 * The suite is therefore built around the UNKNOWN MATRIX: every reason class is
 * driven through the real component and asserted to reach the operator as its
 * OWN sentence, with the seven proven mutually distinct in one sweep. Everything
 * else here is an honesty lock of the same family:
 *
 *   · `not-observed` on `cell_id`/`tac` is the SHIPPED steady state on every
 *     board — the cell property stays masked unless a location source is primed,
 *     which this device never does — so it is asserted as correct behaviour
 *     rather than tolerated as a gap;
 *   · a `sinr` that reads `not-reported` on an LTE modem must NOT render as
 *     `unsupported`, which would be a capability claim ModemManager disproves;
 *   · the no-SIM banner's evidence hint must distinguish a slot the modem
 *     positively reported empty from one nothing could read, and must carry no
 *     raw device path or wire token while doing it;
 *   · the power state is REPORTED and must offer nothing pressable — asserted
 *     against the rendered DOM with a non-vacuity control, because absence has
 *     no syntax to grep for.
 *
 * The mirror of `RouterDongleDialog.details.test.ts`, which is the precedent for
 * detail-row rendering on the other modem family.
 */

import { m } from "@ceraui/i18n/svelte";
import type {
	Modem,
	ModemMetricUnknownReason,
	ModemRegistrationContext,
	ModemSignalDetail,
	ModemSimPresenceEvidence,
} from "@ceraui/rpc/schemas";
import { render, screen, within } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MODEM_METRIC_REASON_KEYS } from "$lib/modem/signal-detail";

import { openModemAdvanced } from "../../tests/helpers/modem-advanced";
import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			configure: vi.fn(),
			getSms: vi.fn(async () => ({ success: true, messages: [] })),
			getUsbModeOptions: vi.fn(async () => ({ certified: [] })),
			scan: vi.fn(),
			setUsbMode: vi.fn(),
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const ALL_REASONS: readonly ModemMetricUnknownReason[] = [
	"unsupported",
	"not-reported",
	"not-observed",
	"malformed",
	"auth-expired",
	"refused",
	"unreachable",
];

const known = (value: number) => ({ state: "known", value }) as const;
const unknown = (reason: ModemMetricUnknownReason) =>
	({ state: "unknown", reason }) as const;
const text = (value: string) => ({ state: "known", value }) as const;

/** The bench's real LTE answer: three measurements, SINR unreported. */
function lteSignalDetail(): ModemSignalDetail {
	return {
		quality_recent: { state: "known", value: true },
		rsrp: known(-92),
		rsrq: known(-11),
		snr: known(7),
		sinr: unknown("not-reported"),
	};
}

/** Operator known, cell masked — what every board reports today. */
function benchRegistration(): ModemRegistrationContext {
	return {
		operator_name: text("Claro"),
		operator_code: text("73201"),
		cell_id: unknown("not-observed"),
		tac: unknown("not-observed"),
	};
}

function modemWith(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g", "5g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4g",
			signal: 61,
			roaming: false,
		},
		...overrides,
	} as Modem;
}

async function open(modem: Modem): Promise<void> {
	render(ModemConfigDialog, { props: { open: true, modem, deviceId: "0" } });
	await openModemAdvanced();
}

const cell = (testid: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

const cellText = (testid: string): string | undefined =>
	cell(testid)?.textContent?.trim();

const metricState = (testid: string): string | null | undefined =>
	cell(testid)?.getAttribute("data-metric-state");

const metricReason = (testid: string): string | null | undefined =>
	cell(testid)?.getAttribute("data-metric-reason");

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	resetModemsFeed();
});

// All 21 cases mount the WHOLE dialog, so this file is render-bound rather than
// assertion-bound — the reasoning `ModemConfigDialog.detail.test.ts` records for
// its own budget. This spec shipped without one and was the last heavy dialog
// file on vitest's 5000 ms default; it timed out a release runner at 71 s wall,
// with case slots reaching 16.7 s. That is past the 15 s sibling budget, so this
// matches `src/tests/modem-raw-token-sweep.test.ts` instead. A budget, not a
// tolerance: nothing is relaxed or skipped, and a hung render still fails.
vi.setConfig({ testTimeout: 30000 });

describe("the extended radio measurements", () => {
	it("renders every measurement the modem reported, each with its own unit", async () => {
		await open(modemWith({ signal_detail: lteSignalDetail() }));

		expect(cell("modem-signal-detail")).not.toBeNull();
		expect(cellText("modem-signal-rsrp")).toBe("-92 dBm");
		expect(cellText("modem-signal-rsrq")).toBe("-11 dB");
		expect(cellText("modem-signal-snr")).toBe("7 dB");
	});

	// The one assertion the whole block exists for.
	it("renders a DISTINCT sentence for each of the seven reason classes", async () => {
		const rendered = new Map<ModemMetricUnknownReason, string>();

		for (const reason of ALL_REASONS) {
			resetModemsFeed();
			document.body.innerHTML = "";
			await open(
				modemWith({
					signal_detail: {
						quality_recent: unknown(reason),
						rsrp: unknown(reason),
						rsrq: unknown(reason),
						snr: unknown(reason),
						sinr: unknown(reason),
					},
				}),
			);

			const shown = cellText("modem-signal-rsrp") ?? "";
			expect(metricState("modem-signal-rsrp")).toBe("unknown");
			expect(metricReason("modem-signal-rsrp")).toBe(reason);
			expect(shown).toBe(m[MODEM_METRIC_REASON_KEYS[reason]]());
			rendered.set(reason, shown);
		}

		expect(new Set(rendered.values()).size).toBe(ALL_REASONS.length);
	});

	// A `0` is a reading the radio never took; an em-dash is the collapse this
	// whole wire shape exists to prevent.
	it("never renders a missing measurement as a zero or a bare dash", async () => {
		for (const reason of ALL_REASONS) {
			resetModemsFeed();
			document.body.innerHTML = "";
			await open(
				modemWith({
					signal_detail: {
						quality_recent: unknown(reason),
						rsrp: unknown(reason),
						rsrq: unknown(reason),
						snr: unknown(reason),
						sinr: unknown(reason),
					},
				}),
			);

			const strip = cell("modem-signal-strip");
			const shown = strip?.textContent ?? "";
			expect(shown).not.toMatch(/\b0\s*(dBm|dB)\b/);
			for (const id of ["rsrp", "rsrq", "snr", "sinr"]) {
				expect(cellText(`modem-signal-${id}`)).not.toBe("—");
				expect(cellText(`modem-signal-${id}`)).not.toBe("-");
			}
		}
	});

	// MM 1.24.2 gives `sinr` to one dict alone, so an LTE modem's missing SINR is
	// a READ-class unknown. Rendering it as `unsupported` claims a capability
	// limit ModemManager itself disproves.
	it("shows an LTE modem's absent SINR as not-reported, never unsupported", async () => {
		await open(modemWith({ signal_detail: lteSignalDetail() }));

		expect(metricReason("modem-signal-sinr")).toBe("not-reported");
		expect(cellText("modem-signal-sinr")).toBe(
			m["network.modem.detail.reason.notReported"](),
		);
		expect(cellText("modem-signal-sinr")).not.toBe(
			m["network.modem.detail.reason.unsupported"](),
		);
	});

	it("marks a reading as a reading and a reason as a reason", async () => {
		await open(modemWith({ signal_detail: lteSignalDetail() }));

		expect(metricState("modem-signal-rsrp")).toBe("known");
		expect(metricState("modem-signal-sinr")).toBe("unknown");
		// A figure is an instrument reading; a reason is a word. If those ever
		// share a face, a glance reads a placeholder as a measurement.
		expect(cell("modem-signal-rsrp")?.className).toContain("font-mono");
		expect(cell("modem-signal-sinr")?.className).not.toContain("font-mono");
	});

	it("renders no measurement strip at all for a backend that published none", async () => {
		await open(modemWith({ firmware_revision: "RM520NGLAAR01A08M4G" }));

		expect(cell("modem-signal-detail")).toBeNull();
		expect(cell("modem-signal-strip")).toBeNull();
		expect(cell("modem-firmware")).not.toBeNull();
	});
});

describe("the measurement recency indicator", () => {
	it("says the reading is live when the modem measured it recently", async () => {
		await open(modemWith({ signal_detail: lteSignalDetail() }));

		const line = cell("modem-signal-recency");
		expect(line?.getAttribute("data-recency")).toBe("recent");
		expect(line?.textContent).toContain(
			m["network.modem.detail.recencyLive"](),
		);
	});

	// A cached 40% and a live 40% are the same number on screen without this.
	it("says the reading is the modem's cached one when it is", async () => {
		await open(
			modemWith({
				signal_detail: {
					...lteSignalDetail(),
					quality_recent: { state: "known", value: false },
				},
			}),
		);

		const line = cell("modem-signal-recency");
		expect(line?.getAttribute("data-recency")).toBe("cached");
		expect(line?.textContent).toContain(
			m["network.modem.detail.recencyCached"](),
		);
	});

	it("states the reason when the modem said nothing about recency", async () => {
		await open(
			modemWith({
				signal_detail: {
					...lteSignalDetail(),
					quality_recent: unknown("not-observed"),
				},
			}),
		);

		const line = cell("modem-signal-recency");
		expect(line?.getAttribute("data-recency")).toBe("unknown");
		expect(line?.textContent).toContain(
			m["network.modem.detail.reason.notObserved"](),
		);
	});
});

describe("the network-registration rows", () => {
	it("names the operator the radio registered on", async () => {
		await open(modemWith({ registration_context: benchRegistration() }));

		expect(cell("modem-registration-context")).not.toBeNull();
		expect(cellText("modem-registration-operator_name")).toBe("Claro");
		expect(cellText("modem-registration-operator_code")).toBe("73201");
	});

	// THE SHIPPED STEADY STATE, asserted as correct rather than tolerated: the
	// cell property is masked until a location source is primed, and this device
	// never primes one. An operator must read "not measured", not a blank.
	it("renders the masked cell identifiers as an honest not-measured state", async () => {
		await open(modemWith({ registration_context: benchRegistration() }));

		for (const id of ["cell_id", "tac"]) {
			expect(metricState(`modem-registration-${id}`)).toBe("unknown");
			expect(metricReason(`modem-registration-${id}`)).toBe("not-observed");
			expect(cellText(`modem-registration-${id}`)).toBe(
				m["network.modem.detail.reason.notObserved"](),
			);
		}
	});

	it("renders no registration block for a backend that published none", async () => {
		await open(modemWith({ signal_detail: lteSignalDetail() }));

		expect(cell("modem-registration-context")).toBeNull();
	});
});

describe("the normalized block supersedes the legacy quality strip", () => {
	const legacyCell = {
		tech: "nr",
		band: "n78",
		cell_id: "0x1A2B3C",
		rsrp: -100,
		rsrq: -14,
		snr: 3,
		sinr: 2,
	} as const;

	// Two rows labelled RSRP carrying different numbers is worse than either
	// alone, and only the normalized block can say WHY a value is missing.
	it("drops the legacy quality rows when the normalized block is present", async () => {
		await open(
			modemWith({
				cell_info: legacyCell,
				signal_detail: lteSignalDetail(),
			} as Partial<Modem>),
		);

		expect(cell("modem-cell-rsrp")).toBeNull();
		expect(cell("modem-cell-sinr")).toBeNull();
		expect(cellText("modem-signal-rsrp")).toBe("-92 dBm");
		// The context rows the normalized block does NOT carry stay put.
		expect(cell("modem-cell-tech")).not.toBeNull();
		expect(cell("modem-cell-band")).not.toBeNull();
	});

	it("leaves the legacy strip untouched when there is no normalized block", async () => {
		await open(modemWith({ cell_info: legacyCell } as Partial<Modem>));

		expect(cell("modem-cell-rsrp")).not.toBeNull();
		expect(cellText("modem-cell-rsrp")).toContain("-100");
	});
});

describe("the no-SIM banner's presence evidence", () => {
	const withEvidence = (evidence: ModemSimPresenceEvidence): Modem =>
		modemWith({ no_sim: true, sim_presence_evidence: evidence });

	it("says so plainly when the modem itself reported an empty slot", async () => {
		await open(
			withEvidence({
				kind: "state-failed-reason",
				field: "failedReason",
				value: "sim-missing",
			}),
		);

		const hint = cell("modem-no-sim-evidence");
		expect(hint?.getAttribute("data-states-empty-slot")).toBe("true");
		expect(hint?.textContent?.trim()).toBe(
			m["network.modem.simEvidence.stateFailedReason"](),
		);
	});

	// The banner alone is BINARY, so without this an unread slot and a
	// device-stated empty slot are the same sentence — and they ask opposite
	// things of an operator.
	it("distinguishes an unread slot from a device-stated empty one", async () => {
		await open(
			withEvidence({
				kind: "no-evidence",
				inspected: ["sim", "simSlots", "failedReason"],
			}),
		);

		const hint = cell("modem-no-sim-evidence");
		expect(hint?.getAttribute("data-states-empty-slot")).toBe("false");
		expect(hint?.textContent).toContain("3");
		expect(hint?.textContent?.trim()).not.toBe(
			m["network.modem.simEvidence.stateFailedReason"](),
		);
	});

	it("carries no raw device path or wire token into the banner", async () => {
		await open(
			withEvidence({
				kind: "sim-object-path",
				field: "sim",
				value: "/org/freedesktop/ModemManager1/SIM/0",
			}),
		);

		const banner = cell("modem-no-sim-banner");
		expect(banner).not.toBeNull();
		expect(banner?.textContent).not.toContain("/SIM/0");
		expect(banner?.textContent).not.toContain("freedesktop");
		expect(cellText("modem-no-sim-evidence")).toBe(
			m["network.modem.simEvidence.simObjectPath"](),
		);
	});

	it("adds no hint for a backend that published no evidence", async () => {
		await open(modemWith({ no_sim: true }));

		expect(cell("modem-no-sim-banner")).not.toBeNull();
		expect(cell("modem-no-sim-evidence")).toBeNull();
	});
});

describe("the radio power state is reported, never offered", () => {
	it("renders the state the device published, read-only", async () => {
		await open(modemWith({ radio_power: "on" } as Partial<Modem>));

		const state = cell("modem-power-state");
		expect(state).not.toBeNull();
		expect(
			state?.querySelector("[data-radio-power]")?.textContent?.trim(),
		).toBe(m["network.modem.power.state.on"]());
	});

	// Absence has no syntax to grep for, so the sweep is paired with a
	// non-vacuity control proving the same selector finds real controls.
	it("offers nothing pressable anywhere in the power card", async () => {
		await open(modemWith({ radio_power: "on" } as Partial<Modem>));

		const card = document.querySelector<HTMLElement>(
			'[data-testid="modem-power-card"]',
		);
		expect(card).not.toBeNull();
		if (card === null) return;
		const scoped = within(card);
		expect(scoped.queryAllByRole("button", { hidden: true })).toHaveLength(0);
		expect(scoped.queryAllByRole("switch", { hidden: true })).toHaveLength(0);
		expect(card.querySelectorAll("input, select, textarea")).toHaveLength(0);

		// Non-vacuity: the same query DOES find the dialog's own controls.
		expect(
			screen.getAllByRole("button", { hidden: true }).length,
		).toBeGreaterThan(0);
	});

	it("says the modem reported none rather than inventing a state", async () => {
		await open(modemWith());

		expect(cell("modem-power-unreported")).not.toBeNull();
		expect(cellText("modem-power-unreported")).toBe(
			m["network.modem.power.unreported"](),
		);
	});
});
