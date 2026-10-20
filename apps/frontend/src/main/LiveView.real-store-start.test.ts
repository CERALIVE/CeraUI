// @vitest-environment jsdom
/**
 * A start whose reply a connection reset swallowed is settled ONLY by a
 * lifecycle the device delivered after the loss, on the link that is current
 * now (FIX-16-FRONT3 R1). A session restoration is not that evidence: the
 * reconnect hydrate can fail and still count as restored, leaving the
 * pre-reset snapshot in the store.
 *
 * Everything on the status path is real: the subscription store's handlers,
 * its reconnect re-authentication and hydrate, the session epoch, the optimism
 * and async-operation stores, LiveView with its real cockpits, band and header,
 * and (for the remount cases) the real NavigationRenderer. Only the transport,
 * the static device getters (config, sources, network) and heavy leaves are
 * scripted. Expectations are literal control lists and optimism states.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
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
	band,
	button,
	controls,
	installJsdomShims,
} from "../tests/fixtures/real-cockpit-harness";
import {
	dropLink,
	firstLink,
	push,
	restoreLink,
	type ScriptedTransport,
} from "../tests/fixtures/real-store-live";
import {
	publishNavigation,
	resetNavigationFeed,
} from "./navigation/__fixtures__/navigation-feed.svelte";

const transport = vi.hoisted(
	(): ScriptedTransport => ({
		message: undefined,
		connection: undefined,
		authenticated: false,
	}),
);

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));
vi.mock("svelte-sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
}));
vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: {
		auth: { login: vi.fn(async () => ({ success: true })) },
		streaming: {
			start: vi.fn(),
			stop: vi.fn(),
			setConfig: vi.fn(),
			getConfig: vi.fn(async () => ({})),
		},
		status: { getStatus: vi.fn() },
	},
	rpcClient: (await import("../tests/fixtures/real-store-live")).rpcClientMock(
		transport,
	),
}));
vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) =>
	(await import("../tests/fixtures/real-store-live")).deviceGettersMock(
		await importOriginal<typeof import("$lib/rpc/subscriptions.svelte")>(),
	),
);
vi.mock("$lib/stores/connection-ux.svelte", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/stores/connection-ux.svelte")
	>()),
	wasAuthenticated: () => transport.authenticated,
}));
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));
const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("$lib/components/preview/PreviewCanvas.svelte", noop);
vi.mock("$lib/components/custom/ComingSoon.svelte", noop);
vi.mock("$main/live/CapabilityTierBanner.svelte", noop);
vi.mock("$main/dialogs/ServerDialog.svelte", noop);
vi.mock("$main/dialogs/AudioDialog.svelte", noop);
vi.mock("$main/dialogs/EncoderDialog.svelte", noop);
// NavigationRenderer's own seams, as its test replaces them: no Web Animations
// in jsdom, no hash listener, every destination's namespaces already loaded.
vi.mock("$lib/transitions", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/transitions")>()),
	einkGatedFade: () => ({ duration: 0 }),
	einkGatedFly: () => ({ duration: 0 }),
}));
vi.mock("$lib/helpers/NavigationHelper", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/helpers/NavigationHelper")>()),
	setupHashNavigation: () => () => undefined,
}));
vi.mock("$lib/i18n/namespace-activation", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/i18n/namespace-activation")>()),
	areDestinationNamespacesLoaded: () => true,
	ensureDestinationNamespaces: async () => undefined,
}));
vi.mock("$lib/stores/navigation.svelte", async (importOriginal) => {
	const feed = await import("./navigation/__fixtures__/navigation-feed.svelte");
	const readable = <T>(value: T) => ({
		subscribe: (run: (v: T) => void) => {
			run(value);
			return () => {};
		},
	});
	return {
		...(await importOriginal<typeof import("$lib/stores/navigation.svelte")>()),
		getCurrentNavigation: feed.getCurrentNavigationFeed,
		isNavigationTransitioning: readable(false),
		navigationError: readable(null),
		transitionDirection: readable("forward" as const),
	};
});

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { ConnectionResetError, rpc } from "$lib/rpc/client";
import {
	destroyStreamingOptimism,
	getStreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";
import {
	getStatus,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

import Noop from "../tests/fixtures/Noop.svelte";
import LiveView from "./LiveView.svelte";
import NavigationRenderer from "./navigation/NavigationRenderer.svelte";

const start = vi.mocked(rpc.streaming.start);
const getStatusRpc = vi.mocked(rpc.status.getStatus);

beforeAll(() => {
	installJsdomShims(vi.fn());
});

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.setItem("auth", "token-abc");
	resetState();
	initSubscriptions();
	initAsyncOperations();
	getStreamingOptimismState();
	resetNavigationFeed();
	firstLink(transport);
	push(transport, { is_streaming: false, stream_lifecycle: "idle" });
});

afterEach(() => {
	destroyAsyncOperations();
	destroyStreamingOptimism();
	dropLink(transport);
	localStorage.clear();
	document.body.innerHTML = "";
});

/**
 * Press Start in the real idle cockpit; the socket then closes under the
 * request, rejecting it before the edge is reported, as `RPCClient.onclose` does.
 */
