// @vitest-environment jsdom
/**
 * SimUnlockDialog — a NESTED unlock returns to the dialog it was opened from.
 *
 * Todo 46 split the routing: a BLOCKING lock (`sim-pin`/`sim-puk`) opens this
 * dialog straight from the modem's own row, while a non-blocking PIN2 is
 * reached from the lock band INSIDE `ModemConfigDialog`. Closing the nested one
 * dropped the operator all the way back to the Network page, having silently
 * discarded the settings dialog they were in the middle of — a PIN2 is a
 * sub-setting of that modem's settings, so leaving it must go back one step.
 *
 * Every close route is covered, because on a kiosk touchscreen the footer
 * button is the LEAST used of them: ESC, the header X, an overlay click and the
 * success path all close through the same `open` binding, which is exactly why
 * the return hangs off that edge rather than off one button's handler.
 */

import type { Modem, SimUnlockOutput } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import SimUnlockDialog from "./SimUnlockDialog.svelte";

const unlockSim = vi.hoisted(() => vi.fn());
const unlockSimPuk = vi.hoisted(() => vi.fn());
const unlockSimPin2 = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { unlockSim, unlockSimPuk, unlockSimPin2 } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

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

const PIN2_LOCK = { required: "sim-pin2", remainingAttempts: 3 } as const;
const PIN_LOCK = { required: "sim-pin", remainingAttempts: 3 } as const;

function mountNested(onBack: () => void) {
	return render(SimUnlockDialog, {
		props: {
			open: true,
			deviceId: "2",
			modem: makeModem({ ...PIN2_LOCK }),
			onBack,
		},
	});
}

/** The dismiss action — "Close" standalone, "Back to modem settings" nested. */
function footerAction(): HTMLButtonElement {
	return screen.getByTestId("sim-unlock-dismiss") as HTMLButtonElement;
}

beforeEach(() => {
	unlockSim.mockReset();
	unlockSimPuk.mockReset();
	unlockSimPin2.mockReset();
});

describe("nested — closing returns to the parent dialog", () => {
	it("returns when the footer action is pressed", async () => {
		const onBack = vi.fn();
		mountNested(onBack);

		await fireEvent.click(footerAction());

		await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
	});

	it("labels that action as a way BACK, not as a plain Close", () => {
		mountNested(vi.fn());

		expect(footerAction().textContent?.trim()).not.toBe("Close");
	});

	it("returns when the dialog is closed by any other route", async () => {
		const onBack = vi.fn();
		const { rerender } = mountNested(onBack);

		// ESC, the header X and an overlay click all land here: bits-ui closes the
		// dialog through the same `open` binding.
		await rerender({
			open: false,
			deviceId: "2",
			modem: makeModem({ ...PIN2_LOCK }),
			onBack,
		});

		await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
	});

	it("returns exactly ONCE, not on every later render", async () => {
		const onBack = vi.fn();
		const { rerender } = mountNested(onBack);
		const closed = {
			open: false,
			deviceId: "2",
			modem: makeModem({ ...PIN2_LOCK }),
			onBack,
		};

		await rerender(closed);
		await rerender({ ...closed });

		await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
	});

	it("does not return before the operator has closed anything", async () => {
		const onBack = vi.fn();
		mountNested(onBack);

		await waitFor(() =>
			expect(screen.getByTestId("sim-pin2-input")).toBeTruthy(),
		);
		expect(onBack).not.toHaveBeenCalled();
	});

	it("returns after a SUCCESSFUL unlock closes the dialog itself", async () => {
		unlockSimPin2.mockResolvedValue({ state: "success" });
		const onBack = vi.fn();
		mountNested(onBack);

		await fireEvent.input(screen.getByTestId("sim-pin2-input"), {
			target: { value: "1234" },
		});
		await fireEvent.click(screen.getByTestId("sim-pin2-submit"));

		await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
	});
});

describe("standalone — closing closes fully, exactly as before", () => {
	it("keeps the plain Close action when there is nowhere to go back to", () => {
		render(SimUnlockDialog, {
			props: { open: true, deviceId: "0", modem: makeModem({ ...PIN_LOCK }) },
		});

		expect(footerAction().textContent?.trim()).toBe("Close");
	});

	it("closing invokes no return, because none was offered", async () => {
		unlockSim.mockResolvedValue({
			state: "success",
		} satisfies SimUnlockOutput);
		const { rerender } = render(SimUnlockDialog, {
			props: { open: true, deviceId: "0", modem: makeModem({ ...PIN_LOCK }) },
		});

		await rerender({
			open: false,
			deviceId: "0",
			modem: makeModem({ ...PIN_LOCK }),
		});

		// The property is that a standalone mount takes no `onBack` at all, so the
		// close path is byte-identical to the pre-change behaviour: the dialog is
		// simply gone, and closing it raised nothing.
		expect(screen.queryByTestId("sim-unlock-dismiss")).toBeNull();
	});
});
