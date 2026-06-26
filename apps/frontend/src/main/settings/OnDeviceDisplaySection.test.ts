// @vitest-environment jsdom
/**
 * OnDeviceDisplaySection — native-feel async state for the 4 kiosk actions
 * (Todo 14, S7): kioskStart, kioskStop, kioskConfigure, kioskOsk.
 *
 * Each kiosk mutation routes through the keyed async-operation machine
 * (`osCommand`) for the re-entry guard + in-flight `pending` phase, while keeping
 * the existing calm emulated-mode banner (never an error toast). These tests drive
 * the real component against a mocked `rpc.system.*` (the real osCommand runs) and
 * assert in-flight, success, and failure-releases-re-entry per action.
 */
import { getLL } from "@ceraui/i18n/svelte";
import { KIOSK_UNAVAILABLE_ERROR } from "@ceraui/rpc/schemas";
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

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import OnDeviceDisplaySection from "./OnDeviceDisplaySection.svelte";

const rpcMocks = vi.hoisted(() => ({
	kioskStart: vi.fn(),
	kioskStop: vi.fn(),
	kioskConfigure: vi.fn(),
	kioskOsk: vi.fn(),
	kioskStatus: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			kioskStart: rpcMocks.kioskStart,
			kioskStop: rpcMocks.kioskStop,
			kioskConfigure: rpcMocks.kioskConfigure,
			kioskOsk: rpcMocks.kioskOsk,
			kioskStatus: rpcMocks.kioskStatus,
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	// undefined → the reconcile $effect early-returns; onMount seeds from kioskStatus.
	getKiosk: () => undefined,
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

const t = getLL().settings.onDeviceDisplay;
const TOUCH_LABEL = t.touch();
const SHOW_KB_LABEL = t.showKeyboard();
const HIDE_KB_LABEL = t.hideKeyboard();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function seedStatus(
	overrides: Partial<{
		enabled: boolean;
		state: string;
		display: string;
		touch: boolean;
		motion: boolean;
		performance: string;
	}> = {},
): void {
	rpcMocks.kioskStatus.mockResolvedValue({
		enabled: false,
		state: "disabled",
		display: "lcd",
		touch: true,
		motion: true,
		performance: "balanced",
		...overrides,
	});
}

const enableSwitch = () =>
	screen.getByTestId("kiosk-enable-switch") as HTMLButtonElement;

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

beforeEach(() => {
	vi.clearAllMocks();
	// Warm the keyed async-operation store up front (as main.ts does at startup)
	// so a component `$derived` reading getOperationPhase wires to the live
	// registry instead of lazily creating the store mid-render.
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("OnDeviceDisplaySection — kiosk enable (kioskStart)", () => {
	it("shows in-flight (switch disabled), blocks re-entry, then applies on success", async () => {
		const d = deferred<{
			success: boolean;
			applied: { enabled: boolean; state: string };
		}>();
		rpcMocks.kioskStart.mockReturnValueOnce(d.promise);
		seedStatus();

		render(OnDeviceDisplaySection, { props: { open: true } });
		await waitFor(() => expect(enableSwitch().disabled).toBe(false));

		await fireEvent.click(enableSwitch()); // dispatch 1 → in flight
		await Promise.resolve();
		expect(rpcMocks.kioskStart).toHaveBeenCalledOnce();
		// In-flight: the pessimistic switch is disabled while the RPC is pending.
		await waitFor(() => expect(enableSwitch().disabled).toBe(true));

		// A re-entrant toggle while pending must not dispatch a second start.
		await fireEvent.click(enableSwitch());
		await Promise.resolve();
		expect(rpcMocks.kioskStart).toHaveBeenCalledOnce();

		d.resolve({
			success: true,
			applied: { enabled: true, state: "enabled-running" },
		});
		await waitFor(() =>
			expect(screen.getByTestId("kiosk-state-label").textContent).toBe(
				t.states.enabledRunning(),
			),
		);
		expect(enableSwitch().getAttribute("aria-checked")).toBe("true");
	});

	it("surfaces the calm unavailable banner and reverts on an emulated-mode refusal", async () => {
		rpcMocks.kioskStart.mockResolvedValue({
			success: false,
			error: KIOSK_UNAVAILABLE_ERROR,
		});
		seedStatus();

		render(OnDeviceDisplaySection, { props: { open: true } });
		await waitFor(() => expect(enableSwitch().disabled).toBe(false));

		await fireEvent.click(enableSwitch());

		// Calm banner (NOT an error toast), and the switch reverts to off.
		await screen.findByTestId("kiosk-unavailable");
		expect(toastError).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(enableSwitch().getAttribute("aria-checked")).toBe("false"),
		);

		// Re-entry was released → another toggle dispatches again.
		await fireEvent.click(enableSwitch());
		await waitFor(() => expect(rpcMocks.kioskStart).toHaveBeenCalledTimes(2));
	});
});

describe("OnDeviceDisplaySection — kiosk disable (kioskStop)", () => {
	it("applies the stopped state on success", async () => {
		rpcMocks.kioskStop.mockResolvedValue({
			success: true,
			applied: { enabled: false, state: "disabled" },
		});
		seedStatus({ enabled: true, state: "enabled-running" });

		render(OnDeviceDisplaySection, { props: { open: true } });
		await waitFor(() =>
			expect(enableSwitch().getAttribute("aria-checked")).toBe("true"),
		);

		await fireEvent.click(enableSwitch());

		await waitFor(() => expect(rpcMocks.kioskStop).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(screen.getByTestId("kiosk-state-label").textContent).toBe(
				t.states.disabled(),
			),
		);
	});
});

describe("OnDeviceDisplaySection — kiosk configure (kioskConfigure)", () => {
	it("dispatches kioskConfigure on a touch-mode change and adopts the applied value", async () => {
		rpcMocks.kioskConfigure.mockResolvedValue({
			success: true,
			applied: {
				display: "lcd",
				touch: false,
				motion: true,
				performance: "balanced",
			},
		});
		seedStatus({ touch: true });

		render(OnDeviceDisplaySection, { props: { open: true } });
		const touch = await screen.findByRole("switch", { name: TOUCH_LABEL });

		await fireEvent.click(touch);

		await waitFor(() =>
			expect(rpcMocks.kioskConfigure).toHaveBeenCalledWith(
				expect.objectContaining({ touch: false }),
			),
		);
	});

	it("shows the calm banner (no toast) when configure is refused in emulated mode", async () => {
		rpcMocks.kioskConfigure.mockResolvedValue({
			success: false,
			error: KIOSK_UNAVAILABLE_ERROR,
		});
		seedStatus({ touch: true });

		render(OnDeviceDisplaySection, { props: { open: true } });
		const touch = await screen.findByRole("switch", { name: TOUCH_LABEL });

		await fireEvent.click(touch);

		await screen.findByTestId("kiosk-unavailable");
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe("OnDeviceDisplaySection — on-screen keyboard (kioskOsk)", () => {
	it("shows in-flight (buttons disabled), blocks re-entry, then settles on success", async () => {
		const d = deferred<{ success: boolean }>();
		rpcMocks.kioskOsk.mockReturnValueOnce(d.promise);
		// isRunning gates the OSK buttons — seed the running state.
		seedStatus({ enabled: true, state: "enabled-running" });

		render(OnDeviceDisplaySection, { props: { open: true } });
		const showBtn = (await screen.findByRole("button", {
			name: SHOW_KB_LABEL,
		})) as HTMLButtonElement;
		const hideBtn = screen.getByRole("button", {
			name: HIDE_KB_LABEL,
		}) as HTMLButtonElement;
		await waitFor(() => expect(showBtn.disabled).toBe(false));

		await fireEvent.click(showBtn); // dispatch 1 → in flight
		await Promise.resolve();
		expect(rpcMocks.kioskOsk).toHaveBeenCalledOnce();
		// In-flight: BOTH keyboard buttons are disabled (oskBusy).
		await waitFor(() => expect(showBtn.disabled).toBe(true));
		expect(hideBtn.disabled).toBe(true);

		// Re-entrant click while pending is blocked.
		await fireEvent.click(showBtn);
		await Promise.resolve();
		expect(rpcMocks.kioskOsk).toHaveBeenCalledOnce();

		d.resolve({ success: true });
		await waitFor(() => expect(showBtn.disabled).toBe(false));
	});

	it("surfaces the calm banner and releases re-entry on a refusal", async () => {
		rpcMocks.kioskOsk.mockResolvedValue({
			success: false,
			error: KIOSK_UNAVAILABLE_ERROR,
		});
		seedStatus({ enabled: true, state: "enabled-running" });

		render(OnDeviceDisplaySection, { props: { open: true } });
		const showBtn = (await screen.findByRole("button", {
			name: SHOW_KB_LABEL,
		})) as HTMLButtonElement;
		await waitFor(() => expect(showBtn.disabled).toBe(false));

		await fireEvent.click(showBtn);
		await screen.findByTestId("kiosk-unavailable");
		expect(toastError).not.toHaveBeenCalled();

		// Re-entry released → a second signal dispatches again.
		await waitFor(() => expect(showBtn.disabled).toBe(false));
		await fireEvent.click(showBtn);
		await waitFor(() => expect(rpcMocks.kioskOsk).toHaveBeenCalledTimes(2));
	});
});
