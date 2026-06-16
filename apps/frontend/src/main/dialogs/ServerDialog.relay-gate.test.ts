// @vitest-environment jsdom
/**
 * ServerDialog — relay availability gate (Task 11 / decision D6).
 *
 * Relay servers exist ONLY when the device's cloud provider has populated its
 * `relays_cache.json`; in mock/dev (and on a fresh boot) `getRelays()` returns
 * `undefined`, so the relay catalog is simply absent. The old UI silently hid
 * the relay option in that window, which read as "the feature displays nothing".
 *
 * D6 settles this: the relay tab is ALWAYS rendered, but it is DISABLED with an
 * i18n hint while `relays === undefined` (`notifications.relayWaiting`) or while
 * the catalog arrived empty (`notifications.relayNone`). Manual SRTLA is the
 * always-available fallback in either state. The existing streaming lock
 * (`disabled = … || isStreaming`) is preserved.
 *
 * A user whose saved `config.relay_server` is set but whose relays have not yet
 * arrived must NOT be silently dropped to manual: the relay tab stays selected
 * (mode intent preserved) and surfaces the waiting hint instead.
 *
 * Coverage:
 *  1. relays === undefined → relay tab present + DISABLED + waiting hint; manual
 *     tab present + ENABLED (fallback intact).
 *  2. relays with servers → relay tab ENABLED, no hint, selected server name
 *     surfaced and entries listed in the catalog.
 *  3. Manual SRTLA usable in BOTH states (its inputs mount when selected).
 *  4. config.relay_server set + relays undefined → relay tab stays SELECTED
 *     (not switched to manual) and shows the waiting hint.
 */
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ServerDialog from "./ServerDialog.svelte";

// Mutable subscription state driven per-test. The dialog reads these through
// the mocked subscriptions module; values are set BEFORE each render so no
// cross-render reactivity is required.
const state = vi.hoisted(() => ({
	config: undefined as
		| { relay_server?: string; srtla_addr?: string; srtla_port?: number }
		| undefined,
	relays: undefined as
		| {
				accounts: Record<string, { name: string }>;
				servers: Record<string, { name: string; rtt?: number; default?: true }>;
		  }
		| undefined,
	isStreaming: false,
	capabilities: undefined as { transports?: string[] } | undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
	getIsStreaming: () => state.isStreaming,
	getCapabilities: () => state.capabilities,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig: vi.fn() } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending: vi.fn(),
	onRpcResolved: vi.fn(),
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// AppDialog picks its surface (Dialog vs Sheet) via `new MediaQuery(...)`, which
// reads `window.matchMedia` — absent in jsdom. Stub it to the desktop branch so
// the dialog renders its Dialog surface (portaled to document.body).
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
	// bits-ui Select drives its trigger through Pointer Events + scrollIntoView,
	// none of which jsdom implements — stub them so the catalog can open.
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

// English base copy (the runes i18n adapter defaults to `en` synchronously).
const MANUAL_LABEL = "Manual Configuration";
const RELAY_LABEL = "Relay Server";
const WAITING_HINT = "Waiting for relay servers\u2026";
const NONE_HINT = "No relay servers available";

const relayTab = () =>
	screen.getByRole("tab", { name: RELAY_LABEL }) as HTMLButtonElement;
const manualTab = () =>
	screen.getByRole("tab", { name: MANUAL_LABEL }) as HTMLButtonElement;

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
});

