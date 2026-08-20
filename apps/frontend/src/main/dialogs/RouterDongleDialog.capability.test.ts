// @vitest-environment jsdom
/**
 * RouterDongleDialog — the network-mode capability, DISCOVERED and read-only
 * (todo 22, STAGE A).
 *
 * The backend probes the firmware's own `net-mode-list` catalog before this
 * dialog renders anything, and publishes the result as
 * `router_admin.capabilities`. The gate here is that the surface stays HONEST in
 * both directions: a firmware that advertised a catalog shows it, a firmware
 * that REFUSED shows the refusal in its own words — and NEITHER gets a control,
 * because this build performs no network-mode write for any firmware. A control
 * that fails on click is exactly the thing this whole surface exists to refuse.
 *
 * The `112008` refusal is the bench measurement (`.omo/notepads/
 * modem-stack-phase-b/learnings.md`, todo 56's write-probe table).
 */
import { m } from "@ceraui/i18n/svelte";
import type { Modem, RouterAdminCapabilities } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import RouterDongleDialog from "./RouterDongleDialog.svelte";

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { setRouterControl: vi.fn() } },
}));

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

const REPORTED: RouterAdminCapabilities = {
	net_mode: {
		state: "reported",
		modes: [
			{ id: "00", name: "AUTO" },
			{ id: "01", name: "2G ONLY" },
			{ id: "03", name: "LTE ONLY" },
		],
		current: "03",
	},
};

/** The bench unit's own answer: it declines to discuss its network modes. */
const REFUSED: RouterAdminCapabilities = {
	net_mode: { state: "unavailable", reason: "refused", code: "112008" },
};

function open(capabilities?: RouterAdminCapabilities): void {
	const modem = {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			...(capabilities === undefined ? {} : { capabilities }),
		},
	} as unknown as Modem;
	render(RouterDongleDialog, {
		props: { open: true, deviceId: "router-1", modem },
	});
}

const block = (): Element | null =>
	document.querySelector('[data-testid="dongle-net-mode"]');

const chip = (id: string): HTMLElement | null =>
	document.querySelector(`[data-testid="dongle-net-mode-${id}"]`);

describe("RouterDongleDialog — the discovered network-mode capability", () => {
	it("renders every mode the firmware advertised, and marks the one in use", () => {
		open(REPORTED);

		expect(block()).not.toBeNull();
		expect(chip("00")?.textContent?.trim()).toContain("AUTO");
		expect(chip("01")?.textContent?.trim()).toContain("2G ONLY");
		expect(chip("03")?.dataset.current).toBe("true");
		expect(chip("00")?.dataset.current).toBeUndefined();
	});

	it("marks the current mode with a WORD, never colour alone", () => {
		open(REPORTED);

		// Colour is reinforcement; the state has to survive a monochrome display.
		expect(chip("03")?.textContent).toContain(
			m["network.routerCellular.netMode.current"](),
		);
	});

	it("renders a 112008 refusal as the firmware's own refusal", () => {
		open(REFUSED);

		const reason = document.querySelector(
			'[data-testid="dongle-net-mode-reason"]',
		);
		expect(reason?.textContent?.trim()).toBe(
			m["network.routerCellular.netMode.refused"]({ code: "112008" }),
		);
		expect(reason?.textContent).toContain("112008");
		expect(
			document.querySelector('[data-testid="dongle-net-mode-list"]'),
		).toBeNull();
	});

	it("offers NO control for a refusal — not even a disabled one", () => {
		// The Stage-A invariant that SURVIVES Stage B: a firmware that declined to
		// name its catalog is never handed a chip that fails on click.
		open(REFUSED);

		const section = block();
		expect(section).not.toBeNull();
		expect(section?.querySelectorAll("button")).toHaveLength(0);
		expect(section?.querySelectorAll("input")).toHaveLength(0);
		expect(section?.querySelectorAll("select")).toHaveLength(0);
		expect(section?.querySelectorAll('[role="switch"]')).toHaveLength(0);
	});

	it("offers a control for a REPORTED catalog — Stage B writes into one", () => {
		open(REPORTED);

		const section = block();
		// The gate is the capability reading, not a firmware allowlist: this
		// firmware named its own catalog, so the chips are the write surface.
		const chips = section?.querySelectorAll("button") ?? [];
		expect(chips.length).toBeGreaterThan(0);
		// …and nothing else was smuggled in beside them.
		expect(section?.querySelectorAll("input")).toHaveLength(0);
		expect(section?.querySelectorAll("select")).toHaveLength(0);
	});

	it("never offers the mode the device is ALREADY on as an action", () => {
		open(REPORTED);

		const current = document.querySelector<HTMLButtonElement>(
			'[data-testid="dongle-net-mode-03"]',
		);
		expect(current?.dataset.current).toBe("true");
		// A control for the state you are already in is a no-op dressed as a
		// choice — the same rule the live source row follows.
		expect(current?.disabled).toBe(true);
	});

	it("says on screen that this firmware accepts a change", () => {
		open(REPORTED);

		expect(block()?.textContent).toContain(
			m["network.routerCellular.netMode.selectNote"](),
		);
	});

	it("…and says the opposite for a firmware that refused the question", () => {
		open(REFUSED);

		expect(block()?.textContent).toContain(
			m["network.routerCellular.netMode.readOnlyNote"](),
		);
		expect(block()?.textContent).not.toContain(
			m["network.routerCellular.netMode.selectNote"](),
		);
	});

	it("renders no capability surface at all when nothing was discovered", () => {
		open();

		expect(block()).toBeNull();
		expect(
			document.querySelector('[data-testid="dongle-identity"]'),
		).not.toBeNull();
	});

	it("labels the surface with real copy, never a dotted key", () => {
		open(REPORTED);

		expect(document.body.textContent ?? "").not.toMatch(
			/network\.routerCellular\./,
		);
		expect(block()?.textContent).toContain(
			m["network.routerCellular.netMode.title"](),
		);
	});

	it("reports every non-refusal reason in the signal strip's own words", () => {
		const cases = [
			["auth-expired", "network.routerCellular.signal.reason.authExpired"],
			["not-reported", "network.routerCellular.signal.reason.notReported"],
			["malformed", "network.routerCellular.signal.reason.malformed"],
			["unreachable", "network.routerCellular.signal.reason.unreachable"],
		] as const;

		for (const [reason, key] of cases) {
			document.body.innerHTML = "";
			open({ net_mode: { state: "unavailable", reason } });

			expect(
				document
					.querySelector('[data-testid="dongle-net-mode-reason"]')
					?.textContent?.trim(),
			).toBe(m[key]());
		}
	});
});
