// @vitest-environment jsdom
/**
 * THE SWEEP: no machine identifier the device put on the wire reaches an
 * operator-facing region of any modem surface.
 *
 * `DESIGN.md` §3 (OL-1 … OL-5) says a wire token is keyed to copy everywhere an
 * operator reads, and RELOCATED — never deleted — into a marked diagnostics
 * block. Todo 15 closed the two loudest holes (the USB-mode card and the
 * band-lock chips) and todo 25 built the diagnostics destination. This file is
 * the gate that says the rest of the surface is clean too, and stays clean.
 *
 * ── THE FORBIDDEN SET IS DERIVED FROM THE FIXTURE, NOT TYPED OUT ────────────
 *
 * A hand-written token list is a gate that only catches the leaks somebody
 * already found: `modem-pass4.visual.spec.ts` carries ten literals, and a
 * vocabulary this stack grows every release will outrun them. So each family's
 * forbidden set is COLLECTED from its own payload — every string leaf shaped
 * like a machine identifier — and the surface is asserted not to contain any of
 * them. Add a wire field and the gate covers it the moment a fixture states it.
 *
 * The collector is deliberately LOWERCASE-ONLY. Every vocabulary this stack
 * relocates is lowercase (`router-ethernet`, `sim-pin`, `ecm-ncm`,
 * `plmn-not-allowed`, `hspa-plus`, `with-profiles`, `not-reported`), while the
 * strings that legitimately reach an operator with a hyphen in them are device
 * DISPLAY names and vendor table rows that are not lowercase — `RM530N-GL`,
 * `LTE_BAND_3`, `NO SERVICE`. Widening to any case would flag a modem's own
 * product name, which is the one string on the row that MUST render verbatim.
 *
 * ── AND THE SEARCHED TEXT IS SCRUBBED BY SELECTOR ──────────────────────────
 *
 * Marked diagnostics subtrees (`data-testid*="diagnostic"`) are removed before
 * the scan, exactly as the e2e operator-text scan removes them, so this gate
 * never has to know which of two dozen field ids happen to carry a raw value —
 * and a token that survives ONLY there is the relocation working as designed.
 * `aria-label` and `title` are scanned alongside `textContent`: an accessible
 * name is operator-facing copy that a sighted scan cannot see, and OL-2's
 * original defect was precisely a control whose accessible name was a vendor
 * identifier.
 *
 * `data-*` attributes are NOT scanned. They are the machine-facing half of this
 * contract — every surface here deliberately publishes its raw verdict as
 * `data-modem-state` / `data-sim-lock` / `data-class-band` so a test can name a
 * state without matching on copy.
 */
import { m } from "@ceraui/i18n/svelte";
import type { Modem } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { USB_MODE_RAW_TOKENS } from "$lib/modem/operator-labels";
import CellularSection from "$main/network/CellularSection.svelte";

import ModemConfigDialog from "../main/dialogs/ModemConfigDialog.svelte";
import RouterDongleDialog from "../main/dialogs/RouterDongleDialog.svelte";
import { publishModems, resetModemsFeed } from "./helpers/modem-feed.svelte";

