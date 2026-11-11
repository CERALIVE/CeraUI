// @vitest-environment jsdom
import { m } from "@ceraui/i18n/svelte";
import {
	type AddonDescriptor,
	KIOSK_UNAVAILABLE_ERROR,
	NETWORK_INGEST_UNAVAILABLE_ERROR,
} from "@ceraui/rpc/schemas";
import { act, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	ASYNC_OP_TTL_MS,
	destroyAsyncOperations,
	getOperationPhase,
	getOperationTarget,
	initAsyncOperations,
	osCommand,
	sweepOperations,
} from "$lib/rpc/async-operation.svelte";
import NetworkIngestDialog from "$main/dialogs/NetworkIngestDialog.svelte";
import BluetoothSection from "$main/network/BluetoothSection.svelte";
import AddonsSection from "$main/settings/AddonsSection.svelte";
import OnDeviceDisplaySection from "$main/settings/OnDeviceDisplaySection.svelte";

const calls = vi.hoisted(() => ({
	setIngestEnabled: vi.fn(),
	enable: vi.fn(),
	disable: vi.fn(),
	list: vi.fn(),
	install: vi.fn(),
	uninstall: vi.fn(),
	getMockHardware: vi.fn(),
	kioskStatus: vi.fn(),
	kioskStart: vi.fn(),
	kioskStop: vi.fn(),
	kioskConfigure: vi.fn(),
	kioskOsk: vi.fn(),
}));
vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: {
		network: { setIngestEnabled: calls.setIngestEnabled },
		bluetooth: { enable: calls.enable, disable: calls.disable },
		addons: {
			list: calls.list,
			install: calls.install,
			uninstall: calls.uninstall,
		},
		streaming: { getMockHardware: calls.getMockHardware },
		system: {
			kioskStatus: calls.kioskStatus,
			kioskStart: calls.kioskStart,
			kioskStop: calls.kioskStop,
			kioskConfigure: calls.kioskConfigure,
			kioskOsk: calls.kioskOsk,
		},
	},
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => ({}),
	getConfig: () => ({}),
	getAddons: () => ({}),
	getKiosk: () => undefined,
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const descriptor: AddonDescriptor = {
	id: "sample",
	name: "Sample",
	version: "1.0.0",
	category: "media",
	payload: { type: "sysext" },
	sysextLevel: "1",
	versionId: "12",
	artifact: {
		urlTemplate: "https://example.com/{os_version}/sample.raw",
		sha256: "a".repeat(64),
		gpgSigRef: "sig",
		sizeDownload: 1000,
		sizeInstalled: 2000,
	},
	provides: ["/usr/lib/sample"],
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(Date, "now").mockReturnValue(0);
	calls.getMockHardware.mockResolvedValue({ effectiveHardware: "n100" });
	calls.kioskStatus.mockResolvedValue({
		enabled: true,
		state: "enabled-running",
		display: "lcd",
		touch: true,
		motion: true,
		performance: "balanced",
	});
	initAsyncOperations();
});
afterEach(() => {
	destroyAsyncOperations();
	vi.restoreAllMocks();
});

const refusal = (error: string) => ({ success: false, error });
const cases = [
	...(["rtmp", "srt"] as const).map((protocol) => ({
		name: `ingest ${protocol}`,
		key: `ingest-toggle-${protocol}`,
		rpc: calls.setIngestEnabled,
		reply: refusal(NETWORK_INGEST_UNAVAILABLE_ERROR),
		open: () => {
			render(NetworkIngestDialog, { props: { open: true } });
			return screen.findByTestId(`network-ingest-toggle-${protocol}`);
		},
	})),
	...([false, true] as const).map((enabled) => ({
		name: `Bluetooth enabled=${enabled}`,
		key: "bluetooth-enable",
		rpc: enabled ? calls.disable : calls.enable,
		reply: refusal("bluez_unavailable"),
		open: () => {
			render(BluetoothSection, {
				props: {
					status: {
						available: true,
						enabled,
						adapters: [],
						devices: [],
						agent: { registered: true, isDefaultAgent: true },
						bootReconnectDone: true,
						capabilities: {},
					},
				},
			});
			return screen.findByTestId("bluetooth-enable");
		},
	})),
	...([false, true] as const).map((enabled) => ({
		name: `add-on enabled=${enabled}`,
		key: "addon:sample",
		rpc: enabled ? calls.uninstall : calls.install,
		reply: refusal("addon_conflict"),
		open: () => {
			calls.list.mockResolvedValue({
				addons: [
					{
						descriptor,
						state: { enabled, phase: "idle", autoDisabled: false },
						managerPhase: enabled ? "enabled" : "disabled",
					},
				],
			});
			render(AddonsSection, { props: { open: true } });
			return screen.findByTestId("addon-switch-sample");
		},
	})),
	...([KIOSK_UNAVAILABLE_ERROR, "stream_liveness_unknown"] as const).map(
		(error) => ({
			name: `kiosk stop ${error}`,
			key: "kiosk",
			rpc: calls.kioskStop,
			reply: refusal(error),
			open: () => {
				render(OnDeviceDisplaySection, { props: { open: true } });
				return screen.findByTestId("kiosk-enable-switch");
			},
		}),
	),
	{
		name: "kiosk configure",
		key: "kiosk-configure",
		rpc: calls.kioskConfigure,
		reply: refusal(KIOSK_UNAVAILABLE_ERROR),
		open: () => {
			render(OnDeviceDisplaySection, { props: { open: true } });
			return screen.findByRole("switch", {
				name: m["settings.onDeviceDisplay.touch"](),
			});
		},
	},
	{
		name: "kiosk keyboard",
		key: "kiosk-osk",
		rpc: calls.kioskOsk,
		reply: refusal(KIOSK_UNAVAILABLE_ERROR),
		open: () => {
			render(OnDeviceDisplaySection, { props: { open: true } });
			return screen.findByRole("button", {
				name: m["settings.onDeviceDisplay.showKeyboard"](),
			});
		},
	},
];

it.each(cases)(
	"late $name refusal cannot clear a replacement (#496)",
	async (scenario) => {
		const first = Promise.withResolvers<typeof scenario.reply>();
		scenario.rpc.mockReturnValueOnce(first.promise);
		await fireEvent.click(await scenario.open());
		expect(scenario.rpc).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(scenario.key)).toBe("pending");
		sweepOperations(ASYNC_OP_TTL_MS + 1);
		expect(getOperationPhase(scenario.key)).toBe("timed_out");

		// Another surface can dispatch the same resource after the TTL releases it.
		const second = Promise.withResolvers<{ success: boolean }>();
		const target = getOperationTarget(scenario.key);
		const replacement = osCommand({
			key: scenario.key,
			target,
			rpc: () => second.promise,
			confirmOnResolve: true,
		});
		await act(async () => {
			first.resolve(scenario.reply);
			await first.promise;
		});
		expect(getOperationPhase(scenario.key)).toBe("pending");
		expect(getOperationTarget(scenario.key)).toEqual(target);
		second.resolve({ success: true });
		await replacement;
		expect(getOperationPhase(scenario.key)).toBe("confirmed");
	},
);
