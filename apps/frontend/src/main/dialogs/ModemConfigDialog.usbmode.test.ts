// @vitest-environment jsdom
/**
 * ModemConfigDialog — the USB-mode card's REAL switch handler.
 *
 * These tests drive the actual component against a mocked
 * `rpc.modems.setUsbMode` + `getModems()` feed. The one property worth the setup
 * is the PESSIMISTIC flip: a resolved, successful RPC must leave the rendered
 * mode exactly where it was until a `modems` snapshot proves THIS device — by
 * `stable_key` — reports the target. Everything else here is a way that gets
 * broken in practice.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { openModemAdvanced } from "../../tests/helpers/modem-advanced";
import {
	publishModems,
	resetModemsFeed,
} from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const setUsbMode = vi.hoisted(() => vi.fn());

// WHICH modes may be offered is the device's own answer, read once per open.
// The switch surface does not exist without it, so every case below that
// dispatches a switch has to seed one.
const usbModeOptions = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setUsbMode,
			getUsbModeOptions: usbModeOptions,
			configure: vi.fn(),
			scan: vi.fn(),
		},
	},
}));

// The provisioning gate is read off the config wire, so the mock has to be able
// to answer all THREE arms of its tristate — a fixed `{}` only ever exercises
// "absent".
const configFeed = vi.hoisted(() => ({
	value: {} as { modem_provisioning?: boolean },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => configFeed.value,
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const KEY = "platform-xhci-hcd.0-usb-1:2";

function modem(overrides: Partial<Modem> = {}): Modem {
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
		stable_key: KEY,
		usb_mode: "qmi",
		recommended_usb_mode: "mbim",
		...overrides,
	} as Modem;
}

/** Publish a `modems` snapshot the component's `$effect` will observe. */
const publish = publishModems;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function openConfirm(): Promise<void> {
	await fireEvent.click(await screen.findByText(/^Switch to /));
	await fireEvent.click(
		await screen.findByRole("button", { name: /Switch mode/i }),
	);
}

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
	setUsbMode.mockReset();
	usbModeOptions.mockReset();
	usbModeOptions.mockResolvedValue({ certified: ["mbim", "ecm-ncm"] });
	resetModemsFeed();
	configFeed.value = {};
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the card", () => {
	it("renders the active and recommended modes", async () => {
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		const active = await screen.findByTestId("modem-usb-mode-active");
		expect(active.getAttribute("data-usb-mode")).toBe("qmi");
		expect(
			screen
				.getByTestId("modem-usb-mode-recommended")
				.getAttribute("data-usb-mode"),
		).toBe("mbim");
		// OL-1: the wire token lives on the attribute, never in operator copy.
		expect(active.textContent).not.toContain("qmi");
	});

	it("is absent entirely when the device reports no mode — additive-tolerant", () => {
		render(ModemConfigDialog, {
			props: {
				open: true,
				modem: modem({ usb_mode: undefined, recommended_usb_mode: undefined }),
				deviceId: "0",
			},
		});
		expect(screen.queryByTestId("modem-usb-mode-card")).toBeNull();
	});

	it("offers no switch when the device has no certified way out of its mode", async () => {
		// The SKU IS certified; this particular mode simply has no certified
		// target. Nothing to offer, and nothing to complain about either.
		usbModeOptions.mockResolvedValue({ certified: [] });
		render(ModemConfigDialog, {
			props: {
				open: true,
				modem: modem({ usb_mode: "mbim", recommended_usb_mode: "mbim" }),
				deviceId: "0",
			},
		});
		await screen.findByTestId("modem-usb-mode-card");
		expect(screen.queryByText(/Switch to/i)).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-targets")).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-unavailable")).toBeNull();
	});

	it("refuses to offer a switch it could never confirm (no stable_key)", async () => {
		render(ModemConfigDialog, {
			props: {
				open: true,
				modem: modem({ stable_key: undefined }),
				deviceId: "0",
			},
		});
		await screen.findByTestId("modem-usb-mode-untrackable");
		expect(screen.queryByText(/Switch to/i)).toBeNull();
		// Certified but unconfirmable — the modes are not listed either.
		expect(screen.queryByTestId("modem-usb-mode-targets")).toBeNull();
	});
});