const usbModeOptions = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			configure: vi.fn(),
			getUsbModeOptions: usbModeOptions,
			scan: vi.fn(),
			setRouterControl: vi.fn(),
			setRouterNetMode: vi.fn(),
			setUsbMode: vi.fn(),
		},
	},
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("./helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
		getConnectionState: () => "connected",
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

// Every case mounts a whole surface, so this file is render-bound rather than
// assertion-bound — the same reasoning `ModemConfigDialog.detail.test.ts`
// records for its own budget.
vi.setConfig({ testTimeout: 30000 });

/**
 * A string leaf shaped like a machine identifier: all lowercase, no spaces, and
 * carrying at least one `-`/`_` separator. Anchored, so a value that merely
 * CONTAINS one (a URL, an opaque `platform-…:2` key, a sentence) is not one.
 */
const MACHINE_TOKEN_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/;

/**
 * A token short enough to collide with ordinary copy would make the scan a
 * coin-flip. Nothing this stack relocates is shorter than this, and the two
 * families it excludes (`no_sim`-style booleans are not strings at all) carry
 * no rendering risk.
 */
const MIN_TOKEN_LENGTH = 6;

function collectMachineTokens(value: unknown, out: Set<string>): void {
	if (typeof value === "string") {
		if (value.length >= MIN_TOKEN_LENGTH && MACHINE_TOKEN_RE.test(value)) {
			out.add(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectMachineTokens(item, out);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) collectMachineTokens(item, out);
	}
}

/** Every machine identifier this fixture actually states. */
function machineTokensOf(modem: Modem): string[] {
	const found = new Set<string>();
	collectMachineTokens(modem, found);
	return [...found].sort();
}

/**
 * Operator-facing text of one surface: rendered copy plus every accessible name,
 * with the marked diagnostics subtrees removed.
 *
 * The dialogs portal their content out of the render container, so the scan
 * reads `document.body` and not the harness node — an absence asserted against
 * the container would pass on whatever failed to render.
 */
function operatorText(root: ParentNode): string {
	const clone = root.cloneNode(true) as HTMLElement;
	for (const marked of clone.querySelectorAll('[data-testid*="diagnostic"]')) {
		marked.remove();
	}
	const names: string[] = [];
	for (const el of clone.querySelectorAll<HTMLElement>(
		"[aria-label],[title]",
	)) {
		names.push(
			el.getAttribute("aria-label") ?? "",
			el.getAttribute("title") ?? "",
		);
	}
	return `${clone.textContent ?? ""} ${names.join(" ")}`
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function diagnosticsText(root: ParentNode): string {
	const parts: string[] = [];
	for (const marked of root.querySelectorAll('[data-testid*="diagnostic"]')) {
		parts.push(marked.textContent ?? "");
	}
	return parts.join(" ").replace(/\s+/g, " ").toLowerCase();
}

function expectNoRawTokens(
	label: string,
	root: ParentNode,
	modem: Modem,
): void {
	const text = operatorText(root);
	for (const token of machineTokensOf(modem)) {
		expect(
			text,
			`${label}: wire token "${token}" reached operator copy`,
		).not.toContain(token);
	}
	// The USB-composition vocabulary is checked in FULL on every family, not only
	// the value a given fixture happens to carry: the card offers switch targets
	// the payload never states, and OL-1's original defect was a target rendered
	// as its own wire token.
	for (const token of USB_MODE_RAW_TOKENS) {
		if (!token.includes("-")) continue;
		expect(
			text,
			`${label}: USB composition token "${token}" reached operator copy`,
		).not.toContain(token);
	}
	// The band grammar is open, so its DASHED spellings are checked as prefixes —
	// `eutran-3` and `eutran-28` are the same leak.
	for (const prefix of BAND_TOKEN_PREFIXES) {
		expect(
			text,
			`${label}: band token "${prefix}…" reached operator copy`,
		).not.toContain(prefix);
	}
}

/** The unambiguous dashed band spellings `parseBandToken` reads. */
const BAND_TOKEN_PREFIXES = [
	"eutran-",
	"ngran-",
	"utran-",
	"geran-",
	"nr-n",
	"lte-b",
	"umts-",
];

// ── Fixture families ────────────────────────────────────────────────────────
//
// Every free string on `modemSchema` is a `z.string()`, so ANY of these fields
// can carry a dashed token whatever produced it — `mmConvertAccessTech` returns
// an unrecognised access tech verbatim (`hspa-plus`), a vendor dialect names its
// own network modes, and the band grammar is deliberately open. The fixtures
// therefore state a machine identifier in each field the UI renders from, which
// is what makes the sweep non-vacuous.

function mmManaged(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		device_class: "usb",
		slot_label: "SIM 1",
		stable_key: "platform-xhci-hcd.0-usb-1:2",
		usb_mode: "ecm-ncm",
		recommended_usb_mode: "mbim",
		firmware_revision: "RM530NGLAAR01A08M4G",
		packet_service_state: "attached",
		network_type: { supported: ["5g4g", "lte-only"], active: "lte-only" },
		status: {
			connection: "connected",
			// The mmcli passthrough: an access tech `accessTechToGen` does not
			// know is returned VERBATIM, and `hspa-plus` is one of them.
			network_type: "hspa-plus",
			signal: 72,
			roaming: true,
			network: "Movistar",
		},
		esim: { sim_type: "esim", esim_status: "with-profiles" },
		cell_info: {
			tech: "nr",
			band: "n78",
			cell_id: "0x1A2B3C",
			rsrp: -92,
			provenance: { source: "qmi", observed_at: 1_770_000_000 },
		},
		...overrides,
	} as Modem;
}

function routerDongle(
	overrides: Partial<Modem> = {},
	admin: Record<string, unknown> = {},
): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		lock_state: "open",
		...overrides,
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			sim: "present",
			connection: "connected",
			model: "E3372",
			firmware: "22.333.01.00.00",
			serial: "Y4QDU17621000872",
			apn: "3gnet",
			controls: { mobile_data: true, roaming_autoconnect: false },
			details: {
				network_type: "hspa-plus",
				registration: "NO SERVICE",
				provider: "732103",
				band: "LTE_BAND_3",
				network_mode: "1",
				station_id: "0x0a1b",
			},
			capabilities: {
				net_mode: {
					state: "reported",
					current: "lte-only",
					// An UNNAMED mode: the firmware states an id and no name, which is
					// the exact shape OL-2's `mode.name ?? mode.id` fallback leaked.
					modes: [{ id: "lte-only" }, { id: "auto-any", name: "Automatic" }],
				},
			},
			signal: {
				provenance: "hilink-admin-api",
				freshness: "live",
				bars: { state: "known", value: 3 },
				max_bars: { state: "known", value: 5 },
				dbm: { state: "unknown", reason: "not-reported" },
				rsrp: { state: "unknown", reason: "unsupported" },
				rsrq: { state: "unknown", reason: "unsupported" },
				snr: { state: "unknown", reason: "unsupported" },
				sinr: { state: "unknown", reason: "not-reported" },
			},
			...admin,
		},
	} as unknown as Modem;
}

