// @vitest-environment jsdom
/**
 * NetifDialog — the wired-port role control (todo 15).
 *
 * Four properties, and each replaces something an operator could not previously
 * see or could previously do by accident:
 *
 *   1. BOTH roles are on screen, each with its ONE-LINE CONSEQUENCE. A role is
 *      not a preference; it decides whether the port carries bonded stream
 *      traffic or hands itself to the client zone.
 *   2. A port that is CURRENTLY a bonded member, while a stream is LIVE, asks
 *      before it is handed away — the streaming interlock — and ARMING it
 *      dispatches nothing.
 *   3. Every other transition dispatches straight away: a confirm on every
 *      transition is one operators learn to click through.
 *   4. The DEVICE moves the control. The op stays pending past the RPC, the
 *      displayed role is held on the prior one, and a typed refusal renders
 *      inline rather than as a toast that expires.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
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

const streaming = { value: false };

vi.mock("$lib/rpc", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { setEthernetRole: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: () => streaming.value,
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import {
	beginOperation,
	destroyAsyncOperations,
	failOperation,
	getOperationPhase,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { ethernetRoleOpKey } from "$main/network/ethernet-role-view";

import NetifDialog from "./NetifDialog.svelte";

const setEthernetRole = vi.mocked(rpc.network.setEthernetRole);
const KEY = ethernetRoleOpKey("eth0");

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return {
		tp: 4096,
		enabled: true,
		ip: "192.168.1.50",
		ethRole: "uplink",
		...overrides,
	};
}

function open(entry: NetifEntry = iface(), name = "eth0") {
	return render(NetifDialog, { props: { open: true, name, iface: entry } });
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
	vi.clearAllMocks();
	streaming.value = false;
	setEthernetRole.mockResolvedValue({ success: true, applied: "shared-lan" });
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("NetifDialog — the role control's offering", () => {
	it("offers BOTH roles, each with its own one-line consequence", () => {
		open();

		const uplink = screen.getByTestId("eth-role-option-eth0-uplink");
		const shared = screen.getByTestId("eth-role-option-eth0-shared-lan");
		expect(uplink.getAttribute("aria-checked")).toBe("true");
		expect(shared.getAttribute("aria-checked")).toBe("false");

		expect(
			screen.getByTestId("eth-role-consequence-eth0-uplink").textContent,
		).toContain("SRTLA bond");
		const sharedConsequence = screen.getByTestId(
			"eth-role-consequence-eth0-shared-lan",
		).textContent;
		expect(sharedConsequence).toContain("Leaves the SRTLA bond");
		expect(sharedConsequence).toContain("plugged into this port");
	});

	it("marks the shared-LAN rung selected when the device reports that role", () => {
		open(iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }));

		expect(
			screen
				.getByTestId("eth-role-option-eth0-shared-lan")
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("meets the 44px touch target on every rung", () => {
		open();
		for (const role of ["uplink", "shared-lan"]) {
			expect(
				screen.getByTestId(`eth-role-option-eth0-${role}`).className,
			).toContain("min-h-[var(--touch-target-min)]");
		}
	});

	it("renders NOTHING for a row the device published no role for", () => {
		// ABSENT is "not an ethernet port, or an older backend" — never `uplink`.
		open(iface({ ethRole: undefined }));
		expect(screen.queryByTestId("eth-role-selector")).toBeNull();
	});
});

describe("NetifDialog — the streaming interlock", () => {
	it("ASKS before taking a bonded uplink out of a live stream, and dispatches nothing", async () => {
		streaming.value = true;
		open();

		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);

		const confirm = await screen.findByTestId("eth-role-confirm-eth0");
		expect(confirm.getAttribute("data-consequence")).toBe(
			"drops-bonded-uplink",
		);
		expect(confirm.getAttribute("data-target")).toBe("shared-lan");
		expect(confirm.textContent).toContain("bonded stream traffic");
		// Arming is not dispatching.
		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(getOperationPhase(KEY)).toBe("idle");
	});

	it("dispatches only once the operator confirms", async () => {
		streaming.value = true;
		open();

		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);
		await fireEvent.click(
			await screen.findByTestId("eth-role-confirm-apply-eth0"),
		);

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "shared-lan",
		});
	});

	it("cancelling dispatches nothing and leaves the prior role selected", async () => {
		streaming.value = true;
		open();

		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);
		await fireEvent.click(
			await screen.findByTestId("eth-role-confirm-cancel-eth0"),
		);

		await waitFor(() =>
			expect(screen.queryByTestId("eth-role-confirm-eth0")).toBeNull(),
		);
		expect(setEthernetRole).not.toHaveBeenCalled();
		expect(
			screen
				.getByTestId("eth-role-option-eth0-uplink")
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("does NOT ask when nothing is streaming", async () => {
		streaming.value = false;
		open();

		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId("eth-role-confirm-eth0")).toBeNull();
	});

	it("does NOT ask for a port that carries no bonded traffic", async () => {
		streaming.value = true;
		// Operator already excluded it from the bond: nothing live is lost.
		open(iface({ enabled: false }));

		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId("eth-role-confirm-eth0")).toBeNull();
	});

	it("does NOT ask on the additive direction back to uplink", async () => {
		streaming.value = true;
		open(iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }));

		await fireEvent.click(screen.getByTestId("eth-role-option-eth0-uplink"));

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		expect(setEthernetRole).toHaveBeenCalledWith({
			name: "eth0",
			role: "uplink",
		});
		expect(screen.queryByTestId("eth-role-confirm-eth0")).toBeNull();
	});

	it("re-selecting the role the port already has dispatches nothing", async () => {
		open();
		await fireEvent.click(screen.getByTestId("eth-role-option-eth0-uplink"));
		expect(setEthernetRole).not.toHaveBeenCalled();
	});
});

describe("NetifDialog — the DEVICE moves the control", () => {
	it("stays pending past the RPC and holds the PRIOR role on screen", async () => {
		open();
		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);

		await waitFor(() => expect(setEthernetRole).toHaveBeenCalledTimes(1));
		// `setEthernetRole` resolving is not the device reaching the role — the
		// terminal `eth_role` frame is, and it has not arrived.
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("pending"));
		expect(
			screen
				.getByTestId("eth-role-option-eth0-uplink")
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(screen.getByTestId("eth-role-pending-eth0").textContent).toContain(
			"Shared LAN",
		);
	});

	it("makes a transition dispatched from ANOTHER client visible", async () => {
		open();
		beginOperation(KEY, "shared-lan");

		expect(
			(await screen.findByTestId("eth-role-pending-eth0")).getAttribute(
				"data-target",
			),
		).toBe("shared-lan");
	});

	it("renders a typed refusal INLINE, with the prior role still selected", async () => {
		open();
		beginOperation(KEY, "shared-lan");
		failOperation(KEY, "apply_failed");

		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.getAttribute("data-error")).toBe("apply_failed");
		expect(band.textContent).toContain("could not apply the new role");
		expect(
			screen
				.getByTestId("eth-role-option-eth0-uplink")
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("never renders a machine token at the operator", async () => {
		open();
		beginOperation(KEY, "shared-lan");
		failOperation(KEY, "some_future_token");

		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.textContent).not.toContain("some_future_token");
		expect(band.textContent).toContain("refused the change");
	});

	it("carries an emulated-host refusal through the RPC reply", async () => {
		setEthernetRole.mockResolvedValueOnce({
			success: false,
			error: "unavailable_in_emulated_mode",
		});
		open();

		await fireEvent.click(
			screen.getByTestId("eth-role-option-eth0-shared-lan"),
		);

		// No frame is published for this refusal, so the RPC reply is the ONLY
		// settlement — a control that only listened to the broadcast would spin.
		const band = await screen.findByTestId("eth-role-error-eth0");
		expect(band.getAttribute("data-error")).toBe(
			"unavailable_in_emulated_mode",
		);
		expect(band.textContent).toContain("real hardware");
	});
});
