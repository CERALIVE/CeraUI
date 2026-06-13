// @vitest-environment jsdom
/**
 * SimUnlockDialog — SIM PIN unlock UI (Task 23).
 *
 * Drives the dialog against a mocked `unlockSimPin` helper (the Task 22 RPC
 * boundary) and asserts the four terminal-state paths the UI must distinguish:
 *   success      → toast + dialog closes
 *   wrong-pin    → inline error surfaces the remaining attempts; PIN cleared
 *   puk-required → PUK state shown; the PIN field/submit are hidden
 *   locked       → PIN field + submit present, submit gated on a valid PIN
 */

import type {
	Modem,
	SimPukUnlockOutput,
	SimUnlockOutput,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import SimUnlockDialog from "./SimUnlockDialog.svelte";

const unlockSimPin = vi.hoisted(() => vi.fn());
const unlockSimPuk = vi.hoisted(() => vi.fn());

vi.mock("$lib/helpers/NetworkHelper", () => ({
	unlockSimPin,
	unlockSimPuk,
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// AppDialog picks its surface (Dialog vs Sheet) via `new MediaQuery(...)`, which
// reads `window.matchMedia` — absent in jsdom. Stub it to the desktop branch.
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

function makeModem(sim_lock: Modem["sim_lock"]): Modem {
	return {
		ifname: "wwan0",
		name: "Test Modem",
		network_type: { supported: [], active: null },
		sim_lock,
	};
}

const pinInput = () => screen.getByTestId("sim-pin-input") as HTMLInputElement;
const submitButton = () =>
	screen.getByTestId("sim-pin-submit") as HTMLButtonElement;
const pukInput = () => screen.getByTestId("sim-puk-input") as HTMLInputElement;
const newPinInput = () =>
	screen.getByTestId("sim-puk-newpin-input") as HTMLInputElement;
const pukSubmit = () =>
	screen.getByTestId("sim-puk-submit") as HTMLButtonElement;

beforeEach(() => {
	unlockSimPin.mockReset();
	unlockSimPuk.mockReset();
});

describe("SimUnlockDialog — PIN entry (Task 23)", () => {
	it("shows the PIN field + submit for a SIM-PIN-locked modem, submit gated on a valid PIN", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-pin", remainingAttempts: 3 }),
			},
		});

		expect(pinInput()).toBeTruthy();
		// Empty PIN → submit disabled.
		expect(submitButton().disabled).toBe(true);

		// Too-short PIN (< 4 digits) stays disabled.
		fireEvent.input(pinInput(), { target: { value: "12" } });
		expect(submitButton().disabled).toBe(true);

		// A valid 4-digit PIN enables submit.
		fireEvent.input(pinInput(), { target: { value: "1234" } });
		expect(submitButton().disabled).toBe(false);
	});

	it("submits the PIN via unlockSimPin and closes on success", async () => {
		unlockSimPin.mockResolvedValue({
			state: "success",
		} satisfies SimUnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin", remainingAttempts: 3 }),
			},
		});

		fireEvent.input(pinInput(), { target: { value: "4321" } });
		await fireEvent.click(submitButton());

		expect(unlockSimPin).toHaveBeenCalledWith("2", "4321");
		// Success closes the dialog → the PIN field is removed from the DOM.
		await waitFor(() =>
			expect(screen.queryByTestId("sim-pin-input")).toBeNull(),
		);
	});

	it("surfaces the remaining attempts on a wrong PIN without auto-resubmitting", async () => {
		unlockSimPin.mockResolvedValue({
			state: "wrong-pin",
			remainingAttempts: 2,
		} satisfies SimUnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-pin", remainingAttempts: 3 }),
			},
		});

		fireEvent.input(pinInput(), { target: { value: "0000" } });
		await fireEvent.click(submitButton());

		const error = await screen.findByTestId("sim-pin-error");
		expect(error.textContent).toContain("2");
		// Exactly one submit — never a blind resubmit.
		expect(unlockSimPin).toHaveBeenCalledTimes(1);
		// The PIN field is cleared so the next attempt is deliberate.
		expect(pinInput().value).toBe("");
		// Dialog stays open (still locked).
		expect(screen.queryByTestId("sim-pin-input")).not.toBeNull();
	});

	it("shows the PUK-required state with no PIN field for a PUK-locked SIM", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk" }),
			},
		});

		expect(screen.getByTestId("sim-puk-required")).toBeTruthy();
		// A PIN cannot clear a PUK lock — the entry field and submit are hidden.
		expect(screen.queryByTestId("sim-pin-input")).toBeNull();
		expect(screen.queryByTestId("sim-pin-submit")).toBeNull();
		expect(unlockSimPin).not.toHaveBeenCalled();
	});
});