interface Family {
	readonly id: string;
	readonly modem: Modem;
}

const MM_FAMILIES: readonly Family[] = [
	{ id: "mm-managed · connected", modem: mmManaged() },
	{
		id: "mm-managed · SIM PIN locked",
		modem: mmManaged({ sim_lock: { required: "sim-pin" } } as Partial<Modem>),
	},
	{
		id: "mm-managed · empty slot",
		modem: mmManaged({
			no_sim: true,
			sim_presence: "absent",
		} as Partial<Modem>),
	},
	{
		id: "mm-managed · network refusal",
		modem: mmManaged({
			packet_service_state: "detached",
			registration_rejection: { error: "plmn-not-allowed" },
			status: { connection: "searching", signal: 81, roaming: false },
		} as Partial<Modem>),
	},
	{
		id: "mm-managed · pcie transport",
		modem: mmManaged({ device_class: "pcie-mhi", ifname: "wwan1" }),
	},
	{
		id: "unrecognised transport",
		modem: mmManaged({ device_class: "thunderbolt-wwan" }),
	},
	{
		id: "provisional · seen, not observed",
		modem: {
			ifname: "wwan2",
			name: "Unclassified modem",
			availability_reason: "modem_initializing",
		} as Modem,
	},
];

const ROUTER_FAMILIES: readonly Family[] = [
	{ id: "router-ethernet · direct", modem: routerDongle() },
	{
		id: "router-ethernet · admin login required",
		modem: routerDongle({
			lock_state: "locked",
			lock_detail: { sub_reason: "auth-failed" },
		} as Partial<Modem>),
	},
	{
		id: "router-ethernet · acquiring",
		modem: routerDongle({ availability_reason: "dongle_acquiring" }),
	},
	{
		id: "router-ethernet · down",
		modem: routerDongle({ availability_reason: "dongle_down" }),
	},
	{
		id: "router-ethernet · refused catalog",
		modem: routerDongle(
			{},
			{
				capabilities: {
					net_mode: { state: "unavailable", reason: "refused", code: "112008" },
				},
			},
		),
	},
];

const ALL_FAMILIES: readonly Family[] = [...MM_FAMILIES, ...ROUTER_FAMILIES];

