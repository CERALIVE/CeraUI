// @vitest-environment jsdom
/**
 * SimUnlockDialog — SIM PIN unlock UI (Task 23).
 *
 * Drives the dialog against a mocked `rpc.modems.unlockSim` (the RPC boundary the
 * dialog now dispatches through via osCommand) and asserts the four terminal-
 * state paths the UI must distinguish:
 *   success      → toast + dialog closes
 *   wrong-pin    → inline error surfaces the remaining attempts; PIN cleared
 *   puk-required → PUK state shown; the PIN field/submit are hidden
 *   locked       → PIN field + submit present, submit gated on a valid PIN
 */

import type {
	Modem,
	SimPin2UnlockOutput,
	SimPukUnlockOutput,
	SimUnlockOutput,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import SimUnlockDialog from "./SimUnlockDialog.svelte";

// The dialog now dispatches the SIM unlock RPCs directly (via osCommand), so the
// test seam moves from the NetworkHelper wrappers to `rpc.modems.*`.
const unlockSim = vi.hoisted(() => vi.fn());
const unlockSimPuk = vi.hoisted(() => vi.fn());
const unlockSimPin2 = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			unlockSim,
			unlockSimPuk,
			unlockSimPin2,
		},
	},
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
const pin2Input = () =>
	screen.getByTestId("sim-pin2-input") as HTMLInputElement;
const pin2Submit = () =>
	screen.getByTestId("sim-pin2-submit") as HTMLButtonElement;

