// @vitest-environment jsdom
/**
 * ModemConfigDialog — POWER IS REPORTED, NEVER OFFERED.
 *
 * `@ceralive/modem-control` publishes `power` as a `ContextReadOperation<
 * RadioPower>`: a read, with no setter beside it, no concrete reset operation
 * anywhere in the package, and `UhubctlPort` shipped as a port with no adapter
 * on any device. So the whole surface under test is a claim about ABSENCE, and
 * absence has no syntax to grep for — every assertion here is against the
 * RENDERED DOM, and every sweep is paired with a non-vacuity control proving the
 * same selector finds the controls that legitimately exist.
 *
 * The four other properties are the ones an operator meets:
 *   · the bearer re-establishment path KEEPS its destructive notice, naming the
 *     consequence before the save is committed;
 *   · a recovery refused because a stream is running says so, in words, rather
 *     than as a raw dotted key — nine of the sixteen refusal tokens had no copy
 *     at all before this todo, `streaming_active` among them;
 *   · an unconfirmed save renders the RECONCILE state and offers a re-check,
 *     never a success;
 *   · the re-check resolves the band when the device has since spoken, and says
 *     so honestly when it has not.
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

import { openModemAdvanced } from "../../tests/helpers/modem-advanced";
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
			getSms: vi.fn(),
			getUsbModeOptions: vi.fn().mockResolvedValue({ certified: [] }),
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

const DEVICE_ID = "0";

const SAVED_CONFIG = {
	apn: "internet",
	username: "",
	password: "",
	roaming: true,
	network: "",
	autoconfig: false,
} as const;

/** A connected modem carrying a stored profile, so a real edit costs a reconnect. */
function connectedModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		config: { ...SAVED_CONFIG },
		radio_power: "on",
		...overrides,
	} as Modem;
}

/**
 * A connected modem carrying NO stored profile.
 *
 * The save-path cases need this and not {@link connectedModem}: the dialog seeds
 * its form FROM the modem, so a fixture whose stored config already equals what
 * Save dispatches satisfies the configure-echo predicate on the very first
 * flush — the operation confirms, the dialog closes, and every band under test
 * unmounts before it can be asserted. With no `config` block the echo can never
 * match, which is exactly the state that makes a terminal band observable.
 */
function unconfiguredModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		radio_power: "on",
		...overrides,
	} as Modem;
}

/** The profile the dialog dispatches for {@link unconfiguredModem}. */
const UNCONFIGURED_ECHO = {
	apn: "",
	username: "",
	password: "",
	roaming: false,
	network: "",
	autoconfig: true,
} as const;

function mount(modem: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem, deviceId: DEVICE_ID },
	});
}

function saveButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
}

/**
 * Every control in the PORTALLED document — `AppDialog` mounts outside the
 * render container, so a container-scoped sweep passes on whatever rendered.
 */
function interactiveControls(): HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>(
			'button, input, select, textarea, [role="switch"], [role="checkbox"], [role="radio"]',
		),
	);
}

/** The identity an absence sweep reports, so a failure NAMES the offender. */
function describeControl(el: HTMLElement): string {
	return [
		el.getAttribute("data-testid"),
		el.getAttribute("aria-label"),
		el.getAttribute("name"),
		el.id,
		el.textContent?.trim(),
	]
		.filter((part) => part !== null && part !== undefined && part !== "")
		.join(" | ");
}

/** Anything an operator could read as a power/reset/hub ACTION. */
const POWER_ACTION = /power|reset|reboot|restart|hub|cycle|shut\s*down/i;

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
	(window as unknown as { __ceraAsyncOpTtlMs?: number }).__ceraAsyncOpTtlMs =
		30;
});

afterEach(() => {
	destroyAsyncOperations();
	(window as unknown as { __ceraAsyncOpTtlMs?: number }).__ceraAsyncOpTtlMs =
		undefined;
});

vi.setConfig({ testTimeout: 15000 });

describe("the radio power state is READ-ONLY", () => {
	it("renders the device's own answer, with its provenance", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		const state = screen.getByTestId("modem-power-state");
		expect(
			state
				.querySelector("[data-radio-power]")
				?.getAttribute("data-radio-power"),
		).toBe("on");
		// The provenance sentence is what makes "read-only" a statement on screen
		// rather than a property of the markup nobody can see.
		expect(state.textContent).toContain("modem service");
	});

	it("offers NO control for it — no switch, no button, no input", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		const card = screen.getByTestId("modem-power-card");
		expect(
			Array.from(
				card.querySelectorAll<HTMLElement>(
					'button, input, select, textarea, [role="switch"], [role="checkbox"], [role="radio"]',
				),
			).map(describeControl),
		).toEqual([]);
	});

	it("puts no power/reset/hub ACTION anywhere in the dialog", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		const offenders = interactiveControls()
			.filter((el) => POWER_ACTION.test(describeControl(el)))
			.map(describeControl);

		expect(offenders).toEqual([]);
	});

	it("...and the sweep above is NOT vacuous — the dialog does render controls", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		expect(interactiveControls().length).toBeGreaterThan(0);
		expect(saveButton()).toBeTruthy();
	});

	it("ABSENCE renders as absence, never as the modem's own `unknown`", async () => {
		const modem = connectedModem({ radio_power: undefined });
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		expect(screen.getByTestId("modem-power-unreported")).toBeTruthy();
		expect(
			screen
				.getByTestId("modem-power-state")
				.querySelector("[data-radio-power]"),
		).toBeNull();
	});

	it("a modem that said `unknown` is DISTINGUISHABLE from one that said nothing", async () => {
		const modem = connectedModem({ radio_power: "unknown" });
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		expect(
			screen
				.getByTestId("modem-power-state")
				.querySelector("[data-radio-power]")
				?.getAttribute("data-radio-power"),
		).toBe("unknown");
		expect(screen.queryByTestId("modem-power-unreported")).toBeNull();
	});
});

