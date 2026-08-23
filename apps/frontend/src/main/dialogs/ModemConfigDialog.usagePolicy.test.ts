// @vitest-environment jsdom
/**
 * ModemConfigDialog — the usage policy's TRI-STATE save, asserted on the wire
 * the dialog actually dispatches.
 *
 * `modem-usage-policy.test.ts` proves the DIFF; this proves the dialog is wired
 * to it. The split is the same one `capability-modules.test.ts` and
 * `ModemConfigDialog.capabilityTruth.test.ts` already make, and it matters here
 * for a specific reason: the defect this replaces was not in the projection, it
 * was in the CALL SITE. `toUsagePolicyWireFields(formData)` is a correct
 * function that states both bounds, and stating both bounds is exactly what
 * clears one the operator never touched.
 *
 * The fixture carries NO `config` block on purpose. The dialog seeds its form
 * from the modem, so a fixture whose stored config already equals what Save
 * dispatches satisfies the echo on the first flush, closes the dialog, and
 * unmounts everything under test.
 */

import type { Modem } from "@ceraui/rpc/schemas";
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

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";

import {
	publishModems,
	resetModemsFeed,
} from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const configure = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			configure,
			setUsbMode: vi.fn(),
			scan: vi.fn(),
			getSms: vi.fn(async () => ({ success: true, messages: [] })),
			getUsbModeOptions: vi.fn(async () => ({ certified: [] })),
			getBands: vi.fn(async () => ({ success: false, error: "unsupported" })),
			getGps: vi.fn(async () => ({ success: false })),
			getFccUnlock: vi.fn(async () => ({ success: false })),
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const DEVICE_ID = "7";
const GB = 1024 ** 3;

function modem(policy?: Modem["data_usage_policy"]): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4g",
			signal: 72,
			roaming: false,
		},
		...(policy === undefined ? {} : { data_usage_policy: policy }),
	} as Modem;
}

function mount(value: Modem) {
	publishModems({ [DEVICE_ID]: value });
	return render(ModemConfigDialog, {
		props: { open: true, modem: value, deviceId: DEVICE_ID },
	});
}

const save = () =>
	fireEvent.click(screen.getByRole("button", { name: /save/i }));

/** The usage-policy half of the single `modems.configure` call Save made. */
async function dispatched(): Promise<Record<string, unknown>> {
	await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
	return configure.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	resetModemsFeed();
	configure.mockResolvedValue({ success: true });
});

afterEach(() => {
	destroyAsyncOperations();
	vi.clearAllMocks();
});

describe("ModemConfigDialog — the usage policy is a tri-state write", () => {
	it("a threshold-only save PRESERVES the persisted cycle day by omitting it", async () => {
		mount(modem({ supported: true, cycle_day: 17, threshold_bytes: 10 * GB }));

		await fireEvent.input(screen.getByTestId("modem-usage-threshold-input"), {
			target: { value: "20" },
		});
		await save();

		const input = await dispatched();
		expect(input.data_usage_threshold_bytes).toBe(20 * GB);
		expect(input).not.toHaveProperty("data_usage_cycle_day");
	});

	it("an explicit clear REMOVES the persisted cycle day", async () => {
		mount(modem({ supported: true, cycle_day: 17, threshold_bytes: 10 * GB }));

		await fireEvent.change(screen.getByTestId("modem-usage-cycle-day-select"), {
			target: { value: "" },
		});
		await save();

		const input = await dispatched();
		expect(input.data_usage_cycle_day).toBeNull();
	});

	// The dialog seeds ONCE on the open edge and is deliberately not live-synced,
	// so a dialog opened before the policy block arrived holds an empty cycle-day
	// field for a modem that has one. This is the case the old call site got
	// wrong: it stated that empty field as a clear.
	it("a bound the operator never saw is not cleared by a save about another", async () => {
		mount(modem({ supported: true }));

		await fireEvent.input(screen.getByTestId("modem-usage-threshold-input"), {
			target: { value: "5" },
		});
		await save();

		const input = await dispatched();
		expect(input.data_usage_threshold_bytes).toBe(5 * GB);
		expect(input).not.toHaveProperty("data_usage_cycle_day");
	});

	it("a save that touched neither bound mentions neither", async () => {
		mount(modem({ supported: true, cycle_day: 17, threshold_bytes: 10 * GB }));
		await save();

		const input = await dispatched();
		expect(input).not.toHaveProperty("data_usage_cycle_day");
		expect(input).not.toHaveProperty("data_usage_threshold_bytes");
	});

	// NON-VACUITY: the omissions above must come from the diff, not from the
	// dialog having stopped sending policy fields at all.
	it("still writes both bounds when the operator answered both", async () => {
		mount(modem({ supported: true }));

		await fireEvent.change(screen.getByTestId("modem-usage-cycle-day-select"), {
			target: { value: "3" },
		});
		await fireEvent.input(screen.getByTestId("modem-usage-threshold-input"), {
			target: { value: "2" },
		});
		await save();

		const input = await dispatched();
		expect(input.data_usage_cycle_day).toBe(3);
		expect(input.data_usage_threshold_bytes).toBe(2 * GB);
	});

	it("a device whose build cannot apply a policy is sent no policy field", async () => {
		mount(modem({ supported: false, cycle_day: 17 }));
		await save();

		const input = await dispatched();
		expect(input).not.toHaveProperty("data_usage_cycle_day");
		expect(input).not.toHaveProperty("data_usage_threshold_bytes");
	});
});
