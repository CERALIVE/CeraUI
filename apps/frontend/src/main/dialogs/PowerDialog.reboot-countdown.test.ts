// @vitest-environment jsdom
/**
 * PowerDialog — reboot countdown + failure recovery (T14).
 *
 * A reboot that returns `{success:true}` but never takes the device down leaves
 * the "rebooting" banner latched forever. This dialog now runs an in-dialog
 * countdown over the reconnect window; if the socket is STILL connected when it
 * elapses, the reboot never happened, so it clears the misleading latch and
 * surfaces a calm recovery hint with a retry. These tests drive the real dialog
 * (mocked RPC + connection store) through that state machine. The reconnect
 * SUCCESS path (latch clears → dialog closes) needs the reactive store and is
 * proven end-to-end in the e2e spec, not here.
 */
import { getLL } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import PowerDialog from "./PowerDialog.svelte";

const state = vi.hoisted(() => ({
	streaming: false,
	updating: false as boolean | { result: number },
	connected: true,
	rebooting: true,
	rebootResult: { success: true } as { success: boolean },
}));

const markRebooting = vi.hoisted(() => vi.fn());
const clearRebooting = vi.hoisted(() => vi.fn());
const rebootRpc = vi.hoisted(() => vi.fn(async () => state.rebootResult));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			reboot: rebootRpc,
			poweroff: vi.fn(async () => ({ success: true })),
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: () => state.streaming,
	getUpdating: () => state.updating,
	getIsConnected: () => state.connected,
}));

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	markRebooting,
	clearRebooting,
	getIsRebooting: () => state.rebooting,
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const L = getLL();
const POWER_TITLE = L.settings.index.power();
const CONFIRM_TITLE = L.dialogs.areYouSure();
const REBOOT_LABEL = L.advanced.reboot();

const phase = (name: string) =>
	document.querySelector(`[data-reboot-phase="${name}"]`);

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
	state.streaming = false;
	state.updating = false;
	state.connected = true;
	state.rebooting = true;
	state.rebootResult = { success: true };
	markRebooting.mockClear();
	clearRebooting.mockClear();
	rebootRpc.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

async function confirmReboot(): Promise<void> {
	const powerDialog = screen.getByRole("dialog", { name: POWER_TITLE });
	await fireEvent.click(
		within(powerDialog).getByRole("button", {
			name: REBOOT_LABEL,
			exact: true,
		}),
	);
	const confirmDialog = screen.getByRole("dialog", { name: CONFIRM_TITLE });
	await fireEvent.click(
		within(confirmDialog).getByRole("button", {
			name: REBOOT_LABEL,
			exact: true,
		}),
	);
}

describe("PowerDialog — reboot countdown then still-reachable recovery", () => {
	it("runs a countdown after confirming, then shows the recovery hint when still connected", async () => {
		vi.useFakeTimers();
		render(PowerDialog, { props: { open: true, countdownSeconds: 3 } });

		await confirmReboot();
		// Flush the awaited reboot RPC microtask → markRebooting + countdown start.
		await vi.advanceTimersByTimeAsync(0);

		expect(rebootRpc).toHaveBeenCalledOnce();
		expect(markRebooting).toHaveBeenCalledOnce();
		expect(phase("counting")).not.toBeNull();
		expect(
			screen.getByText(L.settings.dialogs.rebootCountdownTitle()),
		).toBeTruthy();
		// The countdown shows whole seconds remaining, sourced from i18n.
		expect(
			screen.getByText(
				L.settings.dialogs.rebootCountdownRemaining({ seconds: 3 }),
			),
		).toBeTruthy();

		// The reconnect window elapses while the socket is STILL connected: the
		// reboot never happened → clear the latch and offer recovery.
		await vi.advanceTimersByTimeAsync(3000);

		expect(phase("counting")).toBeNull();
		expect(phase("recovery")).not.toBeNull();
		expect(clearRebooting).toHaveBeenCalled();
		expect(
			screen.getByText(L.settings.dialogs.rebootRecoveryTitle()),
		).toBeTruthy();
	});

	it("retries the reboot from the recovery hint", async () => {
		vi.useFakeTimers();
		render(PowerDialog, { props: { open: true, countdownSeconds: 2 } });

		await confirmReboot();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2000);
		expect(phase("recovery")).not.toBeNull();

		const recovery = phase("recovery") as HTMLElement;
		await fireEvent.click(
			within(recovery).getByRole("button", {
				name: L.settings.dialogs.rebootRecoveryRetry(),
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		// Retry re-dispatches the reboot and re-enters the countdown.
		expect(rebootRpc).toHaveBeenCalledTimes(2);
		expect(phase("counting")).not.toBeNull();
	});
});

describe("PowerDialog — streaming block is preserved", () => {
	it("disables the reboot action and surfaces the blocked reason while streaming", () => {
		state.streaming = true;
		render(PowerDialog, { props: { open: true } });

		const powerDialog = screen.getByRole("dialog", { name: POWER_TITLE });
		const rebootButton = within(powerDialog).getByRole("button", {
			name: REBOOT_LABEL,
			exact: true,
		}) as HTMLButtonElement;

		expect(rebootButton.disabled).toBe(true);
		expect(
			screen.getByText(L.settings.dialogs.blockedStreaming()),
		).toBeTruthy();
		// No countdown is reachable while blocked.
		expect(phase("counting")).toBeNull();
	});
});
