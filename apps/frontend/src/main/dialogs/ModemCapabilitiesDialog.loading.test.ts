// @vitest-environment jsdom
/**
 * The bounded read, rendered.
 *
 * `ModemCapabilitiesDialog.test.ts` covers what the dialog says once it has an
 * answer. This file covers the three things it has to say while it does not, and
 * the one that matters most is the LAST: a device that never answers reaches a
 * terminal state on screen at the surface's declared bound rather than leaving
 * the operator on a skeleton.
 *
 * The four states are asserted to be pairwise distinguishable in the DOM,
 * because that IS the requirement: "not loaded", "loaded and ships nothing",
 * "loaded with every gate at zero" and "never answered" are four different facts
 * and were previously three identical blank surfaces.
 */
import { m } from "@ceraui/i18n/svelte";
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

import { MODEM_ASYNC_SURFACES } from "$lib/modem/async-surface";
import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import ModemCapabilitiesDialog from "./ModemCapabilitiesDialog.svelte";

const getCapabilities = vi.hoisted(() => vi.fn());
const setCapabilities = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: { modems: { getCapabilities, setCapabilities } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const ALL_OFF = {
	"band-lock": false,
	sms: false,
	"five-g-pref": false,
	"fcc-auto-unlock": false,
	gps: false,
	ussd: false,
	esim: false,
};

const BOUND_MS = MODEM_ASYNC_SURFACES.getCapabilities.boundMs;
const STALE_AFTER_MS = MODEM_ASYNC_SURFACES.getCapabilities.staleAfterMs ?? 0;

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
	initAsyncOperations();
});

beforeEach(() => {
	getCapabilities.mockReset();
	setCapabilities.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	destroyAsyncOperations();
	initAsyncOperations();
});

function mount() {
	render(ModemCapabilitiesDialog, { props: { open: true } });
}

describe("while the read is in flight", () => {
	it("names the wait instead of rendering a blank surface", async () => {
		getCapabilities.mockReturnValue(new Promise(() => {}));
		mount();

		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-loading")).toBeTruthy();
		});
		const loading = screen.getByTestId("modem-capabilities-loading");
		expect(loading.getAttribute("role")).toBe("status");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		// A spinner that says nothing is what a screen-reader operator receives as
		// silence, so the wait carries its own sentence.
		expect(loading.textContent).toContain(
			m["settings.modemCapabilities.loading"](),
		);
	});

	it("does not claim the build ships nothing while it is still asking", async () => {
		getCapabilities.mockReturnValue(new Promise(() => {}));
		mount();

		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-loading")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-capabilities-empty")).toBeNull();
		expect(screen.queryByTestId("modem-capabilities-honesty")).toBeNull();
		expect(screen.queryByTestId("modem-capabilities-load-failed")).toBeNull();
		expect(
			screen.queryByTestId("modem-capabilities-load-timed-out"),
		).toBeNull();
	});
});

describe("a device that never answers", () => {
	it("reaches its terminal state at the declared bound, not a spinner", async () => {
		vi.useFakeTimers();
		getCapabilities.mockReturnValue(new Promise(() => {}));
		mount();

		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("modem-capabilities-loading")).toBeTruthy();

		// One tick short of the bound the surface is still honestly waiting.
		await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
		expect(
			screen.queryByTestId("modem-capabilities-load-timed-out"),
		).toBeNull();

		await vi.advanceTimersByTimeAsync(1);
		const band = screen.getByTestId("modem-capabilities-load-timed-out");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain(
			m["settings.modemCapabilities.loadTimedOut"](),
		);
		expect(screen.queryByTestId("modem-capabilities-loading")).toBeNull();
	});

	it("separates 'did not answer' from 'the call failed'", async () => {
		vi.useFakeTimers();
		getCapabilities.mockReturnValue(new Promise(() => {}));
		mount();
		await vi.advanceTimersByTimeAsync(BOUND_MS);

		const timedOut = screen.getByTestId("modem-capabilities-load-timed-out");
		expect(timedOut.getAttribute("data-read-phase")).toBe("timed-out");
		// A broken socket and a busy device point at different repairs, so they
		// never share a testid or a sentence.
		expect(screen.queryByTestId("modem-capabilities-load-failed")).toBeNull();
		expect(m["settings.modemCapabilities.loadTimedOut"]()).not.toBe(
			m["settings.modemCapabilities.loadFailed"](),
		);
	});

	it("offers a Retry that actually re-reads the device", async () => {
		getCapabilities.mockRejectedValueOnce(new Error("socket closed"));
		mount();

		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-load-failed")).toBeTruthy();
		});

		getCapabilities.mockResolvedValueOnce({
			gates: { ...ALL_OFF },
			implemented: ["gps"],
		});
		await fireEvent.click(screen.getByTestId("modem-capabilities-retry"));

		await waitFor(() => {
			expect(screen.getByTestId("modem-capability-row-gps")).toBeTruthy();
		});
		expect(getCapabilities).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId("modem-capabilities-load-failed")).toBeNull();
	});
});