describe("ONLY the certified transitions are rendered", () => {
	it("renders exactly the device's certified set, and nothing outside it", async () => {
		usbModeOptions.mockResolvedValue({ certified: ["mbim", "ecm-ncm"] });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		const group = await screen.findByTestId("modem-usb-mode-targets");
		// The card lives inside the "Advanced" disclosure, whose collapsed body is
		// `visibility: hidden` and therefore INACCESSIBLE — so a role query has to
		// address it the way an operator does. `getByTestId` reaches it either
		// way, which is why only this assertion needed the step.
		await openModemAdvanced();
		const rendered = within(group)
			.getAllByRole("radio")
			.map((el) => el.getAttribute("data-testid"));
		expect(rendered).toEqual([
			"modem-usb-mode-target-mbim",
			"modem-usb-mode-target-ecm-ncm",
		]);
		// The mode the device is IN is not a target, and neither is a mode the
		// catalog never certified for it.
		expect(screen.queryByTestId("modem-usb-mode-target-qmi")).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-target-rndis")).toBeNull();
	});

	it("asks the DEVICE, keyed on the modem it was opened for", async () => {
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});
		await waitFor(() =>
			expect(usbModeOptions).toHaveBeenCalledWith({ device: "0" }),
		);
	});

	it("dispatches the mode the operator PICKED, not the recommended one", async () => {
		setUsbMode.mockResolvedValue({ success: true });
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await fireEvent.click(
			await screen.findByTestId("modem-usb-mode-target-ecm-ncm"),
		);
		await fireEvent.click(await screen.findByText(/^Switch to /));
		await fireEvent.click(
			await screen.findByRole("button", { name: /Switch mode/i }),
		);

		await waitFor(() =>
			expect(setUsbMode).toHaveBeenCalledWith({
				device: "0",
				mode: "ecm-ncm",
				confirm: true,
			}),
		);
	});

	it("marks the recommended mode WITHIN the certified set, never as a target of its own", async () => {
		usbModeOptions.mockResolvedValue({ certified: ["ecm-ncm"] });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await screen.findByTestId("modem-usb-mode-target-ecm-ncm");
		// `recommended_usb_mode` is `mbim`, and the device did not certify it.
		expect(screen.queryByTestId("modem-usb-mode-target-mbim")).toBeNull();
		expect(await screen.findByText(/^Switch to /)).toBeTruthy();
	});
});

