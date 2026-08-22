// @vitest-environment jsdom
/**
 * The hotspot dialog's capability-driven options, asserted against the RENDERED
 * DOM because each one is a claim made to an operator.
 *
 * Four properties carry this surface:
 *
 *   1. A security SELECTOR exists only when the device offered two or more
 *      modes. One offered mode is STATED — a single-item control cannot change
 *      anything, and the shipped fleet is WPA2-only because NM 1.42 publishes no
 *      SAE key at all.
 *   2. A mode the device did not offer contributes ZERO nodes (`DESIGN.md` CT-1
 *      / CT-4). Not a disabled row, which would claim a capability is being
 *      withheld when the radio simply lacks it.
 *   3. The width line is READ-ONLY — there is no width control of any kind,
 *      asserted by inspecting every interactive element in the block rather than
 *      by grepping the markup, because absence has no syntax of its own.
 *   4. THE REGRESSION LOCK: a device that reported neither renders exactly the
 *      name/password/channel dialog it rendered before todo 8 — proven by a DOM
 *      comparison, not by spot-checking testids.
 */
import type { HotspotConfig, WifiInterface } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import HotspotDialog from "./HotspotDialog.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(async () => ({ success: true })),
		},
	},
	// `osCommand` pulls the connection-ux store, which subscribes to the client.
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: () => "connected",
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("qrcode", () => ({
	default: { toDataURL: vi.fn(async () => "data:image/png;base64,MOCKQR") },
}));

const WPA2_ONLY: HotspotConfig["available_security"] = {
	wpa2: { name: "WPA2 (Personal)" },
};
const BOTH: HotspotConfig["available_security"] = {
	wpa2: { name: "WPA2 (Personal)" },
	"wpa3-sae": { name: "WPA3 (SAE)" },
};

function iface(hotspot: Partial<HotspotConfig> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		hotspot: {
			name: "CERALIVE_791c",
			password: "correcthorse",
			available_channels: { auto: { name: "Automatic" } },
			channel: "auto",
			...hotspot,
		},
	};
}

function mount(target?: WifiInterface) {
	return render(HotspotDialog, {
		props: { open: true, deviceId: "0", iface: target },
	});
}

/**
 * bits-ui renders Dialog.Content into a PORTAL on document.body, so the render
 * container is empty — every query here must go through the live dialog element.
 */
function dialog(): HTMLElement {
	const el = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!el) throw new Error("dialog content did not render");
	return el;
}

// AppDialog picks Dialog vs Sheet via `new MediaQuery(...)` → window.matchMedia,
// absent in jsdom. Stub it to the desktop (Dialog) branch.
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
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
	vi.clearAllMocks();
});

describe("security — offered by the device, never by a local table", () => {
	it("renders a real selector when TWO modes were offered", () => {
		mount(iface({ available_security: BOTH }));
		expect(
			dialog().querySelector('[data-testid="hotspot-security-select"]'),
		).not.toBeNull();
		expect(
			dialog().querySelector('[data-testid="hotspot-security-stated"]'),
		).toBeNull();
	});

	it("STATES the mode when only ONE was offered, with no control", () => {
		mount(iface({ available_security: WPA2_ONLY }));
		const stated = dialog().querySelector(
			'[data-testid="hotspot-security-stated"]',
		);
		expect(stated).not.toBeNull();
		expect(stated?.textContent).toContain("WPA2 (Personal)");
		expect(
			dialog().querySelector('[data-testid="hotspot-security-select"]'),
		).toBeNull();
		// One option is not a choice: the stated form carries no interactive node.
		expect(stated?.querySelectorAll("button, input, select")).toHaveLength(0);
	});

	// CT-1 / CT-4: an unoffered mode is not a disabled row, it is no row.
	it("emits NO WPA3 node at all for a radio that did not prove SAE", () => {
		mount(iface({ available_security: WPA2_ONLY }));
		expect(dialog().textContent).not.toContain("WPA3");
		expect(
			dialog().querySelector(
				'[data-testid="hotspot-security-option-wpa3-sae"]',
			),
		).toBeNull();
	});

	it("renders nothing at all when the device reported no offering", () => {
		mount(iface());
		expect(
			dialog().querySelector('[data-testid="hotspot-security-select"]'),
		).toBeNull();
		expect(
			dialog().querySelector('[data-testid="hotspot-security-stated"]'),
		).toBeNull();
	});
});