describe("unloaded, empty and zero are three different screens", () => {
	it("renders a MEASURED all-off reading as rows, never as emptiness", async () => {
		// The forcing case: every gate is zero, which is a reading the device took.
		// Collapsing it into the empty state would tell an operator this build
		// ships no cellular features at all.
		getCapabilities.mockResolvedValue({
			gates: { ...ALL_OFF },
			implemented: ["gps", "band-lock"],
		});
		mount();

		await waitFor(() => {
			expect(screen.getByTestId("modem-capability-row-gps")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-capabilities-empty")).toBeNull();
		expect(screen.queryByTestId("modem-capabilities-loading")).toBeNull();
		expect(
			screen
				.getByTestId("modem-capability-toggle-gps")
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("gives each of the four states its own marker, and only its own", async () => {
		vi.useFakeTimers();
		const MARKERS = [
			"modem-capabilities-loading",
			"modem-capabilities-empty",
			"modem-capability-row-gps",
			"modem-capabilities-load-timed-out",
		] as const;
		expect(new Set(MARKERS).size).toBe(4);

		const CASES: readonly {
			readonly marker: (typeof MARKERS)[number];
			readonly arrange: () => void;
			readonly settleMs: number;
		}[] = [
			{
				marker: "modem-capabilities-loading",
				arrange: () =>
					getCapabilities.mockReturnValueOnce(new Promise(() => {})),
				settleMs: 0,
			},
			{
				marker: "modem-capabilities-empty",
				arrange: () =>
					getCapabilities.mockResolvedValueOnce({
						gates: { ...ALL_OFF },
						implemented: [],
					}),
				settleMs: 0,
			},
			{
				marker: "modem-capability-row-gps",
				arrange: () =>
					getCapabilities.mockResolvedValueOnce({
						gates: { ...ALL_OFF },
						implemented: ["gps"],
					}),
				settleMs: 0,
			},
			{
				marker: "modem-capabilities-load-timed-out",
				arrange: () =>
					getCapabilities.mockReturnValueOnce(new Promise(() => {})),
				settleMs: BOUND_MS,
			},
		];

		for (const testCase of CASES) {
			testCase.arrange();
			const view = render(ModemCapabilitiesDialog, { props: { open: true } });
			await vi.advanceTimersByTimeAsync(testCase.settleMs);

			expect(screen.getByTestId(testCase.marker)).toBeTruthy();
			for (const other of MARKERS) {
				if (other === testCase.marker) continue;
				expect(
					screen.queryByTestId(other),
					`${testCase.marker} also rendered ${other}`,
				).toBeNull();
			}
			view.unmount();
		}
	});
});

describe("a reading that has aged says so", () => {
	it("marks itself stale rather than passing the value off as current", async () => {
		vi.useFakeTimers();
		getCapabilities.mockResolvedValue({
			gates: { ...ALL_OFF },
			implemented: ["gps"],
		});
		mount();

		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("modem-capability-row-gps")).toBeTruthy();
		expect(screen.queryByTestId("modem-capabilities-stale")).toBeNull();

		await vi.advanceTimersByTimeAsync(STALE_AFTER_MS - 1);
		expect(screen.queryByTestId("modem-capabilities-stale")).toBeNull();

		await vi.advanceTimersByTimeAsync(1);
		expect(screen.getByTestId("modem-capabilities-stale")).toBeTruthy();
		// The value stays on screen beneath the marker — a blanked surface would
		// be worse than an aged one, and the rows are still what the device said.
		expect(screen.getByTestId("modem-capability-row-gps")).toBeTruthy();
	});
});
