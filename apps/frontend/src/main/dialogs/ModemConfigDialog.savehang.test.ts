// @vitest-environment jsdom
/**
 * ModemConfigDialog — a save ALWAYS lands somewhere the operator can read.
 *
 * Operator report, board-reproduced on a Quectel RM530N-GL: pressing Save left
 * a spinner running with no result, and neither the setting nor the dialog then
 * appeared to do anything. The device was never the problem — `modems.configure`
 * answered `{"success":true,…}` in 469 ms — but the wire row carried no `config`
 * block, so `modemConfigEchoMatches` could never confirm, the operation sat
 * `pending` to its TTL, and the phase it expired into rendered NOTHING.
 *
 * The backend half publishes the profile again (`withConnectionConfig`). This is
 * the half that must hold even when it does not: an echo can legitimately never
 * arrive, and "the spinner stopped" is not an answer. Every case below asserts a
 * TERMINAL, RENDERED state within the bounded TTL — never an endless spinner,
 * and never a silent stop.
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
		modems: { configure, setUsbMode: vi.fn(), scan: vi.fn(), getSms: vi.fn() },
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

const DEVICE_ID = "41";

/** The board's own RM530N-GL: SIM present, carrier-rejected, still searching. */
function carrierRejectedModem(config?: Modem["config"]): Modem {
	return {
		ifname: "wwan2",
		name: "RM530N-GL - 16855",
		model: "RM530N-GL",
		manufacturer: "Quectel",
		network_type: {
			supported: ["3g", "4g", "4g3g", "5g", "5g4g", "5g3g", "5g4g3g"],
			active: "4g",
		},
		status: {
			connection: "searching",
			network_type: "",
			signal: 94,
			roaming: false,
			network: "WOM",
		},
		registration_rejection: {
			error: "gprs-and-non-gprs-not-allowed",
			access_technology: "lte",
			operator_id: "732101",
		},
		packet_service_state: "detached",
		...(config === undefined ? {} : { config }),
	} as Modem;
}

const APPLIED = {
	device: DEVICE_ID,
	network_type: "4g",
	roaming: false,
	network: "",
	autoconfig: true,
	apn: "",
	username: "",
	password: "",
};

function mount(value: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem: value, deviceId: DEVICE_ID },
	});
}

function saveButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
}

function unconfirmedBand(): HTMLElement | null {
	return screen.queryByTestId("modem-save-unconfirmed");
}

function refusedBand(): HTMLElement | null {
	return screen.queryByTestId("modem-save-refused");
}

beforeAll(() => {
	if (!Element.prototype.animate) {
		Element.prototype.animate = vi.fn().mockReturnValue({
			cancel: vi.fn(),
			finish: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}) as unknown as Element["animate"];
	}
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
	resetModemsFeed();
	destroyAsyncOperations();
	configure.mockReset();
	// Shrink the TTL through the sanctioned override rather than faking the
	// clock: the store's sweep, the component effect and Svelte's own flush all
	// have to interleave, and a frozen clock proves none of that.
	(window as unknown as { __ceraAsyncOpTtlMs?: number }).__ceraAsyncOpTtlMs =
		30;
});

afterEach(() => {
	destroyAsyncOperations();
	(window as unknown as { __ceraAsyncOpTtlMs?: number }).__ceraAsyncOpTtlMs =
		undefined;
});

describe("a save that the device never echoes", () => {
	/**
	 * THE regression. The pre-fix wire shape verbatim: no `config` key at all, so
	 * nothing the device broadcasts can ever satisfy the echo predicate.
	 */
	it("stops spinning AND says what happened, instead of hanging", async () => {
		configure.mockResolvedValue({ success: true, applied: APPLIED });
		const rejected = carrierRejectedModem();
		publishModems({ [DEVICE_ID]: rejected });
		mount(rejected);

		expect(unconfirmedBand()).toBeNull();
		await fireEvent.click(saveButton());

		// The device keeps re-broadcasting itself, exactly as the poll does — and
		// none of it carries a config, so none of it can confirm.
		publishModems({ [DEVICE_ID]: carrierRejectedModem() });

		await waitFor(
			() => {
				expect(unconfirmedBand()).not.toBeNull();
			},
			{ timeout: 4000 },
		);
		expect(saveButton().disabled).toBe(false);
		expect(refusedBand()).toBeNull();
	});

	it("keeps the dialog open and re-armable", async () => {
		configure.mockResolvedValue({ success: true, applied: APPLIED });
		const rejected = carrierRejectedModem();
		publishModems({ [DEVICE_ID]: rejected });
		mount(rejected);

		await fireEvent.click(saveButton());
		await waitFor(() => expect(unconfirmedBand()).not.toBeNull(), {
			timeout: 4000,
		});

		await fireEvent.click(saveButton());
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
		expect(unconfirmedBand()).toBeNull();
	});
});

describe("a save the device DOES echo", () => {
	/**
	 * The backend join's payoff, asserted from the consumer's side: the same
	 * carrier-rejected modem, now carrying the NM profile the wire always
	 * declared, confirms and closes. A bearer is never involved — this modem has
	 * none and never will — which is the point: the echo is a stored-config
	 * claim, not a connectivity one.
	 */
	it("confirms and closes without waiting for a bearer", async () => {
		configure.mockResolvedValue({ success: true, applied: APPLIED });
		const before = carrierRejectedModem({
			apn: "",
			username: "",
			password: "",
			roaming: false,
			network: "",
			autoconfig: true,
		});
		publishModems({ [DEVICE_ID]: before });
		mount(before);
		expect(screen.queryByRole("dialog")).not.toBeNull();

		await fireEvent.click(saveButton());
		publishModems({ [DEVICE_ID]: before });

		await waitFor(
			() => {
				expect(screen.queryByRole("dialog")).toBeNull();
			},
			{ timeout: 4000 },
		);
		expect(unconfirmedBand()).toBeNull();
	});
});

describe("an explicit refusal outranks the unconfirmed band", () => {
	it("renders the refusal alone", async () => {
		configure.mockResolvedValue({
			success: false,
			error: "unconfigured_modem",
		});
		const rejected = carrierRejectedModem();
		publishModems({ [DEVICE_ID]: rejected });
		mount(rejected);

		await fireEvent.click(saveButton());

		await waitFor(() => expect(refusedBand()).not.toBeNull());
		expect(refusedBand()?.getAttribute("data-refusal")).toBe(
			"unconfigured_modem",
		);

		// The TTL still elapses underneath; the refusal must survive it and must
		// not be joined by a second, vaguer band saying the opposite.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(refusedBand()).not.toBeNull();
		expect(unconfirmedBand()).toBeNull();
	});
});
