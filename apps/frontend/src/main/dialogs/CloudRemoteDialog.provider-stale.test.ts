// @vitest-environment jsdom
/**
 * CloudRemoteDialog — Fix 1: provider switch leaves a stale relay_server (T18).
 *
 * Switching the cloud provider here does NOT touch the persisted `relay_server`,
 * so the saved server can end up pointing at the PREVIOUS provider's relay. The
 * dialog now surfaces a `relay-provider-stale-warning` band (rather than silently
 * re-binding) so the operator knows to re-open Receiver / Server and re-pick a
 * server for the new provider.
 */
import { render, screen } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import CloudRemoteDialog from "./CloudRemoteDialog.svelte";

type ServerInfo = {
	name: string;
	provider?: { id: string; name: string; kind: string };
};

const state = vi.hoisted(() => ({
	config: undefined as
		| { relay_server?: string; remote_provider?: string }
		| undefined,
	relays: undefined as
		| { accounts: Record<string, never>; servers: Record<string, ServerInfo> }
		| undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			getCloudProviders: vi.fn(async () => ({
				providers: [
					{
						id: "ceralive",
						name: "CeraLive Cloud",
						cloudUrl: "https://ceralive",
					},
					{ id: "belabox", name: "BELABOX Cloud", cloudUrl: "https://belabox" },
				],
				current: { id: "ceralive", name: "CeraLive Cloud" },
			})),
		},
	},
}));

vi.mock("$lib/helpers/SystemHelper", () => ({
	saveRemoteConfig: vi.fn(async () => ({ success: true })),
}));

vi.mock("$lib/pairing/pairing.svelte", () => ({
	PairingController: class {
		code: string | null = null;
		status = "idle";
		expired = false;
		remainingLabel = "";
		startCountdown() {}
		stopCountdown() {}
		reset() {}
		async generate() {}
		async complete() {
			return { paired: false };
		}
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const CERALIVE = { id: "ceralive", name: "CeraLive Cloud", kind: "ceralive" };

const SWITCH_WARNING =
	"Your saved relay server belongs to the previous provider. Open Receiver / Server to pick a server for this provider.";

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
});

describe("CloudRemoteDialog — Fix 1: stale relay_server on provider switch", () => {
	it("warns when the configured provider disagrees with the saved relay_server", () => {
		// Saved server `eu` is a CeraLive relay, but the device now reports the
		// BELABOX provider — the persisted state left after a provider switch.
		state.relays = {
			accounts: {},
			servers: { eu: { name: "EU-West", provider: CERALIVE } },
		};
		state.config = { remote_provider: "belabox", relay_server: "eu" };

		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.getByTestId("relay-provider-stale-warning")).toBeTruthy();
		expect(screen.getByText(SWITCH_WARNING)).toBeTruthy();
	});

	it("does NOT warn while the configured provider still owns the saved server", () => {
		state.relays = {
			accounts: {},
			servers: { eu: { name: "EU-West", provider: CERALIVE } },
		};
		state.config = { remote_provider: "ceralive", relay_server: "eu" };

		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.queryByTestId("relay-provider-stale-warning")).toBeNull();
	});

	it("does NOT warn while the relay catalog is still loading", () => {
		state.relays = undefined;
		state.config = { remote_provider: "belabox", relay_server: "eu" };

		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.queryByTestId("relay-provider-stale-warning")).toBeNull();
	});

	it("clears the warning once the provider is switched back to the saved server's owner", () => {
		// belabox + eu(ceralive) is stale; ceralive + eu is not — the warning is a
		// pure function of the active provider vs. the saved server's owner.
		state.relays = {
			accounts: {},
			servers: { eu: { name: "EU-West", provider: CERALIVE } },
		};

		state.config = { remote_provider: "belabox", relay_server: "eu" };
		const stale = render(CloudRemoteDialog, { props: { open: true } });
		expect(screen.getByTestId("relay-provider-stale-warning")).toBeTruthy();
		stale.unmount();

		state.config = { remote_provider: "ceralive", relay_server: "eu" };
		render(CloudRemoteDialog, { props: { open: true } });
		expect(screen.queryByTestId("relay-provider-stale-warning")).toBeNull();
	});
});