function renderRow(modem: Modem) {
	return render(CellularSection, {
		props: {
			modemEntries: [["0", modem]] as [string, Modem][],
			netif: { [modem.ifname]: { tp: 0, enabled: true, ip: "10.0.0.5" } },
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

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
	usbModeOptions.mockReset();
	usbModeOptions.mockResolvedValue({ certified: ["mbim", "ecm-ncm"] });
});

describe("the scanner is not vacuous", () => {
	it.each(ALL_FAMILIES.map((family) => [family.id, family] as const))(
		"Given %s, Then the fixture states at least one machine identifier to look for",
		(_id, family) => {
			expect(machineTokensOf(family.modem).length).toBeGreaterThan(0);
		},
	);

	it("collects a dashed wire token and rejects a device display name", () => {
		const found = machineTokensOf({
			device_class: "router-ethernet",
			name: "Quectel RM530N-GL",
			usb_mode: "ecm-ncm",
			admin_url: "http://192.168.8.1",
			stable_key: "platform-xhci-hcd.0-usb-1:2",
			details: { band: "LTE_BAND_3", registration: "NO SERVICE" },
		} as unknown as Modem);

		expect(found).toContain("router-ethernet");
		expect(found).toContain("ecm-ncm");
		// A product name, a URL, an opaque key and a vendor table row all reach an
		// operator legitimately and must never enter the forbidden set.
		expect(found).not.toContain("Quectel RM530N-GL");
		expect(found).not.toContain("http://192.168.8.1");
		expect(found).not.toContain("platform-xhci-hcd.0-usb-1:2");
		expect(found).not.toContain("LTE_BAND_3");
	});

	it("PLANTED VIOLATION — a raw token in rendered copy is caught", () => {
		const host = document.createElement("div");
		host.innerHTML = "<p>Active mode: ecm-ncm</p>";
		expect(() => expectNoRawTokens("planted", host, mmManaged())).toThrowError(
			/ecm-ncm/,
		);
	});

	it("PLANTED VIOLATION — a raw token in an accessible name is caught", () => {
		const host = document.createElement("div");
		host.innerHTML = '<button aria-label="switch to ecm-ncm">Switch</button>';
		expect(() => expectNoRawTokens("planted", host, mmManaged())).toThrowError(
			/ecm-ncm/,
		);
	});

	it("a token that survives ONLY in a marked diagnostics block passes", () => {
		const host = document.createElement("div");
		host.innerHTML =
			'<div data-testid="modem-raw-diagnostics"><dd>ecm-ncm</dd></div>';
		expect(() => expectNoRawTokens("marked", host, mmManaged())).not.toThrow();
		expect(diagnosticsText(host)).toContain("ecm-ncm");
	});
});

describe("CellularSection — every family renders no raw token", () => {
	it.each(ALL_FAMILIES.map((family) => [family.id, family] as const))(
		"Given %s, When the row renders, Then no machine identifier reaches operator copy",
		(id, family) => {
			const { container } = renderRow(family.modem);
			expectNoRawTokens(`row ${id}`, container, family.modem);
		},
	);
});

describe("ModemConfigDialog — every directly-managed family renders no raw token", () => {
	it.each(MM_FAMILIES.map((family) => [family.id, family] as const))(
		"Given %s, When the dialog renders, Then no machine identifier reaches operator copy",
		async (id, family) => {
			publishModems({ "0": family.modem });
			render(ModemConfigDialog, {
				props: { open: true, modem: family.modem, deviceId: "0" },
			});
			await vi.waitFor(() =>
				expect(document.querySelector("[data-testid]")).not.toBeNull(),
			);
			expectNoRawTokens(`dialog ${id}`, document.body, family.modem);
		},
	);
});

describe("RouterDongleDialog — every dongle family renders no raw token", () => {
	it.each(ROUTER_FAMILIES.map((family) => [family.id, family] as const))(
		"Given %s, When the dialog renders, Then no machine identifier reaches operator copy",
		async (id, family) => {
			publishModems({ "0": family.modem });
			render(RouterDongleDialog, {
				props: { open: true, modem: family.modem, deviceId: "0" },
			});
			await vi.waitFor(() =>
				expect(document.querySelector("[data-testid]")).not.toBeNull(),
			);
			expectNoRawTokens(`dongle ${id}`, document.body, family.modem);
		},
	);
});

/**
 * OL-3 is a RELOCATION rule, so a clean operator surface is only half of it: the
 * value has to still be on screen, verbatim, one disclosure away. Without this
 * the whole gate above is satisfiable by deleting the field.
 */
describe("the tokens are RELOCATED, not deleted", () => {
	it("keeps the live USB composition in the dialog's marked diagnostics", async () => {
		const modem = mmManaged();
		publishModems({ "0": modem });
		render(ModemConfigDialog, {
			props: { open: true, modem, deviceId: "0" },
		});
		await vi.waitFor(() =>
			expect(
				document.querySelector('[data-testid="modem-raw-diagnostics"]'),
			).not.toBeNull(),
		);
		expect(diagnosticsText(document.body)).toContain("ecm-ncm");
	});

	it("keeps the dongle's own band spelling in the row's marked diagnostics", () => {
		const modem = routerDongle();
		const { container } = renderRow(modem);
		expect(diagnosticsText(container).toUpperCase()).toContain("LTE_BAND_3");
	});

	it("keeps the firmware's unnamed network-mode id in the row's marked diagnostics", () => {
		const modem = routerDongle();
		const { container } = renderRow(modem);
		expect(diagnosticsText(container)).toContain("lte-only");
	});
});

/**
 * A locale-independence control. Every assertion above is a NEGATIVE, so a
 * catalog that failed to load would render dotted keys and pass the sweep
 * trivially — this proves the copy is genuinely resolved.
 */
describe("the copy behind the keys is really loaded", () => {
	it("renders resolved sentences, never dotted message keys", () => {
		const { container } = renderRow(mmManaged());
		const text = container.textContent ?? "";
		expect(text).toContain(m["network.view.cellular"]());
		expect(text).not.toMatch(/network\.(?:modem|cellular)\.[a-z]/i);
	});
});
