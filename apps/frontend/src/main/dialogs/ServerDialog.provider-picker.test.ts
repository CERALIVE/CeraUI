// @vitest-environment jsdom
/**
 * ServerDialog — multi-cloud provider picker (T12, CeraUI N2/N4).
 *
 * The managed destination presents the cloud PROVIDERS the relay catalog offers
 * as a selectable list (CeraLive, BELABOX, + any future cloud) rather than a
 * hardcoded pair. The picker is select-not-fill and auto-selects when exactly one
 * provider is offered. Custom/self-hosted is the always-available escape hatch via
 * the destination radiogroup (never this picker). T8 pairing gates the managed
 * surface; the per-provider list is derived from the catalog the paired cloud(s)
 * pushed (`availableManagedProviders`).
 *
 * Coverage:
 *  1. single managed provider → picker NOT rendered (auto-selected); managed usable.
 *  2. multiple providers → picker rendered and lists every offered provider.
 *  3. BELABOX-paired (catalog tagged belabox only) → managed surface shows the
 *     BELABOX servers, picker auto-selected (single).
 *  4. NOT paired to a given cloud (no belabox servers) → belabox absent; the
 *     single offered provider auto-selects and the picker stays hidden.
 *  5. unpaired → managed destination disabled, only custom/self-hosted reachable.
 */
import { existingLocales, loadLocale } from "@ceraui/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ServerDialog from "./ServerDialog.svelte";

type ServerInfo = {
	name: string;
	rtt?: number;
	default?: true;
	addr?: string;
	port?: number;
	protocol?: string;
	protocols?: string[];
	provider?: { id: string; name: string; kind: string };
};

const state = vi.hoisted(() => ({
	config: undefined as
		| { relay_server?: string; remote_provider?: string }
		| undefined,
	relays: undefined as
		| {
				accounts: Record<string, { name: string }>;
				servers: Record<string, ServerInfo>;
		  }
		| undefined,
	isStreaming: false,
	capabilities: undefined as { transports?: string[] } | undefined,
	paired: true,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
	getIsStreaming: () => state.isStreaming,
	getCapabilities: () => state.capabilities,
	getManagedIngestAccounts: () => [],
	getSelectedIngestEndpoint: () => undefined,
}));

vi.mock("$lib/stores/pairing.svelte", () => ({
	isPairedToManagedCloud: () => state.paired,
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

const CERALIVE = { id: "ceralive", name: "CeraLive Cloud", kind: "ceralive" };
const BELABOX = { id: "belabox", name: "BELABOX Cloud", kind: "belabox" };

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
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

const managedChoice = () =>
	screen.getByTestId("destination-managed") as HTMLButtonElement;
const customChoice = () =>
	screen.getByTestId("destination-custom") as HTMLButtonElement;

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
	state.paired = true;
});

describe("ServerDialog — multi-cloud provider picker (T12)", () => {
	it("auto-selects a single managed provider and renders no picker", async () => {
		state.relays = {
			accounts: {},
			servers: {
				eu: { name: "EU-West", provider: CERALIVE },
				us: { name: "US-East", provider: CERALIVE },
			},
		};
		state.config = { remote_provider: "ceralive", relay_server: "eu" };

		render(ServerDialog, { props: { open: true } });

		// Managed is usable; the provider picker is absent (one provider → auto).
		expect(managedChoice().disabled).toBe(false);
		expect(screen.queryByTestId("relay-provider")).toBeNull();
	});

	it("renders the picker listing every provider for a multi-cloud catalog", async () => {
		state.relays = {
			accounts: {},
			servers: {
				eu: { name: "EU-West", provider: CERALIVE },
				asia: { name: "Asia-SE", provider: BELABOX },
			},
		};
		state.config = { remote_provider: "ceralive", relay_server: "eu" };

		render(ServerDialog, { props: { open: true } });

		const picker = screen.getByTestId("relay-provider");
		expect(picker).toBeTruthy();
		// The configured provider is the active selection.
		expect(picker.textContent).toContain("CeraLive Cloud");

		// Opening the picker lists both offered providers.
		await fireEvent.pointerDown(picker);
		await fireEvent.pointerUp(picker);
		await fireEvent.click(picker);
		await waitFor(() =>
			expect(screen.getAllByText("BELABOX Cloud").length).toBeGreaterThan(0),
		);
	});

	it("shows the BELABOX managed surface when paired to BELABOX only", () => {
		state.relays = {
			accounts: {},
			servers: {
				asia: { name: "Asia-SE", provider: BELABOX },
				west: { name: "US-West", provider: BELABOX },
			},
		};
		state.config = { remote_provider: "belabox", relay_server: "asia" };

		render(ServerDialog, { props: { open: true } });

		// Managed enabled; single belabox provider → no picker, server surfaced.
		expect(managedChoice().disabled).toBe(false);
		expect(screen.queryByTestId("relay-provider")).toBeNull();
		expect(screen.getAllByText("Asia-SE").length).toBeGreaterThan(0);
	});

	it("hides a managed cloud the catalog carries no servers for", () => {
		// Catalog has only CeraLive servers → BELABOX is not offered at all, and
		// the single remaining provider auto-selects (no picker).
		state.relays = {
			accounts: {},
			servers: { eu: { name: "EU-West", provider: CERALIVE } },
		};
		state.config = { remote_provider: "ceralive", relay_server: "eu" };

		render(ServerDialog, { props: { open: true } });

		expect(screen.queryByTestId("relay-provider")).toBeNull();
		expect(screen.queryByText("BELABOX Cloud")).toBeNull();
	});

	it("offers only custom/self-hosted when the device is not paired to a managed cloud", () => {
		state.paired = false;
		state.relays = {
			accounts: {},
			servers: { eu: { name: "EU-West", provider: CERALIVE } },
		};

		render(ServerDialog, { props: { open: true } });

		// Managed is gated off by the pairing gate; custom stays reachable.
		expect(managedChoice().disabled).toBe(true);
		expect(customChoice().disabled).toBe(false);
	});
});

describe("i18n — relayProviderHint in all 10 locales", () => {
	it("has all 10 locales registered", () => {
		expect(existingLocales).toHaveLength(10);
	});

	for (const { code } of existingLocales) {
		it(`provides settings.relayProviderHint for "${code}"`, async () => {
			const translation = (await loadLocale(code)) as {
				settings: { relayProviderHint: string };
			};
			expect(typeof translation.settings.relayProviderHint).toBe("string");
			expect(translation.settings.relayProviderHint.length).toBeGreaterThan(0);
		});
	}
});