describe("radio truth — stated, never settable", () => {
	it("states the width per hotspot band", () => {
		mount(iface({ max_width_mhz: { "2.4": 40, "5": 80 } }));
		const block = dialog().querySelector('[data-testid="hotspot-radio-truth"]');
		expect(block).not.toBeNull();
		expect(
			dialog().querySelector('[data-testid="hotspot-radio-width-2.4"]')
				?.textContent,
		).toContain("40");
		expect(
			dialog().querySelector('[data-testid="hotspot-radio-width-5"]')
				?.textContent,
		).toContain("80");
	});

	it("carries the generation when the device reported a capability block", () => {
		render(HotspotDialog, {
			props: {
				open: true,
				deviceId: "0",
				iface: {
					...iface({ max_width_mhz: { "5": 80 } }),
					capabilities: {
						phy: "phy0",
						generation: "wifi6",
						bands: ["2.4", "5"],
						maxWidthMhz: { "2.4": 40, "5": 80 },
						apModes: ["2.4", "5"],
						staApCombo: { supported: true, sameChannelOnly: true },
						wpa3Sae: "unknown",
						regulatory: {
							country: "ES",
							is6GhzLegal: false,
							self_managed: false,
						},
					},
				},
			},
		});
		expect(
			dialog().querySelector('[data-testid="hotspot-radio-generation"]')
				?.textContent,
		).toContain("Wi-Fi 6");
	});

	// NetworkManager 1.42 publishes no hotspot channel-width property, so a
	// control here could not act. Measured against the rendered block rather
	// than the markup — an absent control has no syntax to grep for.
	it("offers NO width control of any kind", () => {
		mount(iface({ max_width_mhz: { "2.4": 40, "5": 80 } }));
		const block = dialog().querySelector('[data-testid="hotspot-radio-truth"]');
		expect(block).not.toBeNull();
		expect(
			block?.querySelectorAll(
				"button, input, select, textarea, [role='combobox'], [role='radiogroup'], [role='switch']",
			),
		).toHaveLength(0);
	});

	it("renders nothing when neither a width nor a generation was reported", () => {
		mount(iface());
		expect(
			dialog().querySelector('[data-testid="hotspot-radio-truth"]'),
		).toBeNull();
	});
});

/*
  THE REGRESSION LOCK.

  `available_security` / `max_width_mhz` / `capabilities` are all optional on the
  wire and absent on every backend that predates todo 8, so a device without them
  must render EXACTLY the dialog it rendered before — no selector, no width line,
  no "unavailable" placeholder. Compared as normalized DOM rather than by
  spot-checking a few testids, because the claim is about the WHOLE surface.

  bits-ui mints element ids from a module-global counter (`bits-c81` vs
  `bits-c85`), so two renders in one file never agree verbatim — that counter is
  normalized and NOTHING else, or the lock stops locking.
*/
describe("regression lock — a pre-todo-8 device is byte-identical", () => {
	const normalize = (html: string) => html.replace(/bits-c\d+/g, "bits-cN");

	it("renders the same DOM as a capability-bearing device minus the new blocks", () => {
		const legacy = mount(iface());
		const legacyHtml = normalize(dialog().innerHTML);
		legacy.unmount();

		mount(iface({ available_security: BOTH, max_width_mhz: { "2.4": 40 } }));
		const capable = dialog();
		for (const testid of ["hotspot-security-select", "hotspot-radio-truth"]) {
			capable.querySelector(`[data-testid="${testid}"]`)?.remove();
		}
		expect(normalize(capable.innerHTML)).toBe(legacyHtml);
	});

	it("still renders the name, password and channel controls", () => {
		mount(iface());
		expect(dialog().querySelector("#hotspot-name")).not.toBeNull();
		expect(dialog().querySelector("#hotspot-password")).not.toBeNull();
		expect(dialog().querySelector("#hotspot-channel")).not.toBeNull();
		expect(dialog().querySelector("#hotspot-security")).toBeNull();
	});
});
