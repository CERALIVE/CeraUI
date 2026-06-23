// @vitest-environment jsdom
/**
 * ServerDialog — relay availability gate (decision D6), destination-first.
 *
 * The destination-first rewrite (T9) replaces the old manual/relay tabs with the
 * DestinationSection radiogroup (T6): `destination-managed` (the cloud relay) and
 * `destination-custom` (a self-entered receiver). The D6 gate now lives on the
 * managed CHOICE: it is ALWAYS rendered, but DISABLED with an i18n hint while the
 * relay catalog is missing (`getRelays() === undefined` → `relayWaiting`) or while
 * it arrived empty (`relayNone`). Custom is the always-available fallback in either
 * state. The streaming lock (`disabled = … || isStreaming`) is preserved.
 *
 * A user whose saved `config.relay_server` is set but whose relays have not yet
 * arrived must NOT be silently dropped to custom: the managed choice stays SELECTED
 * (destination intent preserved via `deriveDestination`) and surfaces the waiting
 * hint instead.
 *
 * Coverage (ported from the old Task 11 / Task 19 suites onto T6 testids):
 *  1. relays === undefined → managed DISABLED + waiting hint; custom ENABLED.
 *  2. relays with servers → managed ENABLED + selected, no hint, server name
 *     surfaced and entries listed in the catalog.
 *  3. Custom always usable in BOTH states (its inputs mount when selected).
 *  4. config.relay_server set + relays undefined → managed stays SELECTED (not
 *     switched to custom) and shows the waiting hint.
 *  5. Empty catalog → relayNone hint (distinct from the undefined→relayWaiting).
 *  6. RTT-indicator tiers (`data-rtt-tier`) in the trigger and per catalog entry.
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
	getManagedIngestAccounts: () => [],
	getSelectedIngestEndpoint: () => undefined,
}));

// D6 here is the relays gate; a populated catalog only exists for a paired
// managed device, so pairing is held true. The pairing gate is tested in
// pairing.svelte.test.ts.
vi.mock("$lib/stores/pairing.svelte", () => ({
	isPairedToManagedCloud: () => true,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig: vi.fn() }, relay: { validate: vi.fn() } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending: vi.fn(),
	onRpcResolved: vi.fn(),
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
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
	// bits-ui Select drives its trigger through Pointer Events + scrollIntoView,
	// none of which jsdom implements — stub them so the catalog can open.
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

// English base copy (the runes i18n adapter defaults to `en` synchronously).
const WAITING_HINT = "Waiting for relay servers\u2026";
const NONE_HINT = "No relay servers available";

const managedChoice = () =>
	screen.getByTestId("destination-managed") as HTMLButtonElement;
const customChoice = () =>
	screen.getByTestId("destination-custom") as HTMLButtonElement;

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
});

describe("ServerDialog — relay availability gate (D6, destination-first)", () => {
	it("renders the managed choice DISABLED with a waiting hint when relays are absent", () => {
		state.relays = undefined;

		render(ServerDialog, { props: { open: true } });

		// Managed is visible but gated off (never hidden — D6).
		expect(managedChoice()).toBeTruthy();
		expect(managedChoice().disabled).toBe(true);

		// The i18n hint explains why it is gated.
		expect(screen.getByText(WAITING_HINT)).toBeTruthy();

		// Custom stays available as the fallback.
		expect(customChoice().disabled).toBe(false);
	});

	it("enables the managed choice and lists server entries once relays arrive", async () => {
		state.relays = {
			accounts: {},
			servers: {
				"srv-eu": { name: "EU West", default: true },
				"srv-us": { name: "US East" },
			},
		};
		state.config = { relay_server: "srv-eu" };

		render(ServerDialog, { props: { open: true } });

		// Managed is now usable and selected (config intent → managed destination).
		expect(managedChoice().disabled).toBe(false);
		expect(managedChoice().getAttribute("aria-checked")).toBe("true");

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

	it("keeps custom usable whether or not relays are present", async () => {
		// State A: no relays — custom must still be reachable.
		const a = render(ServerDialog, { props: { open: true } });
		expect(customChoice().disabled).toBe(false);
		await fireEvent.click(customChoice());
		expect(document.getElementById("srtla-addr")).not.toBeNull();
		a.unmount();

		// State B: relays present — custom remains an explicit fallback.
		state.relays = { accounts: {}, servers: { "srv-eu": { name: "EU West" } } };
		render(ServerDialog, { props: { open: true } });
		expect(customChoice().disabled).toBe(false);
		await fireEvent.click(customChoice());
		expect(document.getElementById("srtla-addr")).not.toBeNull();
	});

	it("does not silently switch a relay-configured user to custom while relays load", () => {
		// Saved intent is managed, but the catalog has not arrived yet.
		state.config = { relay_server: "srv-eu" };
		state.relays = undefined;

		render(ServerDialog, { props: { open: true } });

		// Destination intent preserved: managed is selected, not custom…
		expect(managedChoice().getAttribute("aria-checked")).toBe("true");
		expect(customChoice().getAttribute("aria-checked")).toBe("false");
		// …but it is gated with the waiting hint until relays load.
		expect(managedChoice().disabled).toBe(true);
		expect(screen.getByText(WAITING_HINT)).toBeTruthy();
		// Custom is still an available escape hatch.
		expect(customChoice().disabled).toBe(false);
	});
});

/**
 * Empty-catalog and RTT-indicator display, ported from the old Task 19 suite onto
 * the T6 destination testids: the SECOND `managedUnavailable` branch (catalog
 * arrived EMPTY → `relayNone`, distinct from `undefined`→`relayWaiting`), and the
 * RTT-indicator wiring inside the managed selector — the selected server's badge
 * in the trigger and the per-entry badges in the open catalog, each carrying the
 * tier `RelayRttIndicator` derives from its raw `rtt`.
 */
describe("ServerDialog — empty catalog & RTT-indicator display (D6 port)", () => {
	it("shows the relayNone hint (not the waiting hint) when the catalog arrives empty", () => {
		// Defined-but-empty is the second `managedUnavailable` branch: the catalog
		// exists yet lists nothing, so the copy must be "none", never "waiting".
		state.relays = { accounts: {}, servers: {} };

		render(ServerDialog, { props: { open: true } });

		expect(screen.getByText(NONE_HINT)).toBeTruthy();
		expect(screen.queryByText(WAITING_HINT)).toBeNull();

		expect(managedChoice().disabled).toBe(true);
		expect(customChoice().disabled).toBe(false);
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

		// No saved relay_server → destination defaults to custom; switch to the
		// (now enabled) managed choice so the server Select mounts.
		await fireEvent.click(managedChoice());

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
