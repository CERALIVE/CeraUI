// @vitest-environment jsdom
/**
 * NetworkIngestDialog — per-protocol LAN RTMP/SRT ingest enable/disable (Task 8).
 *
 * Each toggle routes through the keyed async-operation machine (`osCommand`, key
 * `ingest-toggle-{rtmp|srt}`) for the re-entry guard + in-flight `pending` phase.
 * The toggle reflects the CONFIRMED broadcast state (`!operator_disabled`) — only
 * the spinner is optimistic (G4). An emulated-mode refusal surfaces the calm
 * `role="status"` band, never an error toast. These tests drive the real
 * component against a mocked `rpc.network.setIngestEnabled` + `getStatus`.
 */
import { getLL } from "@ceraui/i18n/svelte";
import { NETWORK_INGEST_UNAVAILABLE_ERROR } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
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
import NetworkIngestDialog from "./NetworkIngestDialog.svelte";

const setIngestEnabled = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ ingest: null }) as { ingest: unknown });

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { setIngestEnabled },
		streaming: { setSourceVisibility: vi.fn() },
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => ({ network_ingest: state.ingest }),
	getConfig: () => ({}),
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

const t = getLL().settings.networkIngest;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

type ProtocolEntry = {
	service_active: boolean;
	url: string | null;
	operator_disabled?: boolean;
} | null;

function seed(
	ingest: { rtmp?: ProtocolEntry; srt?: ProtocolEntry } | null,
): void {
	state.ingest =
		ingest === null
			? null
			: {
					rtmp: ingest.rtmp ?? null,
					srt: ingest.srt ?? null,
				};
}

const toggle = (p: "rtmp" | "srt") =>
	screen.getByTestId(`network-ingest-toggle-${p}`) as HTMLButtonElement;

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
	vi.clearAllMocks();
	state.ingest = null;
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("NetworkIngestDialog — status rendering", () => {
	it("reflects the confirmed broadcast state per protocol (running / disabled)", () => {
		seed({
			rtmp: { service_active: true, url: "rtmp://x:1935/publish/live" },
			srt: { service_active: false, url: null, operator_disabled: true },
		});
		render(NetworkIngestDialog, { props: { open: true } });

		// RTMP running → toggle ON, status "running".
		expect(toggle("rtmp").getAttribute("aria-checked")).toBe("true");
		expect(
			screen.getByTestId("network-ingest-status-rtmp").textContent,
		).toContain(t.statusRunning());

		// SRT operator-disabled → toggle OFF, status "disabled".
		expect(toggle("srt").getAttribute("aria-checked")).toBe("false");
		expect(
			screen.getByTestId("network-ingest-status-srt").textContent,
		).toContain(t.statusDisabled());
	});

	it("shows the stopped state for an enabled-but-inactive gateway", () => {
		seed({
			rtmp: { service_active: false, url: "rtmp://x:1935/publish/live" },
			srt: null,
		});
		render(NetworkIngestDialog, { props: { open: true } });

		// Enabled (no operator_disabled) but the unit is down → ON + "not running".
		expect(toggle("rtmp").getAttribute("aria-checked")).toBe("true");
		expect(
			screen.getByTestId("network-ingest-status-rtmp").textContent,
		).toContain(t.statusStopped());
		// A null (board-unsupported) srt entry defaults to enabled + stopped.
		expect(
			screen.getByTestId("network-ingest-status-srt").textContent,
		).toContain(t.statusStopped());
	});
});

describe("NetworkIngestDialog — toggle dispatch", () => {
	it("dispatches setIngestEnabled with the exact protocol + target and shows in-flight, blocking re-entry", async () => {
		const d = deferred<{
			success: boolean;
			applied: { protocol: "rtmp"; enabled: boolean };
		}>();
		setIngestEnabled.mockReturnValueOnce(d.promise);
		seed({
			rtmp: { service_active: true, url: "rtmp://x:1935/publish/live" },
			srt: null,
		});
		render(NetworkIngestDialog, { props: { open: true } });

		await fireEvent.click(toggle("rtmp")); // ON → OFF
		await Promise.resolve();
		expect(setIngestEnabled).toHaveBeenCalledWith({
			protocol: "rtmp",
			enabled: false,
		});
		expect(setIngestEnabled).toHaveBeenCalledOnce();

		// In-flight: the switch is disabled while the op is pending (spinner shown).
		await waitFor(() => expect(toggle("rtmp").disabled).toBe(true));

		// Re-entrant click while pending must not dispatch a second write.
		await fireEvent.click(toggle("rtmp"));
		await Promise.resolve();
		expect(setIngestEnabled).toHaveBeenCalledOnce();

		d.resolve({ success: true, applied: { protocol: "rtmp", enabled: false } });
		// Op stays pending until the broadcast confirms (spinner keeps spinning).
	});

	it("dispatches enable:true when toggling a disabled protocol on", async () => {
		setIngestEnabled.mockResolvedValue({
			success: true,
			applied: { protocol: "srt", enabled: true },
		});
		seed({
			rtmp: null,
			srt: { service_active: false, url: null, operator_disabled: true },
		});
		render(NetworkIngestDialog, { props: { open: true } });

		expect(toggle("srt").getAttribute("aria-checked")).toBe("false");
		await fireEvent.click(toggle("srt")); // OFF → ON
		await waitFor(() =>
			expect(setIngestEnabled).toHaveBeenCalledWith({
				protocol: "srt",
				enabled: true,
			}),
		);
	});
});

describe("NetworkIngestDialog — emulated-mode refusal", () => {
	it("surfaces the calm unavailable band (no toast), reverts, and releases re-entry", async () => {
		setIngestEnabled.mockResolvedValue({
			success: false,
			error: NETWORK_INGEST_UNAVAILABLE_ERROR,
		});
		seed({
			rtmp: { service_active: true, url: "rtmp://x:1935/publish/live" },
			srt: null,
		});
		render(NetworkIngestDialog, { props: { open: true } });

		await fireEvent.click(toggle("rtmp"));

		// Calm banner (NOT an error toast); the toggle stays on its confirmed value.
		await screen.findByTestId("network-ingest-unavailable");
		expect(toastError).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(toggle("rtmp").getAttribute("aria-checked")).toBe("true"),
		);

		// Re-entry released → another toggle dispatches again.
		await waitFor(() => expect(toggle("rtmp").disabled).toBe(false));
		await fireEvent.click(toggle("rtmp"));
		await waitFor(() => expect(setIngestEnabled).toHaveBeenCalledTimes(2));
	});

	it("shows a failed op + toast on a genuine (non-emulated) failure", async () => {
		setIngestEnabled.mockRejectedValue(new Error("boom"));
		seed({
			rtmp: { service_active: true, url: "rtmp://x:1935/publish/live" },
			srt: null,
		});
		render(NetworkIngestDialog, { props: { open: true } });

		await fireEvent.click(toggle("rtmp"));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		// No calm band for a genuine failure — that path is emulated-mode only.
		expect(screen.queryByTestId("network-ingest-unavailable")).toBeNull();
	});
});
