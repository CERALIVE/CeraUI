// @vitest-environment jsdom

import type { RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import RadioHealthPanel from "./RadioHealthPanel.svelte";

const { getRadioHealth } = vi.hoisted(() => ({
	getRadioHealth: vi.fn<() => Promise<Record<string, RadioHealth>>>(),
}));
vi.mock("$lib/rpc", () => ({ rpc: { modems: { getRadioHealth } } }));
beforeEach(() => {
	getRadioHealth.mockReset();
	getRadioHealth.mockResolvedValue({});
});

// AppDialog picks Dialog vs Sheet through window.matchMedia, absent in jsdom.
beforeAll(() => {
	if (!window.matchMedia)
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
});

/** Opens the readings dialog and returns its body (portalled to document.body). */
async function openDetails(view: { getByTestId: (id: string) => HTMLElement }) {
	await fireEvent.click(view.getByTestId("radio-health-open"));
	const details = document.body.querySelector<HTMLElement>(
		'[data-testid="radio-health-details"]',
	);
	if (!details) throw new Error("readings dialog did not open");
	const part = (id: string) =>
		details.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	return { details, part };
}

const at = 1_700_000_000_000;
const absent: RadioMetric = {
	value: null,
	source: "ModemManager",
	unit: "dB",
	technology: "unknown",
	capturedAt: 1000,
};
const known = (
	value: number | string,
	unit = "",
	source = "QENG servingcell",
): RadioMetric => ({ value, unit, source, technology: "lte", capturedAt: at });

function radio(overrides: Partial<RadioHealth> = {}): RadioHealth {
	return {
		capturedAt: at,
		registration: absent,
		layer: absent,
		band: absent,
		metrics: { sinr: absent },
		neighbours: [],
		usb: { available: false, events: [] },
		finding: { kind: "unknown", confidence: "unknown", evidence: [] },
		timeline: [],
		...overrides,
	};
}

const registered = {
	registration: known("home", "state", "ModemManager 3GPP"),
	layer: known("LTE + NR (NSA)", "", "QENG servingcell"),
	band: known("LTE B3 + NR n78", "band"),
	metrics: {
		"lte.rsrp": known(-95, "dBm"),
		"nr.rsrp": known(-112, "dBm"),
	},
	usb: { available: true, events: [] },
} satisfies Partial<RadioHealth>;

function show(record: RadioHealth, props: Record<string, unknown> = {}) {
	const view = render(RadioHealthPanel, {
		radio: record,
		id: "1",
		network: "Example",
		connected: true,
		...props,
	});
	const panel = view.getByTestId("radio-health");
	return {
		...view,
		panel,
		status: panel.dataset.status,
		chip: view.getByTestId("radio-health-status").textContent?.trim(),
		summary: view.getByTestId("radio-health-summary").textContent?.trim(),
		next: view.queryByTestId("radio-health-next")?.textContent?.trim(),
	};
}

test("unavailable readings and words remain visible without modem action controls", () => {
	const { container, panel, status, chip, summary } = show(radio());
	expect(status).toBe("unchecked");
	expect(chip).toBe("Not checked");
	expect(summary).toBe("Couldn’t check this time.");
	expect(panel.textContent).toContain("Unavailable");
	// The one button opens the readings; nothing acts on the modem.
	expect(container.querySelectorAll("input,select").length).toBe(0);
	const buttons = container.querySelectorAll("button");
	expect(buttons.length).toBe(1);
	expect(buttons[0]?.dataset.testid).toBe("radio-health-open");
	expect(container.textContent).not.toContain("Weak signal");
});

describe("status first", () => {
	test("a registered modem without a finding reads OK with no next step", () => {
		const { status, chip, summary, next } = show(radio(registered));
		expect(status).toBe("ok");
		expect(chip).toBe("OK");
		expect(summary).toBe("No problems found.");
		expect(next).toBeUndefined();
	});

	test("a refused SIM names the network and the next step", () => {
		const { status, chip, summary, next } = show(
			radio({
				finding: {
					kind: "sim-account",
					confidence: "likely",
					evidence: ["home-network-refused-registration"],
				},
			}),
		);
		expect(status).toBe("sim-account");
		expect(chip).toBe("SIM refused");
		expect(summary).toBe("Example refuses this SIM.");
		expect(next).toContain("try the SIM in another modem");
	});

	test("a refused SIM without a carrier name still reads as a sentence", () => {
		const { summary } = show(
			radio({
				finding: { kind: "sim-account", confidence: "likely", evidence: [] },
			}),
			{ network: undefined },
		);
		expect(summary).toBe("The network refuses this SIM.");
	});

	test("a broken data path suggests a physical replug with its cost", () => {
		const { chip, summary, next } = show(
			radio({
				...registered,
				finding: { kind: "data-path", confidence: "likely", evidence: [] },
			}),
		);
		expect(chip).toBe("No data");
		expect(summary).toBe("Registered, but no data gets through.");
		expect(next).toContain("Unplug this modem and plug it back in");
		expect(next).toContain("about a minute");
	});

	test("possible interference names the other modem by its row label", () => {
		const { chip, summary } = show(
			radio({
				...registered,
				finding: {
					kind: "disturbed",
					confidence: "possible",
					neighbour: "2",
					evidence: [],
				},
			}),
			{ modemName: (id: string) => `Slot ${id}` },
		);
		expect(chip).toBe("Possible interference");
		expect(summary).toBe("May be affected while Slot 2 sends.");
	});

	test("no SIM leads, and the readings it cannot have are not listed", () => {
		const { status, chip, queryByTestId } = show(radio(), { noSim: true });
		expect(status).toBe("no-sim");
		expect(chip).toBe("No SIM");
		expect(queryByTestId("radio-health-readings")).toBeNull();
	});

	test("searching and refused registration are not registered, not a SIM verdict", () => {
		const searching = show(
			radio({ registration: known("searching", "state") }),
		);
		expect(searching.status).toBe("not-registered");
		expect(searching.summary).toBe("Searching for a network.");
		searching.unmount();
		const denied = show(radio({ registration: known("denied", "state") }));
		expect(denied.status).toBe("not-registered");
		expect(denied.summary).toContain("The cause is unknown");
		expect(denied.chip).not.toBe("SIM refused");
	});

	test("the status chip carries an icon and a word, not colour alone", () => {
		const { getByTestId } = show(radio(registered));
		const chip = getByTestId("radio-health-status");
		expect(chip.querySelector("svg")).not.toBeNull();
		expect(chip.textContent?.trim()).not.toBe("");
	});
});

describe("compact readings", () => {
	test("network type and band are short", () => {
		const { getByTestId } = show(radio(registered));
		expect(getByTestId("radio-health-readings").textContent).toContain(
			"5G NSA · B3 + n78",
		);
	});

	test("the card has no signal line; the row keeps the signal", () => {
		const { queryByTestId, getByTestId } = show(radio(registered));
		expect(queryByTestId("radio-health-signal")).toBeNull();
		expect(getByTestId("radio-health-readings").textContent).not.toContain(
			"dBm",
		);
	});

	test("USB events show only when there are some", () => {
		const none = show(radio(registered));
		expect(none.queryByTestId("radio-health-usb")).toBeNull();
		none.unmount();
		const some = show(
			radio({
				...registered,
				usb: { available: true, events: [{ at, kind: "reset" }] },
			}),
		);
		expect(some.getByTestId("radio-health-usb").textContent?.trim()).toBe("1");
	});
});

test("the card opens every raw reading and the history in a dialog", async () => {
	const view = show(
		radio({
			...registered,
			usb: { available: true, events: [{ at, kind: "reset" }] },
			timeline: [
				{
					at,
					finding: { kind: "unknown", confidence: "unknown", evidence: [] },
				},
			],
		}),
	);
	expect(
		document.body.querySelector('[data-testid="radio-health-details"]'),
	).toBeNull();
	const { part } = await openDetails(view);
	expect(part("radio-health-raw")?.textContent).toContain("QENG servingcell");
	expect(part("radio-health-raw")?.textContent).toContain("LTE RSRP");
	expect(part("radio-health-history")?.textContent).toContain("USB reset");
});

test("an empty generic slot is dropped once a layer reports that metric", async () => {
	const view = show(
		radio({
			...registered,
			metrics: { rsrp: absent, ...registered.metrics },
		}),
	);
	const { part } = await openDetails(view);
	const names = Array.from(
		part("radio-health-raw")?.querySelectorAll("dt") ?? [],
		(dt) => dt.textContent?.trim(),
	);
	expect(names).toContain("LTE RSRP");
	expect(names).not.toContain("RSRP");
});

test("the card's button says what it opens", () => {
	const { getByRole } = show(radio(registered));
	expect(
		getByRole("button", {
			name: "Show readings and history for Modem 1",
		}).getAttribute("aria-haspopup"),
	).toBe("dialog");
});

test("the panel is a named region with a screen-reader heading, chip first", () => {
	const { getByRole, getByTestId } = show(radio(registered));
	expect(getByRole("region", { name: "Radio health" })).toBe(
		getByTestId("radio-health"),
	);
	expect(getByRole("heading", { name: "Radio health" }).className).toContain(
		"sr-only",
	);
});

describe("round two: honest status", () => {
	test("registered without a data connection is not OK", () => {
		const { status, chip, summary } = show(radio(registered), {
			connected: false,
		});
		expect(status).toBe("registered");
		expect(chip).toBe("Registered");
		expect(summary).toBe("Registered, but no data connection yet.");
	});

	test("only the exact registered states count; unknown reads as not checked", () => {
		const statusOf = (value: string) => {
			const view = show(radio({ registration: known(value, "state") }));
			view.unmount();
			return view.status;
		};
		expect(statusOf("home-sms-only")).toBe("registered");
		expect(statusOf("roaming-csfb-not-preferred")).toBe("registered");
		expect(statusOf("unknown")).toBe("unchecked");
	});

	test("a missing SIM outranks a cached SIM finding", () => {
		const { status } = show(
			radio({
				finding: { kind: "sim-account", confidence: "likely", evidence: [] },
			}),
			{ noSim: true },
		);
		expect(status).toBe("no-sim");
	});

	test("the solid chip uses a status token pair", () => {
		const chip = show(
			radio({
				finding: { kind: "data-path", confidence: "likely", evidence: [] },
			}),
		).getByTestId("radio-health-status");
		expect(chip.className).toContain("bg-status-error");
		expect(chip.className).toContain("text-status-error-foreground");
	});
});

test("an unavailable network value keeps the page direction", () => {
	const { getByTestId } = show(radio());
	const cells = getByTestId("radio-health-readings").querySelectorAll("dd");
	for (const cell of cells) expect(cell.getAttribute("dir")).toBeNull();
	expect(
		getByTestId("radio-health-readings").querySelector('[dir="ltr"]'),
	).toBeNull();
});

test("details keep neighbour band, source and time, and finding evidence", async () => {
	const view = show(
		radio({
			...registered,
			neighbours: [
				{
					id: "2",
					band: known("LTE B7", "band"),
					transmitting: "yes",
					source: "tx_bytes",
					capturedAt: at,
				},
			],
			timeline: [
				{
					at,
					finding: {
						kind: "data-path",
						confidence: "likely",
						evidence: ["two-failed-path-probes"],
					},
				},
			],
		}),
	);
	const { part } = await openDetails(view);
	const neighbours = part("radio-health-neighbours")?.textContent ?? "";
	expect(neighbours).toContain("Modem 2");
	expect(neighbours).toContain("Sending");
	expect(neighbours).toContain("B7");
	expect(neighbours).toContain("tx_bytes");
	expect(part("radio-health-history")?.textContent).toContain(
		"two-failed-path-probes",
	);
});

describe("next reading countdown", () => {
	const nextFor = (capturedAt: number) => {
		const view = show(radio({ capturedAt }));
		const text = view.getByTestId("radio-health-next").textContent?.trim();
		view.unmount();
		return text;
	};

	test("counts down to the next poll, then says it is checking", () => {
		expect(nextFor(Date.now() - 10_000)).toContain("Next check in about 20 s.");
		expect(nextFor(Date.now() - 31_000)).toContain("Checking now…");
		expect(nextFor(0)).toContain("It updates with the next reading.");
	});

	test("the clock ticks while a countdown is shown", async () => {
		vi.useFakeTimers({ now: 1_800_000_000_000 });
		try {
			const view = show(radio({ capturedAt: Date.now() - 10_000 }));
			const next = () => view.getByTestId("radio-health-next").textContent;
			expect(next()).toContain("about 20 s");
			vi.advanceTimersByTime(5_000);
			await tick();
			expect(next()).toContain("about 15 s");
			// Ticking digits keep their width.
			expect(view.getByTestId("radio-health-next").className).toContain(
				"tabular-nums",
			);
		} finally {
			vi.useRealTimers();
		}
	});
});

test("the dialog leads with RSRP per layer, with bars and a word", async () => {
	const view = show(radio({ ...registered, capturedAt: Date.now() }));
	const { part } = await openDetails(view);
	const signal = part("radio-health-signal");
	expect(signal?.textContent).toContain("-95 dBm");
	expect(signal?.textContent).toContain("Fair");
	expect(signal?.textContent).toContain("-112 dBm");
	expect(signal?.textContent).toContain("Weak");
	expect(signal?.querySelectorAll("svg").length).toBe(2);
	expect(part("radio-health-timing")?.textContent).toContain("Last reading");
});

test("signal level cut-offs are inclusive at -90 and -105 dBm", async () => {
	const { signalLevel } = await import("./radio-health-view");
	expect(signalLevel(-90)).toBe("high");
	expect(signalLevel(-90.5)).toBe("medium");
	expect(signalLevel(-105)).toBe("medium");
	expect(signalLevel(-105.5)).toBe("low");
});

test("limited registrations are named, never OK and never not registered", () => {
	const smsOnly = show(
		radio({ registration: known("home-sms-only", "state") }),
	);
	expect(smsOnly.chip).toBe("Registered");
	expect(smsOnly.summary).toBe("Registered for SMS only, so no data.");
	expect(smsOnly.getByTestId("radio-health-readings").textContent).toContain(
		"SMS only",
	);
	smsOnly.unmount();
	const csfb = show(
		radio({ registration: known("home-csfb-not-preferred", "state") }),
	);
	expect(csfb.status).toBe("registered");
	expect(csfb.summary).toBe("Registered and connected.");
});

test("the dialog body takes keyboard focus so a long list can scroll", async () => {
	const view = show(radio(registered));
	const { details } = await openDetails(view);
	expect(details.getAttribute("tabindex")).toBe("0");
	expect(details.tagName).toBe("SECTION");
	expect(details.getAttribute("aria-label")).toBe("Readings and history");
});

test("the dialog shows the retained history, not only the broadcast sample", async () => {
	const sample = (offset: number) => ({
		at: at - offset,
		finding: {
			kind: "unknown" as const,
			confidence: "unknown" as const,
			evidence: [],
		},
	});
	getRadioHealth.mockResolvedValue({
		"1": radio({
			...registered,
			timeline: [sample(90_000), sample(60_000), sample(30_000)],
		}),
	});
	const view = show(radio({ ...registered, timeline: [sample(30_000)] }));
	const { part } = await openDetails(view);
	await vi.waitFor(() =>
		expect(part("radio-health-history")?.querySelectorAll("li").length).toBe(3),
	);
	expect(getRadioHealth).toHaveBeenCalled();
});

test("a serving-cell read the lease refused names its reason in words", async () => {
	const view = show(
		radio({
			...registered,
			metrics: {
				...registered.metrics,
				servingCell: {
					value: null,
					source: "QENG servingcell · not available: not-released",
					unit: "",
					technology: "unknown",
					capturedAt: at,
					reason: "not-available",
				},
			},
		}),
	);
	const { part } = await openDetails(view);
	const raw = part("radio-health-raw")?.textContent ?? "";
	expect(raw).toContain(
		"Unavailable: the modem's second AT port isn't released",
	);
	expect(raw).toContain("QENG servingcell · not-released");
});

test("every lease and read reason reads as words, never a bare token", async () => {
	const tokens = [
		"owned-by-modemmanager",
		"native-unavailable",
		"repeated-timeouts",
		"device-changed",
		"timeout",
		"modem-unreadable",
	];
	for (const token of tokens) {
		const view = show(
			radio({
				...registered,
				metrics: {
					servingCell: {
						value: null,
						source: `QENG servingcell · no reading: ${token}`,
						unit: "",
						technology: "unknown",
						capturedAt: at,
					},
				},
			}),
		);
		const { part } = await openDetails(view);
		const row = Array.from(
			part("radio-health-raw")?.querySelectorAll("dt") ?? [],
		).find((dt) => dt.textContent?.trim() === "Serving cell")?.parentElement;
		const shown = row?.querySelector("dd > span")?.textContent;
		expect(shown).toMatch(/^Unavailable: [a-zA-Z]/);
		expect(shown).not.toContain(token);
		expect(shown).not.toContain("the read failed");
		view.unmount();
		document.body.innerHTML = "";
	}
});

test("two sources with the same label both list, keyed by their metric id", async () => {
	const view = show(
		radio({
			...registered,
			metrics: {
				"unknown.rsrq": known(-11, "dB", "QMI NAS signal-info"),
				"mm.rsrq": known(-12, "dB", "ModemManager Signal rsrq"),
			},
		}),
	);
	const { part } = await openDetails(view);
	const rows = [
		...(part("radio-health-raw")?.querySelectorAll("dt") ?? []),
	].map((dt) => dt.textContent?.trim());
	expect(rows.filter((name) => name === "RSRQ")).toHaveLength(2);
	const raw = part("radio-health-raw")?.textContent ?? "";
	expect(raw).toContain("-11 dB");
	expect(raw).toContain("-12 dB");
});
