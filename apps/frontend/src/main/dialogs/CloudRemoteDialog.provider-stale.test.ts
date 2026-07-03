// @vitest-environment jsdom
/**
 * CloudRemoteDialog — provider preselect + dropped stale warning (T2.3).
 *
 * The destination IS the provider now, so switching managed clouds happens in
 * ServerDialog, which deep-links here preselecting the target provider via the
 * `provider` prop. A requested provider wins over `config.remote_provider`. The
 * obsolete `relay-provider-stale-warning` band is gone (provider == destination).
 */
import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import CloudRemoteDialog from "./CloudRemoteDialog.svelte";

const state = vi.hoisted(() => ({
	config: undefined as
		| { relay_server?: string; remote_provider?: string }
		| undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
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

// CloudRemoteDialog now imports generateDeviceAccessQr from NetworkHelper (folded
// in from the retired PairingDialog, T9); mock it so this suite does not pull the
// full rpcClient module graph.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => "data:image/png;base64,QR"),
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
});

describe("CloudRemoteDialog — provider preselect (T2.3)", () => {
	it("preselects the requested provider over the config provider", async () => {
		state.config = { remote_provider: "ceralive" };
		render(CloudRemoteDialog, { props: { open: true, provider: "belabox" } });

		const trigger = document.getElementById("cloud-provider") as HTMLElement;
		await waitFor(() => expect(trigger.textContent).toContain("BELABOX Cloud"));
	});

	it("drops the obsolete provider-switch stale warning", () => {
		state.config = { remote_provider: "belabox", relay_server: "eu" };
		render(CloudRemoteDialog, { props: { open: true } });
		expect(screen.queryByTestId("relay-provider-stale-warning")).toBeNull();
	});
});
