// @vitest-environment jsdom
/**
 * CloudRemoteDialog — consolidated single "Cloud" dialog (T9).
 *
 * Verifies that the merged dialog:
 *   • renders the pairing section with the PRODUCTION `complete-pairing` action,
 *     QR, and subscription-standing badge (and keeps the DEV-only simulate path);
 *   • shows the remote key READ-ONLY only when the selected provider is the
 *     active provider AND the device is paired to that managed cloud;
 *   • keeps the key EDITABLE (and required-before-save) for a different managed
 *     provider, a custom provider, and an unpaired device — the cross-provider
 *     clobber guard;
 *   • preselects a deep-linked provider with an EMPTY key;
 *   • saves through `saveRemoteConfig` unchanged.
 */
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

import CloudRemoteDialog from "./CloudRemoteDialog.svelte";

interface MockConfig {
	remote_provider?: string;
	remote_key?: string;
	custom_provider?: { name?: string; host?: string; secure?: boolean };
}

interface MockPairing {
	code: string | null;
	serial: string | null;
	status: string;
	expired: boolean;
	remainingLabel: string;
	deviceId: string | null;
	subStatus: string | null;
}

const state = vi.hoisted(() => ({
	config: undefined as MockConfig | undefined,
	pairing: {
		code: null,
		serial: null,
		status: "idle",
		expired: false,
		remainingLabel: "",
		deviceId: null,
		subStatus: null,
	} as MockPairing,
}));

const saveRemoteConfigMock = vi.hoisted(() =>
	vi.fn(async () => ({ success: true })),
);

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			getCloudProviders: vi.fn(async () => ({
				providers: [
					{
						id: "ceralive",
						name: "CeraLive Cloud",
						cloudUrl: "https://ceralive",
					},
					{ id: "belabox", name: "BELABOX Cloud", cloudUrl: "https://belabox" },
				],
				current: { id: "ceralive", name: "CeraLive Cloud" },
			})),
		},
	},
}));

vi.mock("$lib/helpers/SystemHelper", () => ({
	saveRemoteConfig: saveRemoteConfigMock,
}));

vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => "data:image/png;base64,QR"),
}));

// A controllable PairingController double: the getters read the hoisted state so
// a test sets the desired pairing branch BEFORE render.
vi.mock("$lib/pairing/pairing.svelte", () => ({
	PairingController: class {
		get code() {
			return state.pairing.code;
		}
		get serial() {
			return state.pairing.serial;
		}
		get status() {
			return state.pairing.status;
		}
		get expired() {
			return state.pairing.expired;
		}
		get remainingLabel() {
			return state.pairing.remainingLabel;
		}
		get deviceId() {
			return state.pairing.deviceId;
		}
		get subStatus() {
			return state.pairing.subStatus;
		}
		startCountdown() {}
		stopCountdown() {}
		reset() {}
		async generate() {}
		async complete() {
			return { paired: false };
		}
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

function activeCode(): void {
	state.pairing = {
		code: "482913",
		serial: "SER-1",
		status: "active",
		expired: false,
		remainingLabel: "4:59",
		deviceId: null,
		subStatus: null,
	};
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
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	state.config = undefined;
	state.pairing = {
		code: null,
		serial: null,
		status: "idle",
		expired: false,
		remainingLabel: "",
		deviceId: null,
		subStatus: null,
	};
	saveRemoteConfigMock.mockClear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("CloudRemoteDialog — pairing surface (T9)", () => {
	it("renders the pairing section", () => {
		render(CloudRemoteDialog, { props: { open: true } });
		expect(screen.getByTestId("device-pairing")).toBeTruthy();
	});

	it("shows the PRODUCTION complete-pairing action + QR with DEV false", async () => {
		vi.stubEnv("DEV", false);
		activeCode();
		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.getByTestId("complete-pairing")).toBeTruthy();
		expect(screen.queryByTestId("simulate-pairing")).toBeNull();
		await waitFor(() => expect(screen.getByTestId("pairing-qr")).toBeTruthy());
	});

	it("shows the DEV-only simulate-pairing action with DEV true", () => {
		vi.stubEnv("DEV", true);
		activeCode();
		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.getByTestId("simulate-pairing")).toBeTruthy();
		expect(screen.queryByTestId("complete-pairing")).toBeNull();
	});

	it("renders subscription standing + device id when paired", () => {
		state.pairing = {
			code: null,
			serial: null,
			status: "paired",
			expired: false,
			remainingLabel: "",
			deviceId: "device-abc-123",
			subStatus: "ACTIVE",
		};
		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.getByTestId("pairing-status")).toBeTruthy();
		expect(screen.getByTestId("pairing-sub-status")).toBeTruthy();
		expect(screen.getByTestId("pairing-device-id").textContent).toContain(
			"device-abc-123",
		);
	});
});

describe("CloudRemoteDialog — managed key gating (T9)", () => {
	it("shows the key READ-ONLY when selected provider is the active managed cloud AND paired", () => {
		state.config = { remote_provider: "ceralive", remote_key: "live-token" };
		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.getByTestId("remote-key-managed")).toBeTruthy();
		expect(screen.queryByTestId("remote-key")).toBeNull();
	});

	it("keeps the key EDITABLE for an UNPAIRED device", () => {
		state.config = undefined;
		render(CloudRemoteDialog, { props: { open: true } });

		expect(screen.getByTestId("remote-key")).toBeTruthy();
		expect(screen.queryByTestId("remote-key-managed")).toBeNull();
	});

	it("keeps the key EDITABLE for a Custom provider", async () => {
		state.config = { remote_provider: "custom" };
		render(CloudRemoteDialog, { props: { open: true, provider: "custom" } });

		expect(screen.getByTestId("remote-key")).toBeTruthy();
		expect(screen.queryByTestId("remote-key-managed")).toBeNull();
	});
});

describe("CloudRemoteDialog — cross-provider clobber guard (T9)", () => {
	it("preselects a deep-linked provider with an EMPTY key and disables Save until a new key is entered", async () => {
		state.config = { remote_provider: "ceralive", remote_key: "live-token" };
		render(CloudRemoteDialog, { props: { open: true, provider: "belabox" } });

		// BELABOX preselected.
		const trigger = document.getElementById("cloud-provider") as HTMLElement;
		await waitFor(() => expect(trigger.textContent).toContain("BELABOX Cloud"));

		// Key editable + empty (the CeraLive token was NOT carried across).
		expect(screen.getByTestId("remote-key")).toBeTruthy();
		const input = document.getElementById("remote-key") as HTMLInputElement;
		expect(input.value).toBe("");

		// Save is disabled until a fresh key is entered.
		const save = screen.getByRole("button", {
			name: "Save",
		}) as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		await fireEvent.input(input, { target: { value: "belabox-token" } });
		await waitFor(() => expect(save.disabled).toBe(false));
	});
});

describe("CloudRemoteDialog — save routing (T9)", () => {
	it("saves through saveRemoteConfig unchanged", async () => {
		state.config = { remote_provider: "ceralive", remote_key: "live-token" };
		render(CloudRemoteDialog, { props: { open: true } });

		const save = screen.getByRole("button", {
			name: "Save",
		}) as HTMLButtonElement;
		await waitFor(() => expect(save.disabled).toBe(false));
		await fireEvent.click(save);

		await waitFor(() => expect(saveRemoteConfigMock).toHaveBeenCalledTimes(1));
		expect(saveRemoteConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({ remote_key: "live-token", provider: "ceralive" }),
		);
	});
});