describe("an uncertifiable device gets NO control — never a disabled one", () => {
	async function renderWithSuppression(suppressed: string) {
		usbModeOptions.mockResolvedValue({ certified: [], suppressed });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});
		return screen.findByTestId("modem-usb-mode-unavailable");
	}

	it("unknown model/firmware: the control does not render at all", async () => {
		const band = await renderWithSuppression("uncertified");
		expect(band.getAttribute("data-usb-mode-withheld")).toBe("uncertified");
		// Not hidden, not disabled — ABSENT. A disabled control would imply a
		// capability being withheld; there is no capability here.
		expect(screen.queryByTestId("modem-usb-mode-switch")).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-targets")).toBeNull();
		expect(screen.queryByText(/Switch to/i)).toBeNull();
	});

	it("a native-PCIe modem (identity_unresolved): the control does not render at all", async () => {
		const band = await renderWithSuppression("identity_unresolved");
		expect(band.getAttribute("data-usb-mode-withheld")).toBe(
			"identity_unresolved",
		);
		expect(screen.queryByTestId("modem-usb-mode-switch")).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-targets")).toBeNull();
	});

	it("surfaces the device's own reason VERBATIM, never a raw token", async () => {
		const band = await renderWithSuppression("uncertified");
		expect(band.textContent).toMatch(/certified/i);
		expect(band.textContent).not.toMatch(/uncertified\b(?!\s)/);
		expect(band.textContent).not.toMatch(/network\.modem/);
	});

	it("identity_unresolved resolves its copy from `reason.*`, not a missing `error.*` key", async () => {
		const band = await renderWithSuppression("identity_unresolved");
		expect(band.textContent).toMatch(/couldn't be identified/i);
		expect(band.textContent).not.toMatch(/network\.modem/);
	});

	it("is a STATUS, not an alert — nothing failed, this device just cannot switch", async () => {
		const band = await renderWithSuppression("uncertified");
		expect(band.getAttribute("role")).toBe("status");
	});

	it("still reports the ACTIVE mode — only the control is withdrawn", async () => {
		await renderWithSuppression("uncertified");
		expect(
			screen.getByTestId("modem-usb-mode-active").getAttribute("data-usb-mode"),
		).toBe("qmi");
	});

	it("dispatches NOTHING — the withheld offer is not cosmetic", async () => {
		await renderWithSuppression("uncertified");
		expect(setUsbMode).not.toHaveBeenCalled();
	});

	it("a read that THREW renders no control AND no claim about the device", async () => {
		// "We could not establish the set" is not "the set is empty" — stating
		// `uncertified` here would assert a device fact we do not have.
		usbModeOptions.mockRejectedValue(new Error("socket closed"));
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await screen.findByTestId("modem-usb-mode-card");
		await waitFor(() => expect(usbModeOptions).toHaveBeenCalled());
		expect(screen.queryByTestId("modem-usb-mode-targets")).toBeNull();
		expect(screen.queryByTestId("modem-usb-mode-unavailable")).toBeNull();
		expect(screen.queryByText(/Switch to/i)).toBeNull();
	});
});

describe("the handler is REAL — and pessimistic", () => {
	it("dispatches the confirmed mutation with confirm:true", async () => {
		setUsbMode.mockResolvedValue({ success: true });
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();

		await waitFor(() =>
			expect(setUsbMode).toHaveBeenCalledWith({
				device: "0",
				mode: "mbim",
				confirm: true,
			}),
		);
	});

	it("holds the spinner for the RPC's FULL duration — it awaits the whole transaction", async () => {
		const pending = deferred<{ success: boolean }>();
		setUsbMode.mockReturnValue(pending.promise);
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();

		await screen.findByTestId("modem-usb-mode-switching");
		expect(
			screen.getByTestId("modem-usb-mode-active").getAttribute("data-usb-mode"),
		).toBe("qmi");

		pending.resolve({ success: true });
	});

	it("RPC SUCCESS ALONE does not change the displayed mode", async () => {
		setUsbMode.mockResolvedValue({ success: true });
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();
		await waitFor(() => expect(setUsbMode).toHaveBeenCalled());

		// The reply has landed and the feed has NOT — the card must still read the
		// pre-switch mode and must still be holding the spinner.
		await screen.findByTestId("modem-usb-mode-switching");
		expect(
			screen.getByTestId("modem-usb-mode-active").getAttribute("data-usb-mode"),
		).toBe("qmi");
		expect(screen.queryByTestId("modem-usb-mode-confirmed")).toBeNull();
	});

	it("flips only on the confirming snapshot, matched by stable_key across a re-index", async () => {
		setUsbMode.mockResolvedValue({ success: true });
		publish({ "0": modem() });
		const { rerender } = render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();
		await waitFor(() => expect(setUsbMode).toHaveBeenCalled());

		// The transition re-issued the MM index AND changed the ifname; only the
		// stable key still names this device.
		publish({
			"7": modem({ ifname: "wwan1", usb_mode: "mbim" }),
		});
		await rerender({
			open: true,
			modem: modem({ ifname: "wwan1", usb_mode: "mbim" }),
			deviceId: "0",
		});

		await screen.findByTestId("modem-usb-mode-confirmed");
		expect(
			screen.getByTestId("modem-usb-mode-active").getAttribute("data-usb-mode"),
		).toBe("mbim");
	});

	it("renders a typed refusal inline, with its reason", async () => {
		setUsbMode.mockResolvedValue({
			success: false,
			error: "transition_failed",
			reason: "postcondition_mismatch",
		});
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();

		const band = await screen.findByTestId("modem-usb-mode-error");
		expect(band.textContent).toMatch(/didn't complete/i);
		expect(band.textContent).toMatch(/different mode than expected/i);
		expect(
			screen.getByTestId("modem-usb-mode-active").getAttribute("data-usb-mode"),
		).toBe("qmi");
	});

	it("renders the uncertified refusal — what every real modem gets today", async () => {
		setUsbMode.mockResolvedValue({ success: false, error: "uncertified" });
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();

		expect(
			(await screen.findByTestId("modem-usb-mode-error")).textContent,
		).toMatch(/certified/i);
	});

	it("a thrown RPC is surfaced, never swallowed into a stuck spinner", async () => {
		setUsbMode.mockRejectedValue(new Error("socket closed"));
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();

		await screen.findByTestId("modem-usb-mode-error");
		expect(screen.queryByTestId("modem-usb-mode-switching")).toBeNull();
	});

	it("an expired post-resolve window renders STILL TRANSITIONING, never a success", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setUsbMode.mockResolvedValue({ success: true });
		publish({ "0": modem() });
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});

		await openConfirm();
		await vi.waitFor(() => expect(setUsbMode).toHaveBeenCalled());

		await vi.advanceTimersByTimeAsync(21_000);

		await vi.waitFor(() => screen.getByTestId("modem-usb-mode-pending"));
		expect(
			screen.getByTestId("modem-usb-mode-active").getAttribute("data-usb-mode"),
		).toBe("qmi");
		expect(screen.queryByTestId("modem-usb-mode-confirmed")).toBeNull();
	});
});

