// @vitest-environment jsdom
/**
 * PowerDialog — native-feel async state for reboot / poweroff (Todo 14, S7).
 *
 * Both destructive power actions now route through the keyed async-operation
 * machine (`osCommand`), which owns the re-entry guard, the in-flight `pending`
 * phase, and the single failure-feedback toast. These tests drive the real dialog
 * against a mocked `rpc.system.*` (the real osCommand runs — it is NOT mocked) and
 * assert the three contract points the task requires per action:
 *   in-flight  → a second dispatch while the first is in flight is blocked
 *   success    → reboot hands off to the rebooting banner; poweroff closes
 *   failure    → a refused op surfaces an error toast AND releases re-entry
 */
import { getLL } from "@ceraui/i18n/svelte";
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

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import PowerDialog from "./PowerDialog.svelte";

const state = vi.hoisted(() => ({
	streaming: false,
	updating: false as boolean,
	connected: true,
	rebooting: false,
}));

const markRebooting = vi.hoisted(() => vi.fn());
const clearRebooting = vi.hoisted(() => vi.fn());
const rebootRpc = vi.hoisted(() => vi.fn());
const poweroffRpc = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { reboot: rebootRpc, poweroff: poweroffRpc } },
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
	toast: { error: toastError, success: vi.fn() },
}));

const L = getLL();
const POWER_TITLE = L.settings.index.power();
const CONFIRM_TITLE = L.dialogs.areYouSure();
const REBOOT_LABEL = L.advanced.reboot();
const POWEROFF_LABEL = L.advanced.powerOff();

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function confirm(label: string): Promise<void> {
	const powerDialog = screen.getByRole("dialog", { name: POWER_TITLE });
	await fireEvent.click(
		within(powerDialog).getByRole("button", { name: label, exact: true }),
	);
	const confirmDialog = screen.getByRole("dialog", { name: CONFIRM_TITLE });
	await fireEvent.click(
		within(confirmDialog).getByRole("button", { name: label, exact: true }),
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
	state.streaming = false;
	state.updating = false;
	state.connected = true;
	state.rebooting = false;
	markRebooting.mockClear();
	clearRebooting.mockClear();
	rebootRpc.mockReset();
	poweroffRpc.mockReset();
	toastError.mockClear();
	// Warm the async-operation store up front (as main.ts does) so the `busy`
	// derived wires to the live registry instead of lazily creating it mid-render.
	initAsyncOperations();
});

afterEach(() => {
	// Reset the keyed async-operation singleton so a lingering phase from one test
	// never bleeds re-entry state into the next.
	destroyAsyncOperations();
});

describe("PowerDialog — reboot async state", () => {
	it("blocks a re-entrant reboot while the first dispatch is in flight", async () => {
		const d = deferred<{ success: boolean }>();
		rebootRpc.mockReturnValueOnce(d.promise);
		rebootRpc.mockResolvedValue({ success: true });

		render(PowerDialog, { props: { open: true } });

		await confirm(REBOOT_LABEL); // dispatch 1 — left in flight (deferred)
		await Promise.resolve();
		expect(rebootRpc).toHaveBeenCalledOnce();

		// A second confirm while the first is still pending must NOT dispatch again.
		await confirm(REBOOT_LABEL);
		await Promise.resolve();
		expect(rebootRpc).toHaveBeenCalledOnce();

		// Resolving the first dispatch hands off to the rebooting banner exactly once.
		d.resolve({ success: true });
		await waitFor(() => expect(markRebooting).toHaveBeenCalledOnce());
	});

	it("surfaces a failure and releases re-entry when a reboot is refused", async () => {
		rebootRpc.mockResolvedValue({ success: false });

		render(PowerDialog, { props: { open: true } });

		await confirm(REBOOT_LABEL);
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		// A refused op never advances to the rebooting banner.
		expect(markRebooting).not.toHaveBeenCalled();

		// Re-entry was released by the failure → a retry dispatches again.
		await confirm(REBOOT_LABEL);
		await waitFor(() => expect(rebootRpc).toHaveBeenCalledTimes(2));
	});
});

describe("PowerDialog — poweroff async state", () => {
	it("dispatches poweroff and does not mark rebooting on success", async () => {
		poweroffRpc.mockResolvedValue({ success: true });

		render(PowerDialog, { props: { open: true } });

		await confirm(POWEROFF_LABEL);
		await waitFor(() => expect(poweroffRpc).toHaveBeenCalledOnce());
		// A powered-off device never returns — the rebooting banner is never armed.
		expect(markRebooting).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("surfaces a failure and releases re-entry when poweroff is refused", async () => {
		poweroffRpc.mockResolvedValue({ success: false });

		render(PowerDialog, { props: { open: true } });

		await confirm(POWEROFF_LABEL);
		await waitFor(() => expect(toastError).toHaveBeenCalled());

		await confirm(POWEROFF_LABEL);
		await waitFor(() => expect(poweroffRpc).toHaveBeenCalledTimes(2));
	});
});