beforeEach(() => {
	unlockSim.mockReset();
	unlockSimPuk.mockReset();
	unlockSimPin2.mockReset();
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

	it("submits the PIN via rpc.modems.unlockSim and closes on success", async () => {
		unlockSim.mockResolvedValue({
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

		expect(unlockSim).toHaveBeenCalledWith({ modemPath: "2", pin: "4321" });
		// Success closes the dialog → the PIN field is removed from the DOM.
		await waitFor(() =>
			expect(screen.queryByTestId("sim-pin-input")).toBeNull(),
		);
	});

	it("surfaces the remaining attempts on a wrong PIN without auto-resubmitting", async () => {
		unlockSim.mockResolvedValue({
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
		expect(unlockSim).toHaveBeenCalledTimes(1);
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
		expect(unlockSim).not.toHaveBeenCalled();
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

		expect(unlockSimPuk).toHaveBeenCalledWith({
			modemPath: "1",
			puk: "12345678",
			newPin: "4321",
		});
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

	it("disables submit when the SIM opens with 0 PUK retries remaining", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 0 }),
			},
		});

		// Even a fully valid PUK + new PIN cannot be submitted — the next wrong
		// PUK would brick the SIM, so submit stays disabled at zero retries.
		fireEvent.input(pukInput(), { target: { value: "12345678" } });
		fireEvent.input(newPinInput(), { target: { value: "4321" } });
		expect(pukSubmit().disabled).toBe(true);
	});

	it("warns (status-error styling) on the retry counter at <= 2 remaining", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 2 }),
			},
		});

		const attempts = screen.getByTestId("sim-puk-attempts");
		expect(attempts.textContent).toContain("2");
		// The low-retries warning is the status-error color on the count.
		expect(attempts.querySelector(".text-status-error")).not.toBeNull();
	});

	it("does NOT warn on the retry counter above 2 remaining", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "0",
				modem: makeModem({ required: "sim-puk", remainingAttempts: 3 }),
			},
		});

		const attempts = screen.getByTestId("sim-puk-attempts");
		expect(attempts.textContent).toContain("3");
		expect(attempts.querySelector(".text-status-error")).toBeNull();
	});

	it("hands off from the PIN flow to the PUK form when a wrong PIN exhausts attempts", async () => {
		unlockSim.mockResolvedValue({
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

/**
 * PIN2 is a DIFFERENT credential from the SIM PIN, and the dialog's job here is
 * to make that unmistakable. These tests pin both halves: that the PIN2 code
 * reaches the PIN2 procedure (never `unlockSim`, which would spend a PIN1
 * attempt and walk a working SIM toward a PUK1 lockout), and that the copy the
 * operator reads does not describe their data connection as blocked.
 */
describe("SimUnlockDialog — PIN2 (Fixed Dialling Number) entry", () => {
	it("renders the PIN2 field, not the PIN1 field, for a sim-pin2 lock", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 3 }),
			},
		});

		expect(pin2Input()).toBeTruthy();
		expect(screen.queryByTestId("sim-pin-input")).toBeNull();
		expect(screen.queryByTestId("sim-puk-input")).toBeNull();
	});

	it("submits through unlockSimPin2 and NEVER through unlockSim", async () => {
		unlockSimPin2.mockResolvedValue({
			state: "success",
		} satisfies SimPin2UnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 3 }),
			},
		});

		fireEvent.input(pin2Input(), { target: { value: "1111" } });
		await fireEvent.click(pin2Submit());

		expect(unlockSimPin2).toHaveBeenCalledWith({
			modemPath: "2",
			pin2: "1111",
		});
		// The conflation guard: a PIN2 code must never reach the PIN1 procedure.
		expect(unlockSim).not.toHaveBeenCalled();
		expect(unlockSimPuk).not.toHaveBeenCalled();

		await waitFor(() =>
			expect(screen.queryByTestId("sim-pin2-input")).toBeNull(),
		);
	});

	it("leads with PIN2-specific copy, never the PIN1 'SIM is locked' sentence", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 3 }),
			},
		});

		// Paraglide may resolve to the message KEY or to the resolved COPY here,
		// depending on whether another spec in the run activated the namespace —
		// so this asserts only what is true either way. The copy itself is swept
		// across all 10 locales in `src/tests/sim-pin2-copy.test.ts`.
		const explainer = screen.getByTestId("sim-pin2-explainer");
		expect((explainer.textContent ?? "").trim().length).toBeGreaterThan(0);

		// The PIN1 description ("This SIM card is locked. Enter its PIN…") must
		// not reach a PIN2 operator, in either resolution form.
		const body = document.body.textContent ?? "";
		expect(body).not.toContain("simUnlock.description");
		expect(body.toLowerCase()).not.toContain("sim card is locked");
	});

	it("gates submit on a valid PIN2 length", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 3 }),
			},
		});

		expect(pin2Submit().disabled).toBe(true);
		fireEvent.input(pin2Input(), { target: { value: "11" } });
		expect(pin2Submit().disabled).toBe(true);
		fireEvent.input(pin2Input(), { target: { value: "1111" } });
		expect(pin2Submit().disabled).toBe(false);
	});

	it("surfaces the remaining PIN2 attempts without auto-resubmitting", async () => {
		unlockSimPin2.mockResolvedValue({
			state: "wrong-pin2",
			remainingAttempts: 2,
		} satisfies SimPin2UnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 3 }),
			},
		});

		fireEvent.input(pin2Input(), { target: { value: "9999" } });
		await fireEvent.click(pin2Submit());

		await waitFor(() =>
			expect(screen.queryByTestId("sim-pin2-error")).not.toBeNull(),
		);
		expect(screen.getByTestId("sim-pin2-attempts").textContent).toContain("2");
		// Exactly one submit — a blind resubmit walks the SIM toward PUK2.
		expect(unlockSimPin2).toHaveBeenCalledTimes(1);
		expect(pin2Input().value).toBe("");
	});

	it("withdraws the form on a puk2-required terminal", async () => {
		unlockSimPin2.mockResolvedValue({
			state: "puk2-required",
		} satisfies SimPin2UnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 1 }),
			},
		});

		fireEvent.input(pin2Input(), { target: { value: "9999" } });
		await fireEvent.click(pin2Submit());

		await waitFor(() =>
			expect(screen.queryByTestId("sim-pin2-puk2-required")).not.toBeNull(),
		);
		expect(screen.queryByTestId("sim-pin2-input")).toBeNull();
		expect(screen.queryByTestId("sim-pin2-submit")).toBeNull();
	});

	it("states the modem has no PIN2 route rather than inviting a doomed retry", async () => {
		unlockSimPin2.mockResolvedValue({
			state: "unsupported",
		} satisfies SimPin2UnlockOutput);

		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-pin2", remainingAttempts: 3 }),
			},
		});

		fireEvent.input(pin2Input(), { target: { value: "1111" } });
		await fireEvent.click(pin2Submit());

		await waitFor(() =>
			expect(screen.queryByTestId("sim-pin2-unsupported")).not.toBeNull(),
		);
		expect(screen.queryByTestId("sim-pin2-submit")).toBeNull();
	});

	it("yields to the PUK branch when the lock has already become sim-puk2", () => {
		render(SimUnlockDialog, {
			props: {
				open: true,
				deviceId: "2",
				modem: makeModem({ required: "sim-puk2", remainingAttempts: 10 }),
			},
		});

		expect(screen.queryByTestId("sim-puk-input")).not.toBeNull();
		expect(screen.queryByTestId("sim-pin2-input")).toBeNull();
	});
});