describe("ServerDialog — relay availability gate (Task 11 / D6)", () => {
	it("renders the relay tab DISABLED with a waiting hint when relays are absent", async () => {
		state.relays = undefined;

		render(ServerDialog, { props: { open: true } });

		// Relay tab is visible but gated off (never hidden — D6).
		expect(relayTab()).toBeTruthy();
		expect(relayTab().disabled).toBe(true);

		// The i18n hint explains why it is gated.
		expect(screen.getByText(WAITING_HINT)).toBeTruthy();

		// Manual SRTLA stays available as the fallback.
		expect(manualTab().disabled).toBe(false);
	});

	it("enables the relay tab and lists server entries once relays arrive", async () => {
		state.relays = {
			accounts: {},
			servers: {
				"srv-eu": { name: "EU West", default: true },
				"srv-us": { name: "US East" },
			},
		};
		state.config = { relay_server: "srv-eu" };

		render(ServerDialog, { props: { open: true } });

		// Relay tab is now usable and selected (config intent → relay mode).
		expect(relayTab().disabled).toBe(false);
		expect(relayTab().getAttribute("aria-selected")).toBe("true");

		// No empty-state hint while a populated catalog exists.
		expect(screen.queryByText(WAITING_HINT)).toBeNull();
		expect(screen.queryByText(NONE_HINT)).toBeNull();

		// The selected server name is surfaced (the servers map is consumed).
		expect(screen.getAllByText("EU West").length).toBeGreaterThan(0);

		// Opening the catalog lists the other server entry too.
		const trigger = document.getElementById("relay-server");
		expect(trigger).not.toBeNull();
		await fireEvent.pointerDown(trigger as HTMLElement);
		await fireEvent.pointerUp(trigger as HTMLElement);
		await fireEvent.click(trigger as HTMLElement);
		await waitFor(() =>
			expect(screen.getAllByText("US East").length).toBeGreaterThan(0),
		);
	});

	it("keeps manual SRTLA usable whether or not relays are present", async () => {
		// State A: no relays — manual must still be reachable.
		const a = render(ServerDialog, { props: { open: true } });
		await fireEvent.click(manualTab());
		expect(document.getElementById("srtla-addr")).not.toBeNull();
		a.unmount();

		// State B: relays present — manual remains an explicit fallback.
		state.relays = { accounts: {}, servers: { "srv-eu": { name: "EU West" } } };
		render(ServerDialog, { props: { open: true } });
		expect(manualTab().disabled).toBe(false);
		await fireEvent.click(manualTab());
		expect(document.getElementById("srtla-addr")).not.toBeNull();
	});

	it("does not silently switch a relay-configured user to manual while relays load", async () => {
		// Saved intent is relay, but the catalog has not arrived yet.
		state.config = { relay_server: "srv-eu" };
		state.relays = undefined;

		render(ServerDialog, { props: { open: true } });

		// Mode intent preserved: relay tab is the selected one, not manual…
		expect(relayTab().getAttribute("aria-selected")).toBe("true");
		expect(manualTab().getAttribute("aria-selected")).toBe("false");
		// …but it is gated with the waiting hint until relays load.
		expect(relayTab().disabled).toBe(true);
		expect(screen.getByText(WAITING_HINT)).toBeTruthy();
		// Manual is still an available escape hatch.
		expect(manualTab().disabled).toBe(false);
	});
});

/**
 * Task 19 — extends the Task 11 gate suite with the conditional-display cases it
 * does not reach: the SECOND `relayUnavailable` branch (catalog arrived EMPTY →
 * `relayNone`, distinct from the `undefined`→`relayWaiting` branch above), and
 * the RTT-indicator wiring inside the dialog — the selected server's badge in
 * the trigger and the per-entry badges in the open catalog, each carrying the
 * tier `RelayRttIndicator` derives from its raw `rtt`.
 */
describe("ServerDialog — empty catalog & RTT-indicator display (Task 19)", () => {
	it("shows the relayNone hint (not the waiting hint) when the catalog arrives empty", () => {
		// Defined-but-empty is the second `relayUnavailable` branch: the catalog
		// exists yet lists nothing, so the copy must be "none", never "waiting".
		state.relays = { accounts: {}, servers: {} };

		render(ServerDialog, { props: { open: true } });

		expect(screen.getByText(NONE_HINT)).toBeTruthy();
		expect(screen.queryByText(WAITING_HINT)).toBeNull();

		expect(manualTab().disabled).toBe(false);
	});

	it("surfaces the selected server's RTT badge with the correct tier in the trigger", () => {
		state.relays = {
			accounts: {},
			servers: { "srv-eu": { name: "EU West", rtt: 42, default: true } },
		};
		state.config = { relay_server: "srv-eu" };

		render(ServerDialog, { props: { open: true } });

		const trigger = document.getElementById("relay-server");
		expect(trigger).not.toBeNull();
		const badge = within(trigger as HTMLElement).getByLabelText("42 ms");
		expect(badge.getAttribute("data-rtt-tier")).toBe("good");
	});

	it("maps each catalog entry to its RTT tier badge once the dropdown opens", async () => {
		state.relays = {
			accounts: {},
			servers: {
				"srv-eu": { name: "EU West", rtt: 42 },
				"srv-asia": { name: "Asia SE", rtt: 200 },
			},
		};

		render(ServerDialog, { props: { open: true } });

		// No saved relay_server → mode defaults to manual; switch to the (now
		// enabled) relay tab so the server Select mounts.
		await fireEvent.click(relayTab());

		const trigger = document.getElementById("relay-server");
		expect(trigger).not.toBeNull();
		await fireEvent.pointerDown(trigger as HTMLElement);
		await fireEvent.pointerUp(trigger as HTMLElement);
		await fireEvent.click(trigger as HTMLElement);

		await waitFor(() => expect(screen.getByLabelText("200 ms")).toBeTruthy());
		expect(screen.getByLabelText("42 ms").getAttribute("data-rtt-tier")).toBe(
			"good",
		);
		expect(screen.getByLabelText("200 ms").getAttribute("data-rtt-tier")).toBe(
			"weak",
		);
	});
});