describe("SimUnlockDialog — PUK recovery", () => {
	it("shows the PUK + new-PIN fields and the attempts counter, submit gated on valid input", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 10 }),
			},
		});

		expect(pukInput()).toBeTruthy();
		expect(newPinInput()).toBeTruthy();
		// The PIN-only flow is not rendered for a PUK lock.
		expect(screen.queryByTestId("sim-pin-input")).toBeNull();
		// Remaining PUK attempts are surfaced.
		expect(screen.getByTestId("sim-puk-attempts").textContent).toContain("10");

		// Empty → submit disabled.
		expect(pukSubmit().disabled).toBe(true);
		// A too-short PUK (< 8 digits) keeps submit disabled even with a valid PIN.
		fireEvent.input(pukInput(), { target: { value: "1234567" } });
		fireEvent.input(newPinInput(), { target: { value: "1234" } });
		expect(pukSubmit().disabled).toBe(true);
		// A full 8-digit PUK + valid new PIN enables submit.
		fireEvent.input(pukInput(), { target: { value: "12345678" } });
		expect(pukSubmit().disabled).toBe(false);
	});

	it("submits the PUK + new PIN via unlockSimPuk and closes on success", async () => {
		unlockSimPuk.mockResolvedValue({
			success: true,
		} satisfies SimPukUnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "1",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 10 }),
			},
		});

		fireEvent.input(pukInput(), { target: { value: "12345678" } });
		fireEvent.input(newPinInput(), { target: { value: "4321" } });
		await fireEvent.click(pukSubmit());

		expect(unlockSimPuk).toHaveBeenCalledWith("1", "12345678", "4321");
		await waitFor(() =>
			expect(screen.queryByTestId("sim-puk-input")).toBeNull(),
		);
	});

	it("surfaces the decremented PUK attempts on a wrong PUK without resubmitting", async () => {
		unlockSimPuk.mockResolvedValue({
			success: false,
			error: "wrong-puk",
			remainingAttempts: 9,
		} satisfies SimPukUnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 10 }),
			},
		});

		fireEvent.input(pukInput(), { target: { value: "00000000" } });
		fireEvent.input(newPinInput(), { target: { value: "4321" } });
		await fireEvent.click(pukSubmit());

		expect(await screen.findByTestId("sim-puk-error")).toBeTruthy();
		// The counter reflects the decremented remaining-attempt count.
		await waitFor(() =>
			expect(screen.getByTestId("sim-puk-attempts").textContent).toContain("9"),
		);
		// Submitted exactly once — never a blind resubmit toward a lockout.
		expect(unlockSimPuk).toHaveBeenCalledTimes(1);
		// The PUK field is cleared so the next attempt is deliberate.
		expect(pukInput().value).toBe("");
		// Dialog stays open (still PUK-locked).
		expect(screen.queryByTestId("sim-puk-input")).not.toBeNull();
	});

	it("shows the permanent lockout state when the PUK attempts hit zero", async () => {
		unlockSimPuk.mockResolvedValue({
			success: false,
			error: "locked",
			remainingAttempts: 0,
		} satisfies SimPukUnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 1 }),
			},
		});

		fireEvent.input(pukInput(), { target: { value: "00000000" } });
		fireEvent.input(newPinInput(), { target: { value: "4321" } });
		await fireEvent.click(pukSubmit());

		expect(await screen.findByTestId("sim-puk-locked")).toBeTruthy();
		// The recovery form and its submit are gone — the SIM is bricked.
		expect(screen.queryByTestId("sim-puk-input")).toBeNull();
		expect(screen.queryByTestId("sim-puk-submit")).toBeNull();
	});

	it("hands off from the PIN flow to the PUK form when a wrong PIN exhausts attempts", async () => {
		unlockSimPin.mockResolvedValue({
			state: "puk-required",
		} satisfies SimUnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-pin", remainingAttempts: 1 }),
			},
		});

		fireEvent.input(pinInput(), { target: { value: "0000" } });
		await fireEvent.click(submitButton());

		// The dialog switches from the PIN entry to the PUK recovery form.
		await waitFor(() =>
			expect(screen.queryByTestId("sim-puk-input")).not.toBeNull(),
		);
		expect(screen.queryByTestId("sim-pin-input")).toBeNull();
	});
});
