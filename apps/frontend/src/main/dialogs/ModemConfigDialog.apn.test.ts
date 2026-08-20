// @vitest-environment jsdom
/**
 * ModemConfigDialog — the APN save is honest in BOTH directions.
 *
 * Both halves come from one board session (Rock 5B+, 2026-08-16) in which a
 * save reported success and changed nothing:
 *
 *   · Automatic APN was a control the device could not honour. It was turned
 *     on, the dialog closed on a confirmed echo, `nmcli` still read
 *     `gsm.auto-config: no`, and reopening the dialog showed the switch off.
 *     So the switch is now gated on the device's own capability and says why.
 *   · `modems.configure` answered `{success:true}` unconditionally, because the
 *     apply was dispatched fire-and-forget. A refusal now reaches the operator
 *     as a standing band rather than as a closed dialog.
 *
 * The negative controls are the point of the suite: a device that CAN do
 * automatic APN, and a backend that predates the capability field, must both
 * render the switch exactly as before.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetModemsFeed } from "../../tests/helpers/modem-feed.svelte";
import ModemConfigDialog from "./ModemConfigDialog.svelte";

const configure = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { configure, setUsbMode: vi.fn(), scan: vi.fn() } },
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

type WireModemConfig = NonNullable<Modem["config"]>;

function modemWithConfig(config: Partial<WireModemConfig>): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: false,
		},
		config: {
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
			autoconfig: false,
			...config,
		},
	} as Modem;
}

function mount(modem: Modem) {
	return render(ModemConfigDialog, {
		props: { open: true, modem, deviceId: "2" },
	});
}

function autoApnSwitch(): HTMLElement {
	return screen.getByRole("switch", { name: /Automatic APN/i });
}

/**
 * Save a genuinely CHANGED form.
 *
 * A save that alters nothing is confirmed by the configure-echo the instant it
 * is dispatched — the broadcast already matches what was sent — and the dialog
 * closes before any answer arrives. That is correct for a no-op save and would
 * make every assertion here pass for the wrong reason, so each refusal case
 * edits the APN first.
 */
async function saveChangedApn(apn: string): Promise<void> {
	const input = document.querySelector<HTMLInputElement>("#modem-apn");
	if (input === null) throw new Error("manual APN field is not mounted");
	await fireEvent.input(input, { target: { value: apn } });
	await fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
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
	configure.mockReset();
	configure.mockResolvedValue({ success: true });
	resetModemsFeed();
});

describe("Automatic APN is offered only where the device can honour it", () => {
	it("disables the switch WITH ITS REASON when the device says it cannot", async () => {
		mount(modemWithConfig({ autoconfig_supported: false }));

		expect(await screen.findByTestId("modem-autoapn-unsupported")).toBeTruthy();
		expect(autoApnSwitch().hasAttribute("disabled")).toBe(true);
	});

	it("states the reason ON SCREEN, not only in the accessible name", async () => {
		mount(modemWithConfig({ autoconfig_supported: false }));

		const note = await screen.findByTestId("modem-autoapn-unsupported");
		expect(note.textContent?.trim().length).toBeGreaterThan(0);
	});

	it("offers the switch when the device says it CAN", async () => {
		mount(modemWithConfig({ autoconfig_supported: true }));

		await waitFor(() => expect(autoApnSwitch()).toBeTruthy());
		expect(autoApnSwitch().hasAttribute("disabled")).toBe(false);
		expect(screen.queryByTestId("modem-autoapn-unsupported")).toBeNull();
	});

	it("offers the switch when the backend never published the field", async () => {
		// ABSENT is not `false`: an older backend told us nothing, and treating
		// silence as a refusal would withdraw a working control fleet-wide.
		mount(modemWithConfig({}));

		await waitFor(() => expect(autoApnSwitch()).toBeTruthy());
		expect(autoApnSwitch().hasAttribute("disabled")).toBe(false);
		expect(screen.queryByTestId("modem-autoapn-unsupported")).toBeNull();
	});
});

describe("a refused save is REPORTED, never reported as saved", () => {
	it("renders the typed refusal and keeps the dialog open", async () => {
		configure.mockResolvedValue({ success: false, error: "write_failed" });
		mount(modemWithConfig({}));

		await saveChangedApn("ceralive.test.apn");

		const band = await screen.findByTestId("modem-save-refused");
		expect(band.getAttribute("data-refusal")).toBe("write_failed");
		expect(band.getAttribute("role")).toBe("alert");
		// The dialog is still on the settings that did not land.
		expect(autoApnSwitch()).toBeTruthy();
	});

	it("never renders the raw reason token", async () => {
		configure.mockResolvedValue({
			success: false,
			error: "unconfigured_modem",
		});
		mount(modemWithConfig({}));

		await saveChangedApn("ceralive.test.apn");

		const band = await screen.findByTestId("modem-save-refused");
		expect(band.textContent).not.toContain("unconfigured_modem");
		expect(band.textContent).not.toContain("network.modem.saveRefused");
	});

	it("falls back to a rendered reason when the device names none", async () => {
		configure.mockResolvedValue({ success: false });
		mount(modemWithConfig({}));

		await saveChangedApn("ceralive.test.apn");

		const band = await screen.findByTestId("modem-save-refused");
		expect(band.getAttribute("data-refusal")).toBe("write_failed");
	});

	it("shows no band on a save the device accepted", async () => {
		configure.mockResolvedValue({ success: true });
		mount(modemWithConfig({}));

		await saveChangedApn("ceralive.test.apn");

		await waitFor(() => expect(configure).toHaveBeenCalled());
		expect(screen.queryByTestId("modem-save-refused")).toBeNull();
	});
});
