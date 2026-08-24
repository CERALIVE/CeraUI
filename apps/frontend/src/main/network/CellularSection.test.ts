// @vitest-environment jsdom
/**
 * CellularSection — single-line rows + telemetry dedupe + 44px touch targets (T20),
 * plus the todo-26 progressive-disclosure redesign.
 *
 * T20 half (unchanged): the per-row `LinkIndicator`, signal-% readout, and speed
 * `Badge` (all `data-live-value`) are removed now that T19's BondedLinksSection
 * owns live per-link numbers. Identity + control rows merge into ONE `py-2.5`
 * flex line (no `.mt-2.5`), and the configure button carries the tokenized
 * touch-target min-height. KEEP: stale Badge, `noSimBond` disabledReason toggle.
 *
 * Todo-26 half: EVERY device class renders a row — mm-managed healthy /
 * registering / locked, router-ethernet up / acquiring / down, and an
 * unrecognised transport — none hidden, every disabled control carrying a
 * visible reason, and no machine token ever rendered raw.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";
import {
	availabilityReasonKey,
	configureDisabledReasonKey,
	type ModemClassBand,
} from "./cellular-row";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const TOUCH_MIN_CLASS = "min-h-[var(--touch-target-min)]";

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "usb0",
		name: "Modem 1",
		network_type: { supported: ["4G"], active: "4G" },
		status: {
			connection: "connected",
			signal: 65,
			roaming: false,
			network: "Carrier",
			network_type: "4G",
		},
		...overrides,
	} as Modem;
}

function renderSection(
	opts: {
		modem?: Partial<Modem>;
		netif?: NetifMessage;
		stale?: Set<string>;
	} = {},
) {
	return render(CellularSection, {
		props: {
			modemEntries: [["modem0", modem(opts.modem)]],
			netif: opts.netif ?? { usb0: { tp: 500, enabled: true, ip: "10.0.0.5" } },
			isFullyStale: false,
			staleInterfaces: opts.stale ?? new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

/** Render an arbitrary set of rows with a netif map derived from their ifnames. */
function renderRows(entries: [string, Modem][], netif?: NetifMessage) {
	return render(CellularSection, {
		props: {
			modemEntries: entries,
			netif:
				netif ??
				Object.fromEntries(
					entries.map(([, m], i) => [
						m.ifname,
						{ tp: 0, enabled: true, ip: `10.0.0.${i + 5}` },
					]),
				),
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("CellularSection — T20 single-line rows + touch targets", () => {
	it("renders NO per-row telemetry (no LinkIndicator / signal% / speed Badge)", () => {
		const { container } = renderSection();
		expect(container.querySelectorAll("[data-live-value]").length).toBe(0);
	});

	it("merges identity + controls into ONE row (py-2.5, no .mt-2.5 control row)", () => {
		const { container } = renderSection();
		expect(container.querySelector(".mt-2\\.5")).toBeNull();
		expect(container.querySelector(".divide-y > .py-2\\.5")).not.toBeNull();
		expect(container.querySelector(".divide-y > .py-4")).toBeNull();
	});

	it("configure button carries the 44px touch-min class under data-layout-mode=touch", () => {
		document.documentElement.dataset.layoutMode = "touch";
		const { getByTestId } = renderSection();
		expect(getByTestId("open-modem-config-dialog").className).toContain(
			TOUCH_MIN_CLASS,
		);
	});

	it("KEEPS the stale Badge for an aged modem with a SIM", () => {
		const { container } = renderSection({ stale: new Set(["usb0"]) });
		expect(
			container.querySelector('[data-stale-interface="usb0"]'),
		).not.toBeNull();
	});

	it("KEEPS the noSimBond disabledReason bond toggle for a no-SIM modem", () => {
		const { container } = renderSection({ modem: { no_sim: true } });
		expect(
			container.querySelector('[data-testid="bond-toggle-usb0"]'),
		).not.toBeNull();
		// No SIM → no stale badge either (showStale gated on !noSim).
		expect(container.querySelector('[data-stale-interface="usb0"]')).toBeNull();
	});
});

// ── todo 26 — every device class renders a row, none hidden ──────────────────

/** The wire fixtures Wave 4 actually produces, one per state the plan lists. */
/** A blocking lock renames the row's one primary control, so its testid moves with it. */
const actionTestId = (row: { action?: "configure" | "unlock" }) =>
	row.action === "unlock"
		? "open-modem-unlock-dialog"
		: "open-modem-config-dialog";

const STATE_TABLE: ReadonlyArray<{
	id: string;
	label: string;
	band: string;
	state: string;
	configurable: boolean;
	bondLive: boolean;
	action?: "configure" | "unlock";
	modem: Modem;
}> = [
	{
		id: "mm-healthy",
		label: "mm-managed healthy",
		band: "mm-managed",
		state: "connected",
		configurable: true,
		bondLive: true,
		modem: modem({
			ifname: "ww0",
			device_class: "usb",
			slot_label: "SIM 1",
			stable_key: "platform-usb-1:1",
		}),
	},
	{
		id: "mm-registering",
		label: "mm-managed registering",
		band: "mm-managed",
		state: "registered",
		configurable: true,
		bondLive: true,
		modem: modem({
			ifname: "ww1",
			device_class: "pcie-mhi",
			status: {
				connection: "registered",
				signal: 35,
				roaming: false,
				network_type: "5G",
			},
		}),
	},
	{
		id: "mm-locked",
		label: "mm-managed locked",
		band: "mm-managed",
		state: "locked",
		configurable: true,
		bondLive: true,
		action: "unlock",
		modem: modem({
			ifname: "ww2",
			device_class: "usb",
			sim_lock: { required: "sim-pin", remainingAttempts: 3 },
		}),
	},
	{
		id: "router-up",
		label: "router-ethernet up",
		band: "router-ethernet",
		state: "router-up",
		configurable: false,
		bondLive: false,
		modem: {
			ifname: "dg0h",
			name: "dongle0",
			network_type: { supported: [], active: null },
			device_class: "router-ethernet",
			availability_reason: "router_managed",
			slot_label: "dongle0",
		} as Modem,
	},
	{
		id: "router-acquiring",
		label: "router-ethernet acquiring",
		band: "router-ethernet",
		state: "router-acquiring",
		configurable: false,
		bondLive: false,
		modem: {
			ifname: "dg1h",
			name: "dongle1",
			network_type: { supported: [], active: null },
			device_class: "router-ethernet",
			availability_reason: "dongle_acquiring",
			slot_label: "dongle1",
		} as Modem,
	},
	{
		id: "router-down",
		label: "router-ethernet down",
		band: "router-ethernet",
		state: "router-down",
		configurable: false,
		bondLive: false,
		modem: {
			ifname: "dg2h",
			name: "dongle2",
			network_type: { supported: [], active: null },
			device_class: "router-ethernet",
			availability_reason: "dongle_down",
			slot_label: "dongle2",
		} as Modem,
	},
	{
		id: "unmanaged",
		label: "unrecognised transport",
		band: "unmanaged",
		state: "unknown",
		configurable: false,
		bondLive: true,
		modem: {
			ifname: "wwan9",
			name: "Unknown WWAN",
			network_type: { supported: [], active: null },
			// A transport this build does not know — schema-shaped, value unknown.
			device_class: "thunderbolt-wwan",
		} as unknown as Modem,
	},
];

const ALL_ROWS: [string, Modem][] = STATE_TABLE.map((row) => [
	row.id,
	row.modem,
]);

/** One table row by id — throws rather than silently rendering `undefined`. */
function fixture(id: string): Modem {
	const row = STATE_TABLE.find((entry) => entry.id === id);
	if (row === undefined) throw new Error(`unknown state-table fixture: ${id}`);
	return row.modem;
}

describe("CellularSection — todo 26 state table (every class renders a row)", () => {
	it("renders EXACTLY one row per device — nothing is hidden", () => {
		const { container } = renderRows(ALL_ROWS);
		const rows = container.querySelectorAll('[data-testid="modem-row"]');
		expect(rows.length).toBe(STATE_TABLE.length);
	});

	it.each(STATE_TABLE.map((row) => [row.label, row] as const))(
		"%s renders its own band + state",
		(_label, row) => {
			const { container } = renderRows([[row.id, row.modem]]);
			const el = container.querySelector<HTMLElement>(
				'[data-testid="modem-row"]',
			);
			expect(el).not.toBeNull();
			expect(el?.dataset.classBand).toBe(row.band);
			expect(el?.dataset.modemState).toBe(row.state);
			// The row is never blank: it always names the device.
			expect(
				container
					.querySelector('[data-testid="modem-name"]')
					?.textContent?.trim(),
			).toBeTruthy();
			// Class band + lifecycle state are both WORDS on screen, not just data-*.
			const classBadge = container.querySelector(
				'[data-testid="modem-class-badge"]',
			);
			const stateBadge = container.querySelector(
				'[data-testid="modem-state-badge"]',
			);
			expect(classBadge?.textContent?.trim()).toBeTruthy();
			expect(stateBadge?.textContent?.trim()).toBeTruthy();
		},
	);

	it.each(STATE_TABLE.map((row) => [row.label, row] as const))(
		"%s keeps a bond toggle AND a configure control (never removed)",
		(_label, row) => {
			const { container } = renderRows([[row.id, row.modem]]);
			expect(
				container.querySelector(
					`[data-testid="bond-toggle-${row.modem.ifname}"]`,
				),
			).not.toBeNull();
			expect(
				container.querySelector(`[data-testid="${actionTestId(row)}"]`),
			).not.toBeNull();
		},
	);

	it.each(STATE_TABLE.map((row) => [row.label, row] as const))(
		"%s keeps the 44px touch target on its configure control",
		(_label, row) => {
			document.documentElement.dataset.layoutMode = "touch";
			const { container } = renderRows([[row.id, row.modem]]);
			const button = container.querySelector<HTMLElement>(
				`[data-testid="${actionTestId(row)}"]`,
			);
			expect(button?.className).toContain(TOUCH_MIN_CLASS);
		},
	);

	it.each(
		STATE_TABLE.filter((row) => !row.configurable).map(
			(row) => [row.label, row] as const,
		),
	)("%s disables Configure WITH a visible reason", (_label, row) => {
		const { container } = renderRows([[row.id, row.modem]]);
		const button = container.querySelector<HTMLButtonElement>(
			`[data-testid="${actionTestId(row)}"]`,
		);
		expect(button?.disabled).toBe(true);
		const configureKey = configureDisabledReasonKey(row.band as ModemClassBand);
		const note = container.querySelector(
			`[data-testid="modem-note"][data-note-key="${configureKey}"]`,
		);
		expect(note?.textContent?.trim()).toBeTruthy();
	});

	it.each(
		STATE_TABLE.filter((row) => row.configurable).map(
			(row) => [row.label, row] as const,
		),
	)("%s leaves Configure enabled", (_label, row) => {
		const { container } = renderRows([[row.id, row.modem]]);
		const button = container.querySelector<HTMLButtonElement>(
			`[data-testid="${actionTestId(row)}"]`,
		);
		expect(button?.disabled).toBe(false);
	});

	it("no row stacks more than TWO explanation lines — a shared reason is stated once", () => {
		const { container } = renderRows(ALL_ROWS);
		for (const row of STATE_TABLE) {
			const el = container.querySelector<HTMLElement>(
				`[data-modem-id="${row.id}"]`,
			);
			const notes = el?.querySelectorAll('[data-testid="modem-note"]') ?? [];
			expect(notes.length, `${row.label} note count`).toBeLessThanOrEqual(2);
			const keys = [...notes].map((n) => n.getAttribute("data-note-key"));
			expect(new Set(keys).size, `${row.label} duplicate note`).toBe(
				keys.length,
			);
		}
	});

	it("dimmed-unavailable rows are marked, and MM-managed rows are not", () => {
		const { container } = renderRows(ALL_ROWS);
		for (const row of STATE_TABLE) {
			const el = container.querySelector<HTMLElement>(
				`[data-modem-id="${row.id}"]`,
			);
			expect(el?.dataset.unavailable).toBe(
				row.configurable ? undefined : "true",
			);
		}
	});

	it("a machine availability token is NEVER rendered raw", () => {
		const { container } = renderRows(ALL_ROWS);
		const text = container.textContent ?? "";
		for (const token of ["router_managed", "dongle_acquiring", "dongle_down"]) {
			expect(text).not.toContain(token);
		}
		// …and the explanation IS on screen for every device carrying one. What
		// must survive is the EXPLANATION, not one exact key: a reason may be
		// superseded by a strictly more specific line that already states it
		// (the unverified-write refusal covers the generic "settings live in its
		// own web interface" sentence), and the row deliberately prints only the
		// informative one.
		for (const row of STATE_TABLE) {
			if (row.modem.availability_reason === undefined) continue;
			const notes = [
				...container.querySelectorAll(
					`[data-modem-id="${row.id}"] [data-testid="modem-note"]`,
				),
			];
			expect(notes.length, row.label).toBeGreaterThan(0);
			for (const note of notes) {
				expect(note.textContent?.trim(), row.label).toBeTruthy();
			}

			const keys = notes.map((note) => note.getAttribute("data-note-key"));
			const stated =
				keys.includes(availabilityReasonKey(row.modem.availability_reason)) ||
				keys.includes("network.cellular.reason.routerControlsUnverified");
			expect(stated, row.label).toBe(true);
		}
	});

	it("no rendered string is a bare i18n dot-path — a missing key must not ship as one", () => {
		const { container } = renderRows(ALL_ROWS);
		const DOTTED_KEY =
			/(?:^|\s)[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2,}(?:\s|$)/;
		for (const el of container.querySelectorAll<HTMLElement>("p, span")) {
			if (el.children.length > 0) continue;
			const text = (el.textContent ?? "").trim();
			if (text === "") continue;
			expect(text, `rendered as a dotted key: ${text}`).not.toMatch(DOTTED_KEY);
		}
	});

	/**
	 * This case used to require the `MODEM-SUPPORT-MATRIX.md` tier vocabulary
	 * VERBATIM, which made the badge read `MM-managed` / `Router-ethernet` — the
	 * wire band with a capital letter glued on. That is the §3 OL-1 leak, on the
	 * one pill whose whole job is to say what KIND of device this is: an operator
	 * cannot act on the name of the daemon that controls it, and `mm-managed` is
	 * not a phrase anyone outside this repo has read.
	 *
	 * So the requirement is INVERTED rather than dropped. The engineering
	 * vocabulary is still the wire truth, still on `data-class-band`, and still
	 * in the diagnostics `transport` row — it simply may not be the operator's
	 * word for it. Both directions are asserted so the badge can neither regress
	 * to a token nor quietly lose its distinctions.
	 */
	it("class badges name a device an operator recognises, never the wire band", () => {
		const { container } = renderRows(ALL_ROWS);
		const badges = [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid="modem-class-badge"]',
			),
		];
		const labels = badges.map((el) => el.textContent?.trim());

		expect(labels).toContain("Directly managed");
		expect(labels).toContain("Router dongle");
		expect(labels).toContain("Unrecognised");

		for (const badge of badges) {
			const band = badge.dataset.classBand ?? "";
			expect(band, "the wire band is still published for machines").not.toBe(
				"",
			);
			expect(
				(badge.textContent ?? "").toLowerCase(),
				`class badge rendered its wire band "${band}"`,
			).not.toContain(band);
		}
	});

	it("an unknown device_class falls back to an honest generic row, never a crash or a blank", () => {
		const { container } = renderRows([["unmanaged", fixture("unmanaged")]]);
		const el = container.querySelector<HTMLElement>(
			'[data-testid="modem-row"]',
		);
		expect(el).not.toBeNull();
		expect(el?.dataset.classBand).toBe("unmanaged");
		expect(container.textContent).toContain("Unknown WWAN");
		// The unrecognised transport string itself never reaches the operator.
		expect(container.textContent).not.toContain("thunderbolt-wwan");
	});

	it("a device that reported NO radio status draws NO signal glyph", () => {
		const { container } = renderRows(ALL_ROWS);
		for (const row of STATE_TABLE) {
			const el = container.querySelector<HTMLElement>(
				`[data-modem-id="${row.id}"]`,
			);
			const signal = el?.querySelector('[data-testid="modem-signal"]');
			if (row.modem.status === undefined) {
				expect(signal).toBeNull();
			} else {
				expect(signal).not.toBeNull();
			}
		}
	});

	it("the signal glyph is qualitative — a tier and a word, never a number", () => {
		const { container } = renderRows([["mm-healthy", fixture("mm-healthy")]]);
		const signal = container.querySelector<HTMLElement>(
			'[data-testid="modem-signal"]',
		);
		expect(signal?.dataset.signalTier).toBe("medium");
		expect(signal?.getAttribute("aria-label")?.trim()).toBeTruthy();
		expect(signal?.textContent ?? "").not.toMatch(/\d/);
		// It is NOT the removed telemetry readout BondedLinksSection owns.
		expect(container.querySelectorAll("[data-live-value]").length).toBe(0);
	});

	it("the slot badge renders when it adds information and is suppressed when it repeats the name", () => {
		const withSlot = renderRows([["mm-healthy", fixture("mm-healthy")]]);
		expect(
			withSlot.container.querySelector('[data-testid="modem-slot-badge"]')
				?.textContent,
		).toContain("SIM 1");

		const dongle = renderRows([["router-up", fixture("router-up")]]);
		expect(
			dongle.container.querySelector('[data-testid="modem-slot-badge"]'),
		).toBeNull();
	});

	it("an address-less modem keeps its toggle, disabled with a visible reason", () => {
		const { container } = renderRows([["mm-healthy", fixture("mm-healthy")]], {
			ww0: { tp: 0, enabled: false },
		});
		expect(
			container.querySelector('[data-testid="bond-toggle-ww0"]'),
		).not.toBeNull();
		expect(
			container
				.querySelector(
					'[data-testid="modem-note"][data-note-key="network.cellular.bond.noAddress"]',
				)
				?.textContent?.trim(),
		).toBeTruthy();
	});
});

describe("CellularSection — the cellular stack is still initializing", () => {
	function renderInitializing(
		cellularInitializing: boolean | undefined,
		entries: [string, Modem][] = [],
	) {
		return render(CellularSection, {
			props: {
				modemEntries: entries,
				netif: {},
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				...(cellularInitializing === undefined ? {} : { cellularInitializing }),
				onConfigure: vi.fn(),
			},
		});
	}

	it("renders the calm band and withholds the 'no SIM cards' claim", () => {
		const { container } = renderInitializing(true);
		const band = container.querySelector(
			'[data-testid="cellular-initializing"]',
		);
		expect(band).not.toBeNull();
		expect(band?.getAttribute("role")).toBe("status");
		expect(band?.textContent?.trim()).toBeTruthy();
		// The empty roster is expected during the window, so reporting it as "no
		// SIM cards detected" would be a claim the device cannot make yet.
		expect(container.textContent).not.toContain("No SIM cards detected");
	});

	it("still renders whatever roster HAS arrived, explained rather than hidden", () => {
		const { container } = renderInitializing(true, [
			["mm-healthy", fixture("mm-healthy")],
		]);
		expect(
			container.querySelector('[data-testid="cellular-initializing"]'),
		).not.toBeNull();
		expect(container.querySelectorAll('[data-testid="modem-row"]').length).toBe(
			1,
		);
	});

	it("an ABSENT flag is not an initializing stack — the empty state is unchanged", () => {
		const { container } = renderInitializing(undefined);
		expect(
			container.querySelector('[data-testid="cellular-initializing"]'),
		).toBeNull();
		expect(container.textContent).toContain("No SIM cards detected");
	});

	it("retracts once the stack commits", async () => {
		const { container, rerender } = renderInitializing(true);
		expect(
			container.querySelector('[data-testid="cellular-initializing"]'),
		).not.toBeNull();
		await rerender({
			modemEntries: [["mm-healthy", fixture("mm-healthy")]],
			netif: {},
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			cellularInitializing: false,
			onConfigure: vi.fn(),
		});
		expect(
			container.querySelector('[data-testid="cellular-initializing"]'),
		).toBeNull();
	});
});

/**
 * The 2026-08-16 board (Rock 5B+): a Quectel RM530N-GL in the ordinary `enabled`
 * state and a SIMCom SIM7600G-H whose SIM slot is empty. The operator's report
 * was "only three of them appear… the modems should appear in cellular even if
 * they don't have SIM cards, so that message is wrong" — so BOTH radios must be
 * rows, and the empty-state claim must be gone the moment either exists.
 */
describe("CellularSection — the real board roster", () => {
	const BOARD: [string, Modem][] = [
		[
			"2",
			modem({
				ifname: "wwan0",
				name: "RM530N-GL - 16855",
				status: {
					connection: "enabled",
					signal: 0,
					roaming: false,
					network_type: "",
				},
			}),
		],
		[
			"4",
			modem({
				ifname: "wwan1",
				name: "SIMCOM_SIM7600G-H",
				no_sim: true,
				status: {
					connection: "failed",
					signal: 0,
					roaming: false,
					network_type: "",
				},
			}),
		],
	];

	it("renders BOTH radios, including the one with no SIM", () => {
		const { container } = renderRows(BOARD);
		const rows = container.querySelectorAll<HTMLElement>(
			'[data-testid="modem-row"]',
		);

		expect(rows.length).toBe(2);
		expect([...rows].map((r) => r.dataset.modemState)).toEqual([
			"enabled",
			"no-sim",
		]);
		expect(container.textContent).not.toContain("No SIM cards detected");
	});

	it("names both radios and states each one's condition in words", () => {
		const { container } = renderRows(BOARD);
		const names = [
			...container.querySelectorAll('[data-testid="modem-name"]'),
		].map((n) => n.textContent?.trim());
		const states = [
			...container.querySelectorAll('[data-testid="modem-state-badge"]'),
		].map((n) => n.textContent?.trim());

		expect(names).toEqual(["RM530N-GL - 16855", "SIMCOM_SIM7600G-H"]);
		expect(states[0]).toBe("Enabled");
		expect(states[1]).toBe("No SIM");
	});

	it("the no-SIM radio keeps its controls, disabled with the no-SIM reason", () => {
		const { container } = renderRows([BOARD[1] as [string, Modem]]);
		const toggle = container.querySelector<HTMLButtonElement>(
			'button[role="switch"]',
		);

		expect(toggle?.disabled).toBe(true);
		expect(container.textContent).toContain("No SIM — cannot bond");
	});

	it("a status-only partial broadcast renders a row instead of crashing the view", () => {
		const partial = { status: { connection: "enabled" } } as unknown as Modem;
		const { container } = renderRows([["2", partial]], {});
		const row = container.querySelector<HTMLElement>(
			'[data-testid="modem-row"]',
		);

		expect(row).not.toBeNull();
		expect(row?.dataset.modemState).toBe("enabled");
		expect(
			container
				.querySelector('[data-testid="modem-name"]')
				?.textContent?.trim(),
		).toBe("2");
	});
});

/**
 * Todo 46 — the locked row IS the unlock affordance.
 *
 * The global auto-open that used to carry this flow is gone, so the row is now
 * the only way an operator reaches an unlock. If the button stops naming what
 * it does, or stops firing, a locked SIM becomes unreachable from the UI
 * entirely — which is exactly the state this suite exists to prevent.
 */
describe("CellularSection — SIM-lock affordance (todo 46)", () => {
	const lockedModem = (required: string) =>
		modem({
			ifname: "ww9",
			device_class: "usb",
			sim_lock: { required, remainingAttempts: 3 },
		} as Partial<Modem>);

	function renderLocked(required: string) {
		const onConfigure = vi.fn();
		const entries: [string, Modem][] = [["m9", lockedModem(required)]];
		const { container } = render(CellularSection, {
			props: {
				modemEntries: entries,
				netif: {
					ww9: { tp: 0, enabled: true, ip: "10.0.0.9" },
				} as NetifMessage,
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				onConfigure,
			},
		});
		return { container, onConfigure };
	}

	it.each(["sim-pin", "sim-puk"])(
		"%s renames the control to Unlock — it never says Configure over a PIN prompt",
		(required) => {
			const { container } = renderLocked(required);
			const btn = container.querySelector<HTMLButtonElement>(
				'[data-testid="open-modem-unlock-dialog"]',
			);
			expect(btn).not.toBeNull();
			expect(btn?.dataset.rowAction).toBe("unlock");
			expect(btn?.textContent?.trim()).toBe("Unlock SIM");
			expect(
				container.querySelector('[data-testid="open-modem-config-dialog"]'),
			).toBeNull();
		},
	);

	it.each(["sim-pin2", "sim-puk2"])(
		"%s keeps Configure — the modem registers and streams, so its settings stay reachable",
		(required) => {
			const { container } = renderLocked(required);
			const btn = container.querySelector<HTMLButtonElement>(
				'[data-testid="open-modem-config-dialog"]',
			);
			expect(btn).not.toBeNull();
			expect(btn?.dataset.rowAction).toBe("configure");
			expect(
				container.querySelector('[data-testid="open-modem-unlock-dialog"]'),
			).toBeNull();
		},
	);

	it.each(["sim-pin", "sim-puk"])(
		"%s discloses the lock ON THE ROW — it stays the discovery surface",
		(required) => {
			const { container } = renderLocked(required);
			// A lock that stops the radio owns the state badge outright, and it says
			// so in a WORD rather than by colour alone.
			const badge = container.querySelector<HTMLElement>(
				'[data-testid="modem-state-badge"]',
			);
			expect(badge?.dataset.modemState).toBe("locked");
			expect(badge?.textContent?.trim()).toBeTruthy();
		},
	);

	it.each(["sim-pin2", "sim-puk2"])(
		"%s is not surfaced at all — the row reads exactly as an unlocked one",
		(required) => {
			const { container } = renderLocked(required);
			const badge = container.querySelector<HTMLElement>(
				'[data-testid="modem-state-badge"]',
			);
			expect(badge?.dataset.modemState).toBe("connected");
			expect(container.querySelector("[data-sim-lock]")).toBeNull();
			expect(container.textContent).not.toContain("SIM locked");
		},
	);

	it("renders NO separate lock pill for any lock — the surface is gone", () => {
		for (const required of ["sim-pin", "sim-pin2", "sim-puk", "sim-puk2"]) {
			const { container } = renderLocked(required);
			expect(
				container.querySelector('[data-testid="modem-lock-badge"]'),
			).toBeNull();
		}
	});

	it("fires onConfigure with the modem id so the view can route it", () => {
		const { container, onConfigure } = renderLocked("sim-pin");
		container
			.querySelector<HTMLButtonElement>(
				'[data-testid="open-modem-unlock-dialog"]',
			)
			?.click();
		expect(onConfigure).toHaveBeenCalledWith("m9");
	});

	it("leaves an unlocked modem's control untouched", () => {
		const onConfigure = vi.fn();
		const { container } = render(CellularSection, {
			props: {
				modemEntries: [["m0", modem({ ifname: "ww0" })]] as [string, Modem][],
				netif: {
					ww0: { tp: 0, enabled: true, ip: "10.0.0.5" },
				} as NetifMessage,
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				onConfigure,
			},
		});
		expect(
			container.querySelector('[data-testid="open-modem-config-dialog"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="open-modem-unlock-dialog"]'),
		).toBeNull();
	});
});

/**
 * Todo 49 — the live Quectel RM530N-GL row, end to end.
 *
 * The board reported 81% signal while `searching` behind a non-blocking
 * `sim-pin2`, and the row rendered "SIM locked" with no stated reason. These
 * assertions pin the rendered DOM against the REAL mmcli reading so the row can
 * never silently fall back to a zeroed glyph or a vague note again.
 */
describe("a searching modem renders its real signal and the real refusal", () => {
	const quectel = {
		ifname: "wwan0",
		name: "RM530N-GL - 16855",
		model: "RM530N-GL",
		network_type: { supported: ["4g3g"], active: "4g3g" },
		status: {
			connection: "searching",
			signal: 81,
			roaming: false,
			network: "TIGO",
			network_type: "",
		},
		sim_lock: { required: "sim-pin2", remainingAttempts: 3 },
		packet_service_state: "detached",
		registration_rejection: {
			error: "no-cells-in-location-area",
			access_technology: "lte",
			operator_id: "999999",
		},
	} as Modem;

	function renderQuectel() {
		return renderRows([["2", quectel]], {
			wwan0: { tp: 0, enabled: false },
		} as NetifMessage);
	}

	it("draws the STRONG glyph the radio actually reported, not a zeroed one", () => {
		const { container } = renderQuectel();
		const signal = container.querySelector<HTMLElement>(
			'[data-testid="modem-signal"]',
		);
		expect(signal).not.toBeNull();
		expect(signal?.dataset.signalTier).toBe("high");
		expect(signal?.dataset.signalTier).not.toBe("none");
	});

	it("shows the radio's own state instead of blaming the non-blocking lock", () => {
		const { container } = renderQuectel();
		const row = container.querySelector<HTMLElement>(
			'[data-testid="modem-row"]',
		);
		expect(row?.dataset.modemState).toBe("searching");
	});

	it("states the network's actual refusal, ahead of the bonding consequence", () => {
		const { container } = renderQuectel();
		const notes = [
			...container.querySelectorAll<HTMLElement>('[data-testid="modem-note"]'),
		].map((n) => n.dataset.noteKey);
		expect(notes[0]).toBe("network.cellular.rejection.noCells");
		expect(notes).toContain("network.cellular.bond.noAddress");
	});

	it("never leaks a raw mmcli token to the operator", () => {
		const { container } = renderQuectel();
		expect(container.textContent).not.toContain("no-cells-in-location-area");
		expect(container.textContent).not.toContain("detached");
		expect(container.textContent).not.toContain("999999");
	});
});

describe("the roaming badge — informational, and it never touches the controls", () => {
	function roamingRow(roaming: boolean) {
		return renderSection({
			modem: {
				status: {
					connection: "connected",
					signal: 65,
					roaming,
					network: "Partner",
					network_type: "4G",
				},
			} as Partial<Modem>,
		});
	}

	it("appears, in a WORD, when the modem reports it is roaming", () => {
		const { container } = roamingRow(true);
		const badge = container.querySelector<HTMLElement>(
			'[data-testid="modem-roaming-badge"]',
		);
		expect(badge).not.toBeNull();
		expect(badge?.textContent?.trim()).toBe("Roaming");
		expect(badge?.title).toBeTruthy();
	});

	it("is absent on a modem on its home network — no dead chrome", () => {
		const { container } = roamingRow(false);
		expect(
			container.querySelector('[data-testid="modem-roaming-badge"]'),
		).toBeNull();
	});

	it("leaves the state badge telling the RADIO's truth, not the billing one", () => {
		const { container } = roamingRow(true);
		const state = container.querySelector<HTMLElement>(
			'[data-testid="modem-state-badge"]',
		);
		expect(state?.dataset.modemState).toBe("connected");
	});

	it("changes NOTHING about the row's bond toggle or Configure control", () => {
		const home = roamingRow(false).container;
		const away = roamingRow(true).container;

		const controls = (root: ParentNode) => {
			const bond = root.querySelector<HTMLElement>(
				'[data-testid="bond-toggle-usb0"]',
			);
			const configure = root.querySelector<HTMLButtonElement>(
				'[data-testid="open-modem-config-dialog"]',
			);
			expect(bond).not.toBeNull();
			expect(configure).not.toBeNull();
			return {
				bondDisabled: bond?.hasAttribute("disabled"),
				bondChecked: bond?.getAttribute("aria-checked"),
				configureDisabled: configure?.hasAttribute("disabled"),
				rowUnavailable: root
					.querySelector<HTMLElement>('[data-testid="modem-row"]')
					?.getAttribute("data-unavailable"),
			};
		};

		expect(controls(away)).toEqual(controls(home));
	});

	it("adds the badge and NOTHING ELSE — the rest of the row is byte-identical", () => {
		// The strongest form of "informational": strip the badge back out of the
		// roaming row and the two rows' markup must be indistinguishable. Any
		// control, class, or data attribute that reacted to roaming shows up here.
		const home = roamingRow(false).container;
		const away = roamingRow(true).container;

		const awayRow = away.querySelector<HTMLElement>(
			'[data-testid="modem-row"]',
		);
		awayRow?.querySelector('[data-testid="modem-roaming-badge"]')?.remove();

		// Normalised for the two things that differ between ANY two renders and
		// carry no meaning: bits-ui's auto-generated element ids, and Svelte's
		// block anchor comments (the `{#if}` leaves one behind either way).
		const normalise = (html: string | undefined) =>
			(html ?? "")
				.replace(/id="bits-c\d+"/g, 'id="bits"')
				.replace(/(<!---->)+/g, "<!---->");

		expect(normalise(awayRow?.outerHTML)).toBe(
			normalise(
				home.querySelector<HTMLElement>('[data-testid="modem-row"]')?.outerHTML,
			),
		);
	});

	it("renders no raw machine token and no unresolved dotted key", () => {
		const { container } = roamingRow(true);
		const badge = container.querySelector<HTMLElement>(
			'[data-testid="modem-roaming-badge"]',
		);
		expect(badge?.textContent).not.toMatch(/network\.cellular\./);
		expect(badge?.title).not.toMatch(/network\.cellular\./);
	});
});