describe("the provisioning gate", () => {
	function renderCard() {
		render(ModemConfigDialog, {
			props: { open: true, modem: modem(), deviceId: "0" },
		});
	}

	it("ABSENT offers the switch — an unpublished key is not a refusal", async () => {
		configFeed.value = {};
		renderCard();
		expect(await screen.findByText(/^Switch to /)).toBeTruthy();
		expect(
			screen.queryByTestId("modem-usb-mode-provisioning-blocked"),
		).toBeNull();
	});

	it("`true` offers the switch", async () => {
		configFeed.value = { modem_provisioning: true };
		renderCard();
		expect(await screen.findByText(/^Switch to /)).toBeTruthy();
		expect(
			screen.queryByTestId("modem-usb-mode-provisioning-blocked"),
		).toBeNull();
	});

	it("`false` renders the control disabled WITH its reason on screen", async () => {
		configFeed.value = { modem_provisioning: false };
		renderCard();
		const button = await screen.findByTestId("modem-usb-mode-switch");
		expect((button as HTMLButtonElement).disabled).toBe(true);
		// The reason is BOTH the accessible name and a rendered line: a kiosk
		// touchscreen cannot hover to reveal a tooltip.
		expect(button.getAttribute("title")?.trim()).toBeTruthy();
		expect(button.getAttribute("aria-label")?.trim()).toBeTruthy();
		const hint = screen.getByTestId("modem-usb-mode-provisioning-blocked");
		expect(hint.textContent?.trim()).toBeTruthy();
		expect(hint.textContent).not.toMatch(/provisioning_disabled/);
	});

	it("`false` dispatches NOTHING — the gate is not cosmetic", async () => {
		configFeed.value = { modem_provisioning: false };
		renderCard();
		const button = await screen.findByTestId("modem-usb-mode-switch");
		await fireEvent.click(button);
		expect(setUsbMode).not.toHaveBeenCalled();
	});

	it("`false` still reports the ACTIVE mode — the card is not withdrawn", async () => {
		configFeed.value = { modem_provisioning: false };
		renderCard();
		expect(
			(await screen.findByTestId("modem-usb-mode-active")).getAttribute(
				"data-usb-mode",
			),
		).toBe("qmi");
	});
});
