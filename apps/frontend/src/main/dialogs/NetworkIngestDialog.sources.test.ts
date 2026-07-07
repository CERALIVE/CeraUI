// @vitest-environment jsdom
/**
 * NetworkIngestDialog — "Sources" test-pattern visibility toggle (Todo 8).
 *
 * The renamed-in-place Sources dialog gains a THIRD toggle row, "Show test
 * pattern", beside the rtmp/srt ingest rows. It reflects
 * `config.sources_visibility.hide_test_pattern` (switch ON = visible; the switch
 * reads "Show test pattern", checked by default), and persists the inverse via
 * `rpc.streaming.setSourceVisibility({ hide_test_pattern })`.
 *
 * Unlike the rtmp/srt toggles, this op is dispatched with `silent: true` — a
 * genuine failure NEVER toasts; instead a calm inline failure band renders,
 * driven by `getOperationPhase('sources:test-pattern') === 'failed'`. The toggle
 * is pessimistic: its position only moves once the confirming `config` broadcast
 * lands (no optimistic flip on the RPC resolve). rtmp/srt keep their existing
 * non-silent behavior.
 */
import { getLL } from "@ceraui/i18n/svelte";
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
const setSourceVisibility = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const state = vi.hoisted(
	() =>
		({ ingest: null, config: {} }) as {
			ingest: unknown;
			config: Record<string, unknown>;
		},
);

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { setIngestEnabled },
		streaming: { setSourceVisibility },
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => ({ network_ingest: state.ingest }),
	getConfig: () => state.config,
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

const sources = getLL().settings.dialogs.sources;

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

function seedIngest(
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

function seedConfig(hideTestPattern: boolean | undefined): void {
	state.config =
		hideTestPattern === undefined
			? {}
			: { sources_visibility: { hide_test_pattern: hideTestPattern } };
}

const testPatternToggle = () =>
	screen.getByTestId("sources-test-pattern-toggle") as HTMLButtonElement;

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
	state.config = {};
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("NetworkIngestDialog — test-pattern row rendering (a)", () => {
	it("renders a 'Show test pattern' row, checked by default when the key is absent", () => {
		seedConfig(undefined);
		render(NetworkIngestDialog, { props: { open: true } });

		const row = screen.getByTestId("sources-test-pattern-row");
		expect(row.textContent).toContain(sources.testPatternToggle());
		// Absent key = visible = switch ON ("Show test pattern").
		expect(testPatternToggle().getAttribute("aria-checked")).toBe("true");
	});

	it("renders the switch OFF when hide_test_pattern is true", () => {
		seedConfig(true);
		render(NetworkIngestDialog, { props: { open: true } });

		expect(testPatternToggle().getAttribute("aria-checked")).toBe("false");
	});
});

describe("NetworkIngestDialog — test-pattern dispatch (b)", () => {
	it("dispatches setSourceVisibility({ hide_test_pattern: true }) pessimistically, without an optimistic flip", async () => {
		const d = deferred<{
			success: boolean;
			applied: { hide_test_pattern: boolean };
		}>();
		setSourceVisibility.mockReturnValueOnce(d.promise);
		seedConfig(undefined); // visible → switch ON
		render(NetworkIngestDialog, { props: { open: true } });

		expect(testPatternToggle().getAttribute("aria-checked")).toBe("true");
		await fireEvent.click(testPatternToggle()); // hide → persist hide_test_pattern:true
		await Promise.resolve();

		expect(setSourceVisibility).toHaveBeenCalledWith({
			hide_test_pattern: true,
		});
		expect(setSourceVisibility).toHaveBeenCalledOnce();

		// Pessimistic: the position does NOT move on dispatch — it stays on the
		// confirmed value until the config broadcast lands. Only the spinner is
		// optimistic (the switch is disabled while pending).
		expect(testPatternToggle().getAttribute("aria-checked")).toBe("true");
		await waitFor(() => expect(testPatternToggle().disabled).toBe(true));

		// Re-entrant click while pending must not dispatch a second write.
		await fireEvent.click(testPatternToggle());
		await Promise.resolve();
		expect(setSourceVisibility).toHaveBeenCalledOnce();

		d.resolve({ success: true, applied: { hide_test_pattern: true } });
		// Op stays pending until the config broadcast confirms — the switch keeps
		// its prior position (no config mutation seeded here).
		await Promise.resolve();
		expect(testPatternToggle().getAttribute("aria-checked")).toBe("true");
	});

	it("dispatches hide_test_pattern:false when toggling a hidden test pattern back on", async () => {
		setSourceVisibility.mockResolvedValue({
			success: true,
			applied: { hide_test_pattern: false },
		});
		seedConfig(true); // hidden → switch OFF
		render(NetworkIngestDialog, { props: { open: true } });

		expect(testPatternToggle().getAttribute("aria-checked")).toBe("false");
		await fireEvent.click(testPatternToggle()); // show → hide_test_pattern:false
		await waitFor(() =>
			expect(setSourceVisibility).toHaveBeenCalledWith({
				hide_test_pattern: false,
			}),
		);
	});
});

describe("NetworkIngestDialog — test-pattern failure (c)", () => {
	it("keeps the prior position, renders a calm inline band, and does NOT toast on rejection", async () => {
		setSourceVisibility.mockRejectedValue(new Error("boom"));
		seedConfig(undefined); // visible → switch ON
		render(NetworkIngestDialog, { props: { open: true } });

		await fireEvent.click(testPatternToggle());

		// The silent op renders its OWN inline failure band — never a toast.
		await screen.findByTestId("sources-test-pattern-error");
		expect(toastError).not.toHaveBeenCalled();

		// The switch stays on its prior (confirmed) position.
		await waitFor(() =>
			expect(testPatternToggle().getAttribute("aria-checked")).toBe("true"),
		);
	});
});

describe("NetworkIngestDialog — rtmp/srt toggles unchanged (d)", () => {
	it("keeps rtmp/srt on the non-silent setIngestEnabled path and never calls setSourceVisibility", async () => {
		setIngestEnabled.mockResolvedValue({
			success: true,
			applied: { protocol: "rtmp", enabled: false },
		});
		seedIngest({
			rtmp: { service_active: true, url: "rtmp://x:1935/publish/live" },
			srt: null,
		});
		seedConfig(undefined);
		render(NetworkIngestDialog, { props: { open: true } });

		const rtmp = screen.getByTestId(
			"network-ingest-toggle-rtmp",
		) as HTMLButtonElement;
		await fireEvent.click(rtmp);
		await waitFor(() =>
			expect(setIngestEnabled).toHaveBeenCalledWith({
				protocol: "rtmp",
				enabled: false,
			}),
		);
		expect(setSourceVisibility).not.toHaveBeenCalled();
	});
});
