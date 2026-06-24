// @vitest-environment jsdom
/**
 * ServerDialog — device-actionable relay/provider staleness (T18).
 *
 * Two of the three T18 fixes surface inside the managed destination:
 *  • Fix 3 — a relay_server saved under a PREVIOUS provider (the operator switched
 *    cloud in CloudRemoteDialog without re-selecting) is otherwise invisible. The
 *    managed branch now renders a `relay-stale-warning` band when the saved server
 *    belongs to a different provider than the active one.
 *  • Fix 2 — toggling the manual endpoint override on a bound managed server drops
 *    the relay_server binding on save. The managed branch now renders a
 *    `relay-override-warning` band before save so the operator is not surprised.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ServerDialog from "./ServerDialog.svelte";

type ServerInfo = {
	name: string;
	addr?: string;
	port?: number;
	protocol?: string;
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

const CERALIVE = { id: "ceralive", name: "CeraLive Cloud", kind: "ceralive" };
const BELABOX = { id: "belabox", name: "BELABOX Cloud", kind: "belabox" };

const STALE_WARNING =
	"Your saved relay server belongs to a different provider. Re-select a server for this provider.";
const OVERRIDE_WARNING =
	"Saving this manual endpoint will replace your managed relay server binding.";

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

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
});

describe("ServerDialog — Fix 3: provider-switch staleness is visible", () => {
	it("warns when the saved relay_server belongs to a different provider", () => {
		// Saved server `asia` is a BELABOX relay, but the device now reports the
		// CeraLive provider — the classic post-provider-switch stale binding.
		state.relays = {
			accounts: {},
			servers: {
				eu: { name: "EU-West", provider: CERALIVE },
				asia: { name: "Asia-SE", provider: BELABOX },
			},
		};
		state.config = { remote_provider: "ceralive", relay_server: "asia" };

		render(ServerDialog, { props: { open: true } });

		expect(screen.getByTestId("relay-stale-warning")).toBeTruthy();
		expect(screen.getByText(STALE_WARNING)).toBeTruthy();
	});

	it("does NOT warn when the saved relay_server matches the active provider", () => {
		state.relays = {
			accounts: {},
			servers: {
				eu: { name: "EU-West", provider: CERALIVE },
				asia: { name: "Asia-SE", provider: BELABOX },
			},
		};
		state.config = { remote_provider: "ceralive", relay_server: "eu" };

		render(ServerDialog, { props: { open: true } });

		expect(screen.queryByTestId("relay-stale-warning")).toBeNull();
	});

	it("does NOT warn while the relay catalog is still loading", () => {
		// relays === undefined ⇒ catalog not arrived; never flag a saved server as
		// gone before the list loads.
		state.relays = undefined;
		state.config = { remote_provider: "ceralive", relay_server: "asia" };

		render(ServerDialog, { props: { open: true } });

		expect(screen.queryByTestId("relay-stale-warning")).toBeNull();
	});
});

describe("ServerDialog — Fix 2: override-clears-binding warning before save", () => {
	it("surfaces the warning only after the manual override is toggled on", async () => {
		state.relays = {
			accounts: {},
			servers: { eu: { name: "EU-West", provider: CERALIVE } },
		};
		state.config = { remote_provider: "ceralive", relay_server: "eu" };

		render(ServerDialog, { props: { open: true } });

		// No override yet — the managed binding is intact, so no warning.
		expect(screen.queryByTestId("relay-override-warning")).toBeNull();

		const toggle = document.getElementById("relay-manual-override");
		expect(toggle).not.toBeNull();
		await fireEvent.click(toggle as HTMLElement);

		await waitFor(() =>
			expect(screen.getByTestId("relay-override-warning")).toBeTruthy(),
		);
		expect(screen.getByText(OVERRIDE_WARNING)).toBeTruthy();
	});
});