describe("the operations this build ships no write for are STATED", () => {
	it("names the radio-power write, the reset and the USB hub power-cycle", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		for (const id of ["radio-power", "modem-reset", "hub-power"]) {
			const row = screen.getByTestId(`modem-power-unavailable-${id}`);
			expect(row.textContent?.trim().length ?? 0).toBeGreaterThan(0);
			// A sentence, and nothing pressable — the whole point of the row.
			expect(row.querySelector("button, input, [role='switch']")).toBeNull();
		}
	});

	it("renders no raw dotted key in any of them", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);
		await openModemAdvanced();

		expect(
			screen.getByTestId("modem-power-unavailable").textContent,
		).not.toMatch(/network\.modem\./);
	});
});

describe("the bearer re-establishment path keeps its confirmation", () => {
	it("names the consequence BEFORE the save is committed", async () => {
		const modem = connectedModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);

		expect(screen.queryByTestId("modem-reconnect-notice")).toBeNull();

		// A real connect-time edit on a CONNECTED modem: this is the recovery.
		await fireEvent.click(
			screen.getByRole("switch", { name: /Allow Roaming/i }),
		);

		const notice = await screen.findByTestId("modem-reconnect-notice");
		expect(notice.getAttribute("data-changed")).toContain("roaming");
		expect(notice.textContent).toMatch(/reconnect|interrupt|drop/i);
	});
});

describe("a recovery attempted while streaming is REFUSED, visibly", () => {
	it("renders the interlock's own reason, in words", async () => {
		configure.mockResolvedValue({
			success: false,
			error: "streaming_active",
		});
		const modem = unconfiguredModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);

		await fireEvent.click(saveButton());

		const band = await screen.findByTestId("modem-save-refused");
		expect(band.getAttribute("data-refusal")).toBe("streaming_active");
		// The regression that matters: this token had NO copy, so the band used to
		// print its own dotted key at an operator.
		expect(band.textContent).not.toMatch(/network\.modem\.saveRefused/);
		expect(band.textContent).toMatch(/stream/i);
	});

	it("does not also claim the save was unconfirmed", async () => {
		configure.mockResolvedValue({
			success: false,
			error: "streaming_active",
		});
		const modem = unconfiguredModem();
		publishModems({ [DEVICE_ID]: modem });
		mount(modem);

		await fireEvent.click(saveButton());
		await screen.findByTestId("modem-save-refused");

		expect(screen.queryByTestId("modem-save-unconfirmed")).toBeNull();
	});
});

describe("an unconfirmed outcome renders the RECONCILE state", () => {
	/** A dispatch that throws: `osCommand` swallows it and the phase goes terminal. */
	function mountUnconfirmed() {
		configure.mockRejectedValue(new Error("socket closed"));
		const modem = unconfiguredModem();
		publishModems({ [DEVICE_ID]: modem });
		return { ...mount(modem), modem };
	}

	it("says the write is unknown, and never that it succeeded", async () => {
		mountUnconfirmed();

		await fireEvent.click(saveButton());

		const band = await screen.findByTestId("modem-save-unconfirmed");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toMatch(/not confirmed|did not report/i);
	});

	it("offers a re-check, which is the reconcile affordance", async () => {
		mountUnconfirmed();

		await fireEvent.click(saveButton());
		await screen.findByTestId("modem-save-unconfirmed");

		expect(screen.getByTestId("modem-save-reconcile")).toBeTruthy();
		// Nothing has been asked yet, so nothing may claim the check failed.
		expect(screen.queryByTestId("modem-save-reconcile-unresolved")).toBeNull();
	});

	it("a re-check against a device that STILL has not spoken says so", async () => {
		mountUnconfirmed();

		await fireEvent.click(saveButton());
		await screen.findByTestId("modem-save-unconfirmed");
		await fireEvent.click(screen.getByTestId("modem-save-reconcile"));

		expect(
			await screen.findByTestId("modem-save-reconcile-unresolved"),
		).toBeTruthy();
		// Still unknown — a failed re-check must not resolve into either verdict.
		expect(screen.getByTestId("modem-save-unconfirmed")).toBeTruthy();
	});

	it("dispatches NOTHING — a re-check must not re-mutate an unknown bearer", async () => {
		mountUnconfirmed();

		await fireEvent.click(saveButton());
		await screen.findByTestId("modem-save-unconfirmed");
		const dispatchesAfterSave = configure.mock.calls.length;

		await fireEvent.click(screen.getByTestId("modem-save-reconcile"));
		await fireEvent.click(screen.getByTestId("modem-save-reconcile"));

		expect(configure.mock.calls.length).toBe(dispatchesAfterSave);
	});

	it("resolves the band once the device HAS reported the settings back", async () => {
		configure.mockRejectedValue(new Error("socket closed"));
		const modem = unconfiguredModem();
		publishModems({ [DEVICE_ID]: modem });
		const { rerender } = mount(modem);

		await fireEvent.click(saveButton());
		await screen.findByTestId("modem-save-unconfirmed");

		// The broadcast that arrived one tick after the TTL lapsed, carrying the
		// profile the dialog had dispatched. The re-check is what turns that into
		// an answer; without it the band stands for the rest of the session.
		await rerender({
			modem: unconfiguredModem({ config: { ...UNCONFIGURED_ECHO } }),
		});
		await fireEvent.click(screen.getByTestId("modem-save-reconcile"));

		await waitFor(() => {
			expect(screen.queryByTestId("modem-save-unconfirmed")).toBeNull();
		});
	});
});