async function pressStartAndLoseReply(container: HTMLElement): Promise<void> {
	let lose!: (error: unknown) => void;
	start.mockReturnValueOnce(
		new Promise((_resolve, reject) => {
			lose = reject;
		}) as never,
	);
	await fireEvent.click(button(container, "Start Stream"));
	await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
	lose(new ConnectionResetError(["streaming", "start"]));
	dropLink(transport);
	await Promise.resolve();
	flushSync();
	expect(controls(container)).toEqual([
		{ label: "Starting...", disabled: true },
	]);
}

describe("R1: a lost start reply is settled only by current-link lifecycle evidence", () => {
	it("a failed status hydrate never settles a lost start", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		// Re-authentication succeeds, the status hydrate FAILS: restored, but
		// the store still holds the pre-reset snapshot.
		await restoreLink(transport, getStatusRpc, { fails: true });
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(getStatus()?.is_streaming).toBe(false);

		expect(getStreamingOptimismState()).toBe("starting");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);

		// A push on the new link that does not carry the lifecycle says nothing about it.
		push(transport, { is_streaming: false });
		expect(getStreamingOptimismState()).toBe("starting");

		// The device then delivers its idle lifecycle over the new link.
		push(transport, { stream_lifecycle: "idle" });
		expect(getStreamingOptimismState()).toBe("idle");
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("a hydrate that delivers idle settles the lost start", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "idle" },
		});

		expect(getStreamingOptimismState()).toBe("idle");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("a hydrate that delivers starting keeps Starting...", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "starting" },
		});

		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
	});
});

describe("the lost-reply record survives NavigationRenderer replacing the Live view", () => {
	function navigate(to: "live" | "network"): void {
		publishNavigation(
			to === "live"
				? { live: { component: LiveView } }
				: { network: { component: Noop } },
		);
		flushSync();
	}

	it("idle delivered while away settles the start on return", async () => {
		navigate("live");
		const { container } = render(NavigationRenderer);
		await pressStartAndLoseReply(container);

		navigate("network");
		await waitFor(() => expect(controls(container)).toEqual([]));
		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "idle" },
		});

		navigate("live");
		await waitFor(() => expect(getStreamingOptimismState()).toBe("idle"));
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("idle delivered on a link that dropped again is not current: Starting... stays", async () => {
		navigate("live");
		const { container } = render(NavigationRenderer);
		await pressStartAndLoseReply(container);

		navigate("network");
		await waitFor(() => expect(controls(container)).toEqual([]));
		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false, stream_lifecycle: "idle" },
		});
		dropLink(transport);
		await restoreLink(transport, getStatusRpc, { fails: true });

		navigate("live");
		await waitFor(() =>
			expect(controls(container)).toEqual([
				{ label: "Starting...", disabled: true },
			]),
		);
		expect(getStreamingOptimismState()).toBe("starting");
	});
});
