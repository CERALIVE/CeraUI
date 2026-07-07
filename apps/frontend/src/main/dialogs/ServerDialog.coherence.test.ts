// @vitest-environment jsdom
/**
 * ServerDialog — coherence-contract pass (C7).
 *
 *  1. Catalog-drift review note. When the resolved endpoint fingerprint changes
 *     after open (a managed server's addr/port drifting under the same id via a
 *     catalog update), a calm `role="status"` review line renders
 *     (`catalog-drift-note`). It is NOT a warning band, NEVER auto-mutates the
 *     draft, and NEVER blocks save. `getConfig`/`getRelays` are read through a
 *     reactive `.svelte.ts` seam so a `reactiveRelays.value = …; flushSync()`
 *     drives the drift.
 *
 *  2. Latency floor-clamp applied-value notice. When the backend clamps
 *     `srt_latency` and returns a different `applied.srt_latency`, the dialog
 *     stays OPEN and LatencySection renders the applied-value notice
 *     (`latency-clamped`) — the same treatment as EncoderDialog's `bitrateClamped`.
 */
import type { ConfigMessage, RelayMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	reactiveConfig,
	reactiveRelays,
} from "../../tests/fixtures/reactive-subscriptions.svelte";
import ServerDialog from "./ServerDialog.svelte";

const setConfig = vi.hoisted(() => vi.fn());
const relayValidate = vi.hoisted(() => vi.fn());
const markPending = vi.hoisted(() => vi.fn());
const onRpcResolved = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

const noop = vi.hoisted(
	() => async () =>
		({
			default: (await import("../../tests/fixtures/Noop.svelte")).default,
		}) as { default: unknown },
);
vi.mock("./CloudRemoteDialog.svelte", noop);

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveConfig, reactiveRelays } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return {
		getConfig: () => reactiveConfig.value,
		getRelays: () => reactiveRelays.value,
		getIsStreaming: () => false,
		getCapabilities: () => undefined,
		getManagedIngestAccounts: () => [],
		getSelectedIngestEndpoint: () => undefined,
	};
});

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig }, relay: { validate: relayValidate } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending,
	onRpcResolved,
}));
vi.mock("svelte-sonner", () => ({ toast }));

function relaysWith(addr: string, port: number): RelayMessage {
	return {
		accounts: {},
		servers: { "srv-eu": { name: "EU West", default: true, addr, port } },
	} as unknown as RelayMessage;
}

const saveButton = () =>
	screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

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
	reactiveConfig.reset();
	reactiveRelays.reset();
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} });
	relayValidate.mockReset();
	relayValidate.mockResolvedValue({ valid: true, stage: "probe" });
	markPending.mockReset();
	onRpcResolved.mockReset();
	toast.success.mockReset();
	toast.error.mockReset();
});

describe("ServerDialog — catalog-drift review note (C7)", () => {
	it("shows the note when the resolved endpoint drifts, and never blocks save", async () => {
		reactiveConfig.value = {
			remote_provider: "ceralive",
			relay_server: "srv-eu",
		} as unknown as ConfigMessage;
		reactiveRelays.value = relaysWith("1.2.3.4", 5000);

		render(ServerDialog, { props: { open: true } });
		flushSync();

		// No drift at open, and Save is available for the keyed managed cloud.
		expect(screen.queryByTestId("catalog-drift-note")).toBeNull();
		expect(saveButton().disabled).toBe(false);

		// A catalog update moves srv-eu's addr under the same id while the dialog
		// is open — the resolved endpoint fingerprint drifts.
		reactiveRelays.value = relaysWith("9.9.9.9", 5000);
		flushSync();

		const note = screen.getByTestId("catalog-drift-note");
		expect(note).not.toBeNull();
		expect(note.getAttribute("role")).toBe("status");
		// Save is STILL allowed (drift is informational, never a gate).
		expect(saveButton().disabled).toBe(false);
	});
});

describe("ServerDialog — latency floor-clamp applied-value notice (C7)", () => {
	it("keeps the dialog open and renders the applied-value notice from result.applied", async () => {
		// Custom destination so a plain addr/port save exercises the latency field.
		render(ServerDialog, { props: { open: true } });
		await fireEvent.click(screen.getByTestId("destination-custom"));

		const addr = document.getElementById("srtla-addr") as HTMLInputElement;
		const port = document.getElementById("srtla-port") as HTMLInputElement;
		await fireEvent.input(addr, { target: { value: "custom.example" } });
		await fireEvent.input(port, { target: { value: "5000" } });

		// The backend floors srt_latency and returns a DIFFERENT applied value.
		setConfig.mockResolvedValue({
			success: true,
			applied: { srt_latency: 4000 },
		});

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		// The dialog stays OPEN and the applied-value notice renders with "4 s".
		const notice = await screen.findByTestId("latency-clamped");
		expect(notice.textContent).toContain("4 s");
		expect(screen.queryByTestId("latency-section")).not.toBeNull();
	});

	it("closes normally when the applied latency equals the requested value", async () => {
		render(ServerDialog, { props: { open: true } });
		await fireEvent.click(screen.getByTestId("destination-custom"));
		const addr = document.getElementById("srtla-addr") as HTMLInputElement;
		const port = document.getElementById("srtla-port") as HTMLInputElement;
		await fireEvent.input(addr, { target: { value: "custom.example" } });
		await fireEvent.input(port, { target: { value: "5000" } });

		// Applied equals the requested default latency (2000) → no clamp notice.
		setConfig.mockResolvedValue({
			success: true,
			applied: { srt_latency: 2000 },
		});

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		await waitFor(() =>
			expect(screen.queryByTestId("latency-section")).toBeNull(),
		);
		expect(screen.queryByTestId("latency-clamped")).toBeNull();
	});
});
