// @vitest-environment jsdom
/**
 * NetworkView: a modem change the device could not confirm always has a way out.
 *
 * A `failed` journal entry refuses every stream start and every change to that
 * modem, and survives a reboot. Before this surface no screen could clear it.
 * Frames go through the real subscription handler and every RPC is answered by a
 * journal with the backend's own transitions, so a sequence the device would
 * refuse is refused here too.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	Modem,
	ModemMutationAckInput,
	ModemMutationDecommissionInput,
	ModemMutationListOutput,
	ModemMutationRebaselineInput,
	ModemMutationState,
} from "@ceraui/rpc/schemas";
import { modemMutationKindSchema } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcFake = vi.hoisted(() => ({
	listMutationBlocks: vi.fn<() => Promise<ModemMutationListOutput>>(),
	acknowledgeMutation: vi.fn(),
	decommissionMutation: vi.fn(),
	rebaselineMutation: vi.fn(),
}));
const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown): void => {},
	links: new Set<(state: string) => void>(),
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		modems: rpcFake,
		wifi: { getAdapterModes: () => Promise.resolve({}) },
	},
	rpcClient: {
		onMessage: (handler: (type: string, data: unknown) => void) => {
			wire.message = handler;
			return () => {};
		},
		onConnectionChange: (handler: (state: string) => void) => {
			wire.links.add(handler);
			return () => {};
		},
		getConnectionState: () => "connected",
		connect: () => {},
		getSocket: () => null,
		sendLegacy: () => {},
	},
}));
vi.mock(
	"./dialogs/ModemConfigDialog.svelte",
	() => import("../tests/fixtures/AuthStub.svelte"),
);
vi.mock(
	"./dialogs/RouterDongleDialog.svelte",
	() => import("../tests/fixtures/AuthStub.svelte"),
);
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({
		links: [],
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		unbondedLinkCount: 0,
	}),
}));

import {
	MODEM_ASYNC_SURFACES,
	type ModemAsyncSurfaceId,
} from "$lib/modem/async-surface";
import { noteSessionRestored } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { requestMutationBlockReveal } from "$lib/stores/mutation-block-reveal";
import { MutationBlockDevice } from "../tests/helpers/mutation-block-device";

import NetworkView from "./NetworkView.svelte";

const DONGLE_KEY = "platform-xhci-hcd.0-usb-0:1.2";
const MODEM_KEY = "platform-xhci-hcd.0-usb-0:1.4";
const GONE_KEY = "platform-xhci-hcd.0-usb-0:1.7";

const DONGLE = {
	ifname: "enx001",
	name: "Router dongle",
	device_class: "router-ethernet",
	availability_reason: "router_managed",
	network_type: { supported: [], active: null },
	stable_key: DONGLE_KEY,
} as unknown as Modem;
const MODEM = {
	ifname: "wwan0",
	name: "Quectel RM530N",
	device_class: "mm-managed",
	network_type: { supported: ["4G"], active: "4G" },
	status: {
		connection: "connected",
		signal: 65,
		roaming: false,
		network: "Carrier",
		network_type: "4G",
	},
	stable_key: MODEM_KEY,
} as unknown as Modem;

let device: MutationBlockDevice;

const push = (type: string, data: unknown) => wire.message(type, data);
const setLink = (state: string) => {
	for (const handler of wire.links) handler(state);
};

async function settle(): Promise<void> {
	await vi.waitFor(() =>
		expect(
			[
				...document.querySelectorAll('[data-testid="mutation-block-working"]'),
			].map((working) => working.textContent?.trim() ?? ""),
		).not.toContainEqual(expect.stringMatching(/./)),
	);
	await tick();
}

async function roster(modems: Record<string, Modem>): Promise<void> {
	push("modems", modems);
	await tick();
}

async function open(
	modems: Record<string, Modem> = { "1000": DONGLE, "0": MODEM },
): Promise<void> {
	await roster(modems);
	render(NetworkView);
	await vi.waitFor(() => expect(rpcFake.listMutationBlocks).toHaveBeenCalled());
	await settle();
}

const notice = (key: string) =>
	document.querySelector<HTMLElement>(
		`[data-testid="mutation-block"][data-stable-key="${key}"]`,
	);
const notices = () =>
	document.querySelectorAll<HTMLElement>('[data-testid="mutation-block"]');
const action = (key: string, name: "check" | "keep" | "gone") =>
	notice(key)?.querySelector<HTMLButtonElement>(
		`[data-testid="mutation-block-${name}"]`,
	) ?? null;
const dialog = () =>
	document.querySelector<HTMLElement>(
		'[data-testid="mutation-block-confirm"][data-state="open"]',
	);
const outcome = (key: string) =>
	notice(key)?.querySelector<HTMLElement>(
		'[data-testid="mutation-block-outcome"]',
	) ?? null;

async function press(
	key: string,
	name: "check" | "keep" | "gone",
): Promise<void> {
	const button = action(key, name);
	if (!button) throw new Error(`no ${name} action on ${key}`);
	button.focus();
	await fireEvent.click(button);
	await tick();
}

function confirmAction(): HTMLButtonElement {
	const button = dialog()?.querySelector<HTMLButtonElement>(
		'[data-testid="mutation-block-confirm-action"]',
	);
	if (!button) throw new Error("no confirmation is open");
	return button;
}

async function confirm(): Promise<void> {
	await fireEvent.click(confirmAction());
	await settle();
}

/** Runs one press and lets exactly its declared bound pass. */
async function withinBound(
	surface: ModemAsyncSurfaceId,
	run: () => Promise<void>,
): Promise<void> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		await run();
		await vi.advanceTimersByTimeAsync(MODEM_ASYNC_SURFACES[surface].boundMs);
	} finally {
		vi.useRealTimers();
	}
	await settle();
}

const GONE_ONLY = { acknowledge: 0, decommission: 1, rebaseline: 0 };

function rpcCounts(): Record<string, number> {
	return {
		acknowledge: rpcFake.acknowledgeMutation.mock.calls.length,
		decommission: rpcFake.decommissionMutation.mock.calls.length,
		rebaseline: rpcFake.rebaselineMutation.mock.calls.length,
	};
}

beforeEach(() => {
	resetState();
	initSubscriptions();
	setLink("connected");
	device = new MutationBlockDevice();
	for (const call of Object.values(rpcFake)) call.mockReset();
	rpcFake.listMutationBlocks.mockImplementation(() =>
		Promise.resolve(device.list()),
	);
	rpcFake.acknowledgeMutation.mockImplementation(
		(input: ModemMutationAckInput) =>
			Promise.resolve(device.acknowledge(input)),
	);
	rpcFake.decommissionMutation.mockImplementation(
		(input: ModemMutationDecommissionInput) =>
			Promise.resolve(device.decommission(input.stableKey)),
	);
	rpcFake.rebaselineMutation.mockImplementation(
		(input: ModemMutationRebaselineInput) =>
			Promise.resolve(device.rebaseline(input.stableKey)),
	);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("the dead end", () => {
	it("a blocked router dongle offers its way out on its own row", async () => {
		device.set(DONGLE_KEY);
		await open();

		const row = notice(DONGLE_KEY)?.closest('[data-testid="modem-row"]');
		expect(row?.getAttribute("data-modem-id")).toBe("1000");
		expect(
			[...(row?.querySelectorAll("button") ?? [])]
				.map((button) => button.dataset.testid)
				.filter((id) => id?.startsWith("mutation-block-")),
		).toEqual(["mutation-block-keep", "mutation-block-gone"]);
		expect(notices()).toHaveLength(1);
	});

	it.each([
		["says it can work", true, ["check", "keep", "gone"]],
		["says it cannot work", false, ["keep", "gone"]],
		["says nothing about it", undefined, ["keep", "gone"]],
	] as const)(
		"Check again is there only when the entry %s, and no words name it otherwise",
		async (_name, checkable, offered) => {
			device.set(DONGLE_KEY, { checkable });
			await open();
			expect(
				[...(notice(DONGLE_KEY)?.querySelectorAll("button") ?? [])].map(
					(button) => button.dataset.testid,
				),
			).toEqual(offered.map((name) => `mutation-block-${name}`));
			expect(
				notice(DONGLE_KEY)?.textContent?.includes(
					m["network.modem.saveReconcile"](),
				),
			).toBe(checkable === true);
		},
	);

	it("shows nothing at all while no modem is blocked", async () => {
		await open();
		expect(document.querySelectorAll('[data-testid="modem-row"]')).toHaveLength(
			2,
		);
		expect(
			document.querySelector('[data-testid^="mutation-block"]'),
		).toBeNull();
	});

	it("says what the block stops, and names a dongle a dongle and a modem a modem", async () => {
		device.set(DONGLE_KEY, { kind: "router-subnet" });
		device.set(MODEM_KEY, { kind: "usb-mode" });
		await open();

		expect(notice(DONGLE_KEY)?.textContent).toContain(
			m["network.block.failed"](),
		);
		expect(action(DONGLE_KEY, "gone")?.textContent).toContain(
			m["network.block.goneDongle"](),
		);
		expect(action(MODEM_KEY, "gone")?.textContent).toContain(
			m["network.block.goneModem"](),
		);
		expect(notice(MODEM_KEY)?.textContent).toContain(
			m["network.modem.usbMode.title"](),
		);
	});

	it("a block on a modem that is not listed leads the Cellular card", async () => {
		device.set(GONE_KEY);
		await open();

		const found = notice(GONE_KEY);
		expect(found?.closest('[data-testid="modem-row"]')).toBeNull();
		expect(found?.textContent).toContain(m["network.block.titleUnlisted"]());
		const firstRow = document.querySelector('[data-testid="modem-row"]');
		expect(
			found &&
				firstRow &&
				found.compareDocumentPosition(firstRow) &
					Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it.each<[ModemMutationState, string[]]>([
		["armed", []],
		["executing", []],
		["decommissioned", []],
	])(
		"%s on a modem that is not listed needs nothing and shows nothing",
		async (state) => {
			device.set(GONE_KEY, { state, present: false });
			await open();
			expect(notices()).toHaveLength(0);
		},
	);

	it.each<ModemMutationState>(["armed", "executing"])(
		"a listed modem whose change is %s is not a block",
		async (state) => {
			device.set(MODEM_KEY, { state });
			await open();
			expect(notices()).toHaveLength(0);
		},
	);
});

describe("Check again", () => {
	it("settles on the device's verified re-read, and focus lands on the answer", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();

		expect(rpcFake.acknowledgeMutation.mock.calls).toEqual([
			[{ stableKey: DONGLE_KEY, mode: "verified-rollback", confirm: true }],
		]);
		expect(action(DONGLE_KEY, "check")).toBeNull();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.settled"](),
		);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(notice(DONGLE_KEY)),
		);
	});

	it("shows that it is waiting, announces it, and takes one request per press", async () => {
		let answer: (() => void) | undefined;
		rpcFake.acknowledgeMutation.mockImplementation(
			(input: ModemMutationAckInput) =>
				new Promise((resolve) => {
					answer = () => resolve(device.acknowledge(input));
				}),
		);
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		await press(DONGLE_KEY, "check");

		const working = notice(DONGLE_KEY)?.querySelector(
			'[data-testid="mutation-block-working"]',
		);
		expect(working?.getAttribute("role")).toBe("status");
		expect(working?.textContent).toContain(m["network.block.working"]());
		for (const name of ["check", "keep", "gone"] as const) {
			expect(action(DONGLE_KEY, name)?.getAttribute("aria-disabled")).toBe(
				"true",
			);
		}
		expect(document.activeElement).toBe(action(DONGLE_KEY, "check"));
		await press(DONGLE_KEY, "check");
		await press(DONGLE_KEY, "keep");
		expect(dialog()).toBeNull();
		expect(rpcFake.acknowledgeMutation).toHaveBeenCalledTimes(1);

		answer?.();
		await settle();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied");
	});

	it.each([
		["state_mismatch", { matches: false }, "network.block.mismatch"],
		["read_failed", { fault: "read_failed" }, "network.block.unread"],
		[
			"journal_write_failed",
			{ fault: "journal_write_failed" },
			"network.modem.refusal.writeFailed",
		],
	] as const)("%s keeps the block and says why", async (_name, entry, key) => {
		device.set(DONGLE_KEY, { checkable: true, ...entry });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();

		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("refused");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(m[key]());
		expect(action(DONGLE_KEY, "check")).not.toBeNull();
		expect(document.activeElement).toBe(action(DONGLE_KEY, "check"));
	});

	it("an absent modem says so, stays blocked while it is out, and Keep accepts it once it is back", async () => {
		device.set(DONGLE_KEY, { checkable: true, present: false });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();

		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.notFound"](),
		);
		expect(notice(DONGLE_KEY)?.dataset.blockState).toBe(
			"device-absent-quarantine",
		);
		expect(notice(DONGLE_KEY)?.textContent).toContain(
			m["network.block.absent"](),
		);
		expect(action(DONGLE_KEY, "check")).toBeNull();
		const keep = action(DONGLE_KEY, "keep");
		expect(keep?.getAttribute("aria-disabled")).not.toBe("true");
		expect(
			document.getElementById(keep?.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toContain(m["network.block.absent"]());
		expect(action(DONGLE_KEY, "gone")?.getAttribute("aria-disabled")).not.toBe(
			"true",
		);
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.notFound"](),
		);
		expect(notice(DONGLE_KEY)?.dataset.blockState).toBe(
			"device-absent-quarantine",
		);

		device.set(DONGLE_KEY, { state: "device-absent-quarantine" });
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.settled"](),
		);
		expect(device.list().blocks).toEqual([]);
	});

	it("Keep not acted on for an absent modem says the situation changed", async () => {
		device.set(GONE_KEY, { state: "device-absent-quarantine", present: false });
		await open();
		rpcFake.acknowledgeMutation.mockResolvedValueOnce({
			success: false,
			error: "not_blocked",
		});
		await press(GONE_KEY, "keep");
		await confirm();
		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.block.changed"](),
		);
	});

	it("not_blocked because another screen's check found it absent reads as absent", async () => {
		device.set(DONGLE_KEY, { checkable: true, present: false });
		await open();
		device.acknowledge({
			stableKey: DONGLE_KEY,
			mode: "verified-rollback",
			confirm: true,
		});
		await press(DONGLE_KEY, "check");
		await settle();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.notFound"](),
		);
	});

	it("not_blocked while it is still held says the situation changed", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		device.set(DONGLE_KEY, {
			checkable: true,
			state: "recommission-pending",
		});
		await press(DONGLE_KEY, "check");
		await settle();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("refused");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.changed"](),
		);
	});
});

describe("Keep current settings", () => {
	it("asks first; Cancel sends nothing", async () => {
		device.set(DONGLE_KEY, { matches: false });
		await open();
		await press(DONGLE_KEY, "keep");

		expect(dialog()?.textContent).toContain(m["network.block.keep"]());
		expect(dialog()?.textContent).toContain(m["network.block.keepConfirm"]());
		const cancel = dialog()?.querySelector<HTMLButtonElement>(
			'[data-slot="alert-dialog-cancel"]',
		);
		if (cancel) await fireEvent.click(cancel);
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(rpcCounts()).toEqual({
			acknowledge: 0,
			decommission: 0,
			rebaseline: 0,
		});
		expect(notice(DONGLE_KEY)?.dataset.blockState).toBe("failed");
	});

	it("accepts the settings the modem has now", async () => {
		device.set(DONGLE_KEY, { matches: false });
		await open();
		await press(DONGLE_KEY, "keep");
		await confirm();

		expect(rpcFake.acknowledgeMutation.mock.calls).toEqual([
			[{ stableKey: DONGLE_KEY, mode: "force-rebaseline", confirm: true }],
		]);
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.settled"](),
		);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(notice(DONGLE_KEY)),
		);
	});

	it.each([
		["read_failed", "network.block.unidentified"],
		["journal_write_failed", "network.modem.refusal.writeFailed"],
		["state_mismatch", "network.modem.refusal.deviceBusy"],
	] as const)("%s keeps the block and says why", async (fault, key) => {
		device.set(DONGLE_KEY, { fault });
		await open();
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("refused");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(m[key]());
	});

	it("a modem the device does not find keeps the block and says so", async () => {
		device.set(DONGLE_KEY, { present: false });
		await open();
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.notFound"](),
		);
		expect(action(DONGLE_KEY, "gone")).not.toBeNull();
	});

	it("a returned modem that cannot be read is not told to use a Gone it does not have", async () => {
		device.set(MODEM_KEY, {
			kind: "usb-mode",
			state: "recommission-pending",
			fault: "read_failed",
		});
		await open();
		expect(action(MODEM_KEY, "gone")).toBeNull();
		await press(MODEM_KEY, "keep");
		await confirm();
		expect(outcome(MODEM_KEY)?.textContent).toContain(
			m["network.block.unread"](),
		);
	});

	it("accepts a modem plugged into a port that was marked as gone", async () => {
		device.set(MODEM_KEY, { kind: "usb-mode", state: "recommission-pending" });
		await open();

		expect(notice(MODEM_KEY)?.textContent).toContain(
			m["network.block.returned"](),
		);
		expect(action(MODEM_KEY, "check")).toBeNull();
		expect(action(MODEM_KEY, "gone")).toBeNull();
		await press(MODEM_KEY, "keep");
		await confirm();
		expect(rpcFake.rebaselineMutation.mock.calls).toEqual([
			[{ stableKey: MODEM_KEY, confirm: true }],
		]);
		expect(rpcFake.acknowledgeMutation).not.toHaveBeenCalled();
		expect(outcome(MODEM_KEY)?.textContent).toContain(
			m["network.block.settled"](),
		);
	});

	it("a modem in a port that was marked as gone, before the restart, is told what to do", async () => {
		device.set(MODEM_KEY, { kind: "usb-mode", state: "decommissioned" });
		await open();
		expect(notice(MODEM_KEY)?.textContent).toContain(
			m["network.block.retired"](),
		);
		expect(notice(MODEM_KEY)?.querySelector("button")).toBeNull();
	});
});

describe("This dongle is gone", () => {
	it("is confirmed, and only then does the device look for it and let it go", async () => {
		device.set(DONGLE_KEY, { present: false });
		await open();
		await press(DONGLE_KEY, "gone");
		expect(dialog()?.textContent).toContain(m["network.block.goneConfirm"]());
		expect(rpcFake.acknowledgeMutation).not.toHaveBeenCalled();
		await roster({ "0": MODEM });
		await confirm();

		expect(rpcFake.acknowledgeMutation).not.toHaveBeenCalled();
		expect(rpcFake.decommissionMutation.mock.calls).toEqual([
			[{ stableKey: DONGLE_KEY, confirm: true }],
		]);
		expect(device.list().blocks[0]?.blocksStreaming).toBe(false);
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.gone"](),
		);
	});

	it("lets go of a modem the device already knows is absent, without asking it again", async () => {
		device.set(GONE_KEY, { state: "device-absent-quarantine", present: false });
		await open();
		await press(GONE_KEY, "gone");
		await confirm();
		expect(rpcCounts()).toEqual({
			acknowledge: 0,
			decommission: 1,
			rebaseline: 0,
		});
		expect(outcome(GONE_KEY)?.textContent).toContain(m["network.block.gone"]());
	});

	it("is refused while the device still finds it, and stays blocked", async () => {
		device.set(DONGLE_KEY, { matches: false });
		await open();
		await press(DONGLE_KEY, "gone");
		await confirm();
		expect(rpcCounts()).toEqual(GONE_ONLY);
		expect(device.list().blocks[0]?.blocksStreaming).toBe(true);
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("refused");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.stillThere"](),
		);
	});

	it("is refused, not resolved, when the device finds it back as it was", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		await press(DONGLE_KEY, "gone");
		await confirm();
		expect(rpcCounts()).toEqual(GONE_ONLY);
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("refused");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.stillThere"](),
		);
	});

	it.each([
		[
			"identified and connected without a witness",
			{ matches: false },
			"refused",
			"network.block.stillThere",
		],
		[
			"behind an unreadable device list",
			{ present: false, fault: "read_failed" },
			"refused",
			"network.block.unidentified",
		],
		["absent", { present: false }, "applied", "network.block.gone"],
	] as const)(
		"a failed change on a modem %s shows the device's own answer to one call",
		async (_name, entry, kind, key) => {
			device.set(DONGLE_KEY, entry);
			await open();
			await press(DONGLE_KEY, "gone");
			await confirm();
			expect(rpcCounts()).toEqual(GONE_ONLY);
			expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe(kind);
			expect(outcome(DONGLE_KEY)?.textContent).toContain(m[key]());
		},
	);

	it.each(["before the press", "while the device was letting go"])(
		"a modem replaced in the same port %s is refused, and its block stays",
		async (when) => {
			device.set(DONGLE_KEY, { present: false });
			await open();
			const replace = () =>
				device.set(DONGLE_KEY, { present: true, matches: false });
			if (when === "before the press") replace();
			else
				rpcFake.decommissionMutation.mockImplementationOnce(() => {
					device.set(DONGLE_KEY, {
						state: "device-absent-quarantine",
						present: true,
						matches: false,
					});
					return Promise.resolve(device.decommission(DONGLE_KEY));
				});
			await press(DONGLE_KEY, "gone");
			await confirm();
			expect(rpcCounts()).toEqual(GONE_ONLY);
			expect(notice(DONGLE_KEY)?.dataset.blockState).toBe("failed");
			expect(outcome(DONGLE_KEY)?.textContent).toContain(
				m["network.block.stillThere"](),
			);
		},
	);

	it.each(modemMutationKindSchema.options)(
		"a failed %s is answered by the device alone: unreadable, connected, then gone",
		async (kind) => {
			device.set(MODEM_KEY, { kind, present: false, fault: "read_failed" });
			await open();
			for (const [entry, key] of [
				[undefined, "network.block.unidentified"],
				[{ present: true }, "network.block.stillThere"],
				[{ present: false }, "network.block.gone"],
			] as const) {
				if (entry !== undefined) device.set(MODEM_KEY, { kind, ...entry });
				await press(MODEM_KEY, "gone");
				await confirm();
				expect(outcome(MODEM_KEY)?.textContent).toContain(m[key]());
			}
			expect(rpcCounts()).toEqual({ ...GONE_ONLY, decommission: 3 });
		},
	);

	it("keeps the device's answer when the list cannot be read after it", async () => {
		device.set(DONGLE_KEY, { matches: false });
		await open();
		await press(DONGLE_KEY, "gone");
		rpcFake.listMutationBlocks.mockRejectedValue(new Error("unreadable"));
		await confirm();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.stillThere"](),
		);
		expect(action(DONGLE_KEY, "gone")).not.toBeNull();
	});

	it("says the situation changed when the device did not act on a modem it finds absent", async () => {
		device.set(DONGLE_KEY, { present: false });
		await open();
		rpcFake.decommissionMutation.mockImplementationOnce(() => {
			device.set(DONGLE_KEY, {
				state: "device-absent-quarantine",
				present: false,
			});
			return Promise.resolve({ success: false, error: "not_blocked" });
		});
		await press(DONGLE_KEY, "gone");
		await confirm();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.changed"](),
		);
	});

	it("does not call a decision done that the device could not save", async () => {
		device.set(GONE_KEY, { state: "device-absent-quarantine", present: false });
		await open();
		rpcFake.decommissionMutation.mockImplementationOnce(() => {
			device.set(GONE_KEY, { state: "decommissioned", present: false });
			return Promise.resolve({ success: false, error: "journal_write_failed" });
		});
		await press(GONE_KEY, "gone");
		await confirm();
		expect(outcome(GONE_KEY)?.dataset.outcome).toBe("refused");
		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.modem.refusal.writeFailed"](),
		);
	});

	it.each([
		["found again in its port", { present: true }, "network.block.stillThere"],
		[
			"that cannot be identified",
			{ present: false, fault: "read_failed" },
			"network.block.unidentified",
		],
	] as const)(
		"a decommission refused for a modem %s says what to do, and every way out stays live",
		async (_name, entry, key) => {
			device.set(GONE_KEY, { state: "device-absent-quarantine", ...entry });
			await open();
			await press(GONE_KEY, "gone");
			await confirm();
			expect(outcome(GONE_KEY)?.dataset.outcome).toBe("refused");
			expect(outcome(GONE_KEY)?.textContent).toContain(m[key]());

			device.set(GONE_KEY, {
				state: "device-absent-quarantine",
				present: false,
			});
			await press(GONE_KEY, "gone");
			await confirm();
			expect(outcome(GONE_KEY)?.textContent).toContain(
				m["network.block.gone"](),
			);
		},
	);

	it("a refusal for one unidentified port says nothing about, and holds nothing on, another", async () => {
		device.set(GONE_KEY, {
			state: "device-absent-quarantine",
			present: false,
			fault: "read_failed",
		});
		device.set(MODEM_KEY, { kind: "usb-mode" });
		await open();
		const other = notice(MODEM_KEY)?.textContent;
		await press(GONE_KEY, "gone");
		await confirm();

		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.block.unidentified"](),
		);
		expect(outcome(MODEM_KEY)).toBeNull();
		expect(notice(MODEM_KEY)?.textContent).toBe(other);

		await press(MODEM_KEY, "keep");
		await confirm();
		expect(outcome(MODEM_KEY)?.dataset.outcome).toBe("applied");
		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.block.unidentified"](),
		);
		expect(device.list().blocks.map((block) => block.stableKey)).toEqual([
			GONE_KEY,
		]);
	});

	it("reports a decision the device could not save", async () => {
		device.set(GONE_KEY, { state: "device-absent-quarantine", present: false });
		rpcFake.decommissionMutation.mockResolvedValue({
			success: false,
			error: "journal_write_failed",
		});
		await open();
		await press(GONE_KEY, "gone");
		await confirm();
		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.modem.refusal.writeFailed"](),
		);
	});
});

describe("an answer belongs to the state it was given for", () => {
	const reread = () => fireEvent(document, new Event("visibilitychange"));

	it.each([
		["marked as gone and back", { state: "recommission-pending" }],
		["marked as gone", { state: "decommissioned" }],
		["no longer found", { state: "device-absent-quarantine", present: false }],
		["blocked by a newer change", { updatedAt: 1 }],
	] as const)("a refusal leaves when the modem is %s", async (_name, next) => {
		device.set(DONGLE_KEY, { checkable: true, matches: false });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.mismatch"](),
		);
		await reread();
		await settle();
		expect(outcome(DONGLE_KEY)).not.toBeNull();

		device.set(DONGLE_KEY, next);
		await reread();
		await vi.waitFor(() => expect(outcome(DONGLE_KEY)).toBeNull());
		expect(notice(DONGLE_KEY)?.dataset.blockState).toBe(
			"state" in next ? next.state : "failed",
		);
	});

	it("a refusal leaves with the block it was about", async () => {
		device.set(DONGLE_KEY, { checkable: true, matches: false });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();
		device.clear(DONGLE_KEY);
		await reread();
		await vi.waitFor(() => expect(notice(DONGLE_KEY)).toBeNull());
	});

	it("a success leaves when the same port is blocked again", async () => {
		device.set(DONGLE_KEY);
		await open();
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied");
		device.set(DONGLE_KEY, { updatedAt: 1 });
		await reread();
		await vi.waitFor(() => expect(outcome(DONGLE_KEY)).toBeNull());
		expect(action(DONGLE_KEY, "keep")).not.toBeNull();
	});

	it("a decision that could not be saved stays while its state stands", async () => {
		device.set(MODEM_KEY, { state: "device-absent-quarantine" });
		await open();
		rpcFake.decommissionMutation.mockImplementationOnce(() => {
			device.set(MODEM_KEY, { state: "decommissioned" });
			return Promise.resolve({ success: false, error: "journal_write_failed" });
		});
		await press(MODEM_KEY, "gone");
		await confirm();
		await reread();
		await settle();
		expect(outcome(MODEM_KEY)?.textContent).toContain(
			m["network.modem.refusal.writeFailed"](),
		);
		device.set(MODEM_KEY, { state: "recommission-pending" });
		await reread();
		await vi.waitFor(() => expect(outcome(MODEM_KEY)).toBeNull());
	});
});

describe("an answer and what the device did after it", () => {
	const reread = () => fireEvent(document, new Event("visibilitychange"));

	it.each(["check", "keep"] as const)(
		"%s that succeeds is not shown beside a newer failure on the same port",
		async (name) => {
			device.set(DONGLE_KEY, { checkable: true });
			await open();
			rpcFake.acknowledgeMutation.mockImplementationOnce(
				(input: ModemMutationAckInput) => {
					const answer = device.acknowledge(input);
					device.set(DONGLE_KEY, { checkable: true, updatedAt: 1 });
					return Promise.resolve(answer);
				},
			);
			await press(DONGLE_KEY, name);
			if (name === "check") await settle();
			else await confirm();
			expect(action(DONGLE_KEY, "keep")).not.toBeNull();
			expect(outcome(DONGLE_KEY)).toBeNull();
			await reread();
			await settle();
			expect(outcome(DONGLE_KEY)).toBeNull();
		},
	);

	it("a refusal is not shown against a newer change on the same port", async () => {
		device.set(DONGLE_KEY, { checkable: true, matches: false });
		await open();
		rpcFake.acknowledgeMutation.mockImplementationOnce(() => {
			device.set(DONGLE_KEY, { checkable: true, updatedAt: 1 });
			return Promise.resolve({ success: false, error: "state_mismatch" });
		});
		await press(DONGLE_KEY, "check");
		await settle();
		expect(action(DONGLE_KEY, "check")).not.toBeNull();
		expect(outcome(DONGLE_KEY)).toBeNull();
	});

	it("an unanswered press is not left on a state the device has moved to since", async () => {
		device.set(DONGLE_KEY);
		await open();
		rpcFake.acknowledgeMutation.mockImplementationOnce(() => {
			device.set(DONGLE_KEY, {
				state: "device-absent-quarantine",
				present: false,
			});
			return Promise.reject(new Error("socket closed"));
		});
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(notice(DONGLE_KEY)?.dataset.blockState).toBe(
			"device-absent-quarantine",
		);
		expect(outcome(DONGLE_KEY)).toBeNull();
	});

	it("a refusal stays with the state its own answer put the modem in", async () => {
		device.set(GONE_KEY, { state: "device-absent-quarantine" });
		await open();
		rpcFake.acknowledgeMutation.mockImplementationOnce(() => {
			device.set(GONE_KEY, { state: "failed", updatedAt: 1 });
			return Promise.resolve({ success: false, error: "read_failed" });
		});
		await press(GONE_KEY, "keep");
		await confirm();
		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.block.unidentified"](),
		);
	});

	it.each(["answered", "failed"] as const)(
		"a reply that comes after the bound (%s) is followed by a re-read",
		async (how) => {
			device.set(DONGLE_KEY);
			await open();
			let late: (answer: unknown) => void = () => {};
			rpcFake.acknowledgeMutation.mockImplementationOnce(
				() =>
					new Promise((resolve, reject) => {
						late = how === "answered" ? resolve : reject;
					}),
			);
			await press(DONGLE_KEY, "keep");
			await withinBound("acknowledgeMutation", async () => {
				await fireEvent.click(confirmAction());
			});
			expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("unknown");
			device.clear(DONGLE_KEY);
			late({ success: true, state: "acknowledged" });
			await vi.waitFor(() =>
				expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied"),
			);
			expect(action(DONGLE_KEY, "keep")).toBeNull();
		},
	);

	it("a success and its re-read failing still drops the block, and a later list keeps the answer", async () => {
		device.set(MODEM_KEY, { present: false });
		await open();
		await press(MODEM_KEY, "gone");
		rpcFake.listMutationBlocks.mockRejectedValueOnce(new Error("closed"));
		await confirm();
		expect(action(MODEM_KEY, "gone")).toBeNull();
		expect(outcome(MODEM_KEY)?.textContent).toContain(
			m["network.block.gone"](),
		);
		await reread();
		await vi.waitFor(() =>
			expect(notice(MODEM_KEY)?.dataset.blockState).toBe("decommissioned"),
		);
		expect(outcome(MODEM_KEY)?.textContent).toContain(
			m["network.block.gone"](),
		);
	});

	it("a list asked for before a success cannot bring its block back", async () => {
		device.set(DONGLE_KEY);
		await open();
		const stale = device.list();
		let late: (list: ModemMutationListOutput) => void = () => {};
		rpcFake.listMutationBlocks
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						late = resolve;
					}),
			)
			.mockRejectedValueOnce(new Error("closed"));
		await reread();
		await press(DONGLE_KEY, "keep");
		await confirm();
		expect(action(DONGLE_KEY, "keep")).toBeNull();
		late(stale);
		await settle();
		expect(action(DONGLE_KEY, "keep")).toBeNull();
	});

	it("a list asked for before the link dropped is not applied after it", async () => {
		device.set(DONGLE_KEY);
		await open();
		let late: (list: ModemMutationListOutput) => void = () => {};
		rpcFake.listMutationBlocks.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					late = resolve;
				}),
		);
		await reread();
		setLink("disconnected");
		await tick();
		late({ replayComplete: true, blocks: [] });
		await settle();
		expect(action(DONGLE_KEY, "keep")).not.toBeNull();
	});

	it("a confirmation pressed twice sends one call", async () => {
		device.set(DONGLE_KEY);
		await open();
		rpcFake.acknowledgeMutation.mockImplementationOnce(
			() => new Promise(() => {}),
		);
		await press(DONGLE_KEY, "keep");
		const button = confirmAction();
		button.click();
		button.click();
		await tick();
		expect(rpcCounts().acknowledge).toBe(1);
	});

	it("a press removes the last answer before the next one, and holds every other modem", async () => {
		device.set(DONGLE_KEY, { checkable: true, matches: false });
		device.set(MODEM_KEY, { kind: "usb-mode" });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();
		expect(outcome(DONGLE_KEY)).not.toBeNull();
		rpcFake.acknowledgeMutation.mockImplementationOnce(
			() => new Promise(() => {}),
		);
		await press(DONGLE_KEY, "check");
		expect(outcome(DONGLE_KEY)).toBeNull();
		for (const name of ["keep", "gone"] as const)
			expect(action(MODEM_KEY, name)?.getAttribute("aria-disabled")).toBe(
				"true",
			);
	});

	it("an answer does not take focus from what the person moved to", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		device.set(MODEM_KEY, { kind: "usb-mode" });
		await open();
		let late: (answer: unknown) => void = () => {};
		rpcFake.acknowledgeMutation.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					late = resolve;
				}),
		);
		await press(DONGLE_KEY, "check");
		action(MODEM_KEY, "keep")?.focus();
		late({ success: false, error: "read_failed" });
		await settle();
		expect(document.activeElement).toBe(action(MODEM_KEY, "keep"));
	});
});

describe("which modem is being decided", () => {
	const unlisted = [
		"platform-xhci-hcd.0-usb-0:1.7",
		"platform-xhci-hcd.1-usb-0:1.7",
	] as const;

	it("the confirmation names the modem on its row and the change, and keeps them when it leaves", async () => {
		device.set(MODEM_KEY, { kind: "usb-mode" });
		await open();
		for (const name of ["keep", "gone"] as const) {
			await press(MODEM_KEY, name);
			expect(dialog()?.textContent).toContain("Quectel RM530N");
			expect(dialog()?.textContent).toContain(
				m["network.modem.usbMode.title"](),
			);
			if (name === "keep") {
				await roster({ "1000": DONGLE });
				expect(dialog()?.textContent).toContain("Quectel RM530N");
				await roster({ "1000": DONGLE, "0": MODEM });
				await fireEvent.keyDown(document.activeElement ?? document.body, {
					key: "Escape",
				});
				await vi.waitFor(() => expect(dialog()).toBeNull());
				expect(document.activeElement).toBe(action(MODEM_KEY, "keep"));
			}
		}
	});

	it("two unlisted modems are told apart by port and controller, on the notice and in the dialog", async () => {
		for (const key of unlisted) device.set(key);
		await open();
		const [first, second] = unlisted.map((key) => notice(key)?.textContent);
		expect(first).not.toBe(second);
		for (const [key, controller] of [
			[unlisted[0], "platform-xhci-hcd.0"],
			[unlisted[1], "platform-xhci-hcd.1"],
		] as const) {
			const port = `USB 0-1.7 (${controller})`;
			expect(notice(key)?.querySelector("bdi")?.textContent).toBe(port);
			await press(key, "gone");
			expect(dialog()?.querySelector("bdi")?.textContent).toBe(port);
			await confirm();
			expect(notice(key)?.textContent).toContain(port);
		}
	});

	it("an unlisted modem that is not on USB is named by its key", async () => {
		const key = "pci-0000:03:00.0";
		device.set(key, { kind: "usb-mode" });
		await open();
		expect(notice(key)?.querySelector("bdi")?.textContent).toBe(key);
	});

	it("unlisted modems on the same port keep distinct controller names containing -usb-", async () => {
		const keys = [
			"platform-a-usb-host0-usb-0:1.2",
			"platform-a-usb-host1-usb-0:1.2",
		];
		for (const key of keys) device.set(key);
		await open();
		expect(
			keys.map((key) => notice(key)?.querySelector("bdi")?.textContent),
		).toEqual([
			"USB 0-1.2 (platform-a-usb-host0)",
			"USB 0-1.2 (platform-a-usb-host1)",
		]);
	});

	it("a listed modem is not called unlisted, and a settled notice keeps its name", async () => {
		device.set(MODEM_KEY, { kind: "usb-mode" });
		await open();
		expect(notice(MODEM_KEY)?.textContent).not.toContain(
			m["network.block.titleUnlisted"](),
		);
		const name = () => {
			const id = notice(MODEM_KEY)?.getAttribute("aria-labelledby");
			return (
				notice(MODEM_KEY)?.getAttribute("aria-label") ??
				(id && document.getElementById(id)?.textContent)
			);
		};
		expect(name()).toContain("Quectel RM530N");
		await press(MODEM_KEY, "keep");
		await confirm();
		expect(name()).toContain("Quectel RM530N");
	});

	it.each([
		["keep", "bg-primary"],
		["gone", "text-destructive"],
	] as const)(
		"the %s confirmation is titled and coloured as that decision",
		async (name, tone) => {
			device.set(DONGLE_KEY);
			await open();
			await press(DONGLE_KEY, name);
			const label =
				m[
					name === "gone" ? "network.block.goneDongle" : "network.block.keep"
				]();
			expect(confirmAction().textContent?.trim()).toBe(label);
			expect(
				dialog()
					?.querySelector('[data-slot="alert-dialog-title"]')
					?.textContent?.trim(),
			).toBe(label);
			expect(confirmAction().className).toContain(tone);
		},
	);

	it.each([
		["usb-mode", "network.modem.usbMode.title"],
		["band-lock", "network.modem.bands.title"],
		["five-g-pref", "network.modem.fiveG.title"],
		["fcc-unlock", "network.modem.fccUnlock.title"],
		["modem-config", "network.modem.configuration"],
		["router-subnet", "network.routerCellular.subnet.addressLabel"],
	] as const)("a %s notice names that change", async (kind, key) => {
		device.set(DONGLE_KEY, { kind });
		await open();
		expect(notice(DONGLE_KEY)?.textContent).toContain(m[key]());
	});

	it("a router change is about a dongle, any other about a modem", async () => {
		device.set(DONGLE_KEY, { kind: "router-admin" });
		device.set(MODEM_KEY, { kind: "band-lock" });
		await open();
		expect(action(DONGLE_KEY, "gone")?.textContent?.trim()).toBe(
			m["network.block.goneDongle"](),
		);
		expect(action(MODEM_KEY, "gone")?.textContent?.trim()).toBe(
			m["network.block.goneModem"](),
		);
	});

	it("a confirmation closes when the decision is no longer offered, and focus goes to what is left", async () => {
		device.set(DONGLE_KEY);
		await open();
		await press(DONGLE_KEY, "gone");
		device.set(DONGLE_KEY, { state: "recommission-pending" });
		await fireEvent(document, new Event("visibilitychange"));
		await vi.waitFor(() => expect(dialog()).toBeNull());

		await press(DONGLE_KEY, "keep");
		device.clear(DONGLE_KEY);
		await fireEvent(document, new Event("visibilitychange"));
		await vi.waitFor(() =>
			expect(document.activeElement?.textContent).toBe(
				m["network.view.cellular"](),
			),
		);
	});

	it("an answer reads in the page's own ink, whatever its tint", async () => {
		device.set(DONGLE_KEY, { checkable: true, matches: false });
		await open();
		await press(DONGLE_KEY, "check");
		await settle();
		expect(outcome(DONGLE_KEY)?.parentElement?.className).toContain(
			"[&_p>span]:text-foreground",
		);
	});
});

describe("when the list is read and what the link holds", () => {
	const reads = () => rpcFake.listMutationBlocks.mock.calls.length;

	it("a restored session and an opened modem dialog each re-read it", async () => {
		await open();
		for (const cause of [
			() => noteSessionRestored(),
			() =>
				document
					.querySelector<HTMLElement>(
						'[data-testid="open-modem-config-dialog"]:not([disabled])',
					)
					?.click(),
		]) {
			const before = reads();
			cause();
			await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
			await settle();
		}
	});

	it("nothing is read while the link is down", async () => {
		await open();
		setLink("disconnected");
		await tick();
		const before = reads();
		await roster({ "0": MODEM });
		push("status", { is_streaming: true });
		await tick();
		expect(reads()).toBe(before);
	});

	it("a button held offline says why, and an open confirmation sends nothing", async () => {
		device.set(DONGLE_KEY);
		await open();
		await press(DONGLE_KEY, "keep");
		setLink("disconnected");
		await tick();
		const described = action(DONGLE_KEY, "keep")?.getAttribute(
			"aria-describedby",
		);
		expect(document.getElementById(described ?? "")?.textContent).toContain(
			m["connection.lost"](),
		);
		const before = rpcCounts();
		confirmAction().click();
		await tick();
		expect(rpcCounts()).toEqual(before);
		expect(dialog()?.textContent).toContain(m["connection.lost"]());
	});
});

describe("two screens", () => {
	it.each(["check", "keep", "gone"] as const)(
		"%s after another screen settled it says so and drops the notice",
		async (name) => {
			device.set(DONGLE_KEY, { checkable: true });
			await open();
			device.clear(DONGLE_KEY);
			await press(DONGLE_KEY, name);
			if (name !== "check") await confirm();
			await settle();

			expect(action(DONGLE_KEY, "check")).toBeNull();
			expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied");
			expect(outcome(DONGLE_KEY)?.textContent).toContain(
				m["network.block.elsewhere"](),
			);
		},
	);

	it("marked as gone on another screen: the notice leaves with the same words", async () => {
		device.set(GONE_KEY, { checkable: true, present: false });
		await open();
		device.set(GONE_KEY, { state: "decommissioned", present: false });
		await press(GONE_KEY, "check");
		await settle();
		expect(action(GONE_KEY, "check")).toBeNull();
		expect(outcome(GONE_KEY)?.textContent).toContain(
			m["network.block.elsewhere"](),
		);
	});

	it("coming back to the tab re-reads, and an open confirmation closes with its block", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		await press(DONGLE_KEY, "keep");
		expect(dialog()).not.toBeNull();
		device.clear(DONGLE_KEY);
		await fireEvent(document, new Event("visibilitychange"));
		await vi.waitFor(() => expect(notice(DONGLE_KEY)).toBeNull());
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(rpcCounts()).toEqual({
			acknowledge: 0,
			decommission: 0,
			rebaseline: 0,
		});
	});

	it.each([
		["a stream starting", () => push("status", { is_streaming: true })],
		[
			"the modems changing",
			() => push("modems", { "7": { ...MODEM, stable_key: GONE_KEY } }),
		],
		[
			"the cellular stack finishing",
			() => push("status", { cellular_initializing: true }),
		],
	] as const)("%s re-reads the list", async (_name, happen) => {
		await open();
		const before = rpcFake.listMutationBlocks.mock.calls.length;
		happen();
		await vi.waitFor(() =>
			expect(rpcFake.listMutationBlocks.mock.calls.length).toBeGreaterThan(
				before,
			),
		);
	});

	it("an older list never overwrites a newer one", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		const stale = device.list();
		await open();
		let late: ((list: ModemMutationListOutput) => void) | undefined;
		rpcFake.listMutationBlocks.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					late = resolve;
				}),
		);
		await fireEvent(document, new Event("visibilitychange"));
		await press(DONGLE_KEY, "check");
		await settle();
		late?.(stale);
		await settle();
		expect(action(DONGLE_KEY, "check")).toBeNull();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied");
	});
});

describe("a modem that leaves while its confirmation is open", () => {
	it("keeps the confirmation, moves the notice, and reports what the device found", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		await press(DONGLE_KEY, "keep");
		device.set(DONGLE_KEY, { present: false });
		await roster({ "0": MODEM });

		expect(dialog()).not.toBeNull();
		expect(notice(DONGLE_KEY)?.closest('[data-testid="modem-row"]')).toBeNull();
		await confirm();
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.notFound"](),
		);
		expect(notice(DONGLE_KEY)?.contains(document.activeElement)).toBe(true);
	});
});

describe("the link to the device", () => {
	it("holds every action with a reason while it is down, and re-reads when the session is back", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		setLink("disconnected");
		await tick();

		expect(
			notice(DONGLE_KEY)?.querySelector(
				'[data-testid="mutation-block-offline"]',
			)?.textContent,
		).toContain(m["connection.lost"]());
		const before = rpcCounts();
		await press(DONGLE_KEY, "check");
		await press(DONGLE_KEY, "gone");
		expect(dialog()).toBeNull();
		expect(rpcCounts()).toEqual(before);

		device.clear(DONGLE_KEY);
		setLink("connected");
		noteSessionRestored();
		await vi.waitFor(() => expect(notice(DONGLE_KEY)).toBeNull());
	});

	it("an unanswered action claims nothing, and the next list settles it", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		rpcFake.acknowledgeMutation.mockImplementationOnce(() => {
			setLink("disconnected");
			return Promise.reject(new Error("socket closed"));
		});
		rpcFake.listMutationBlocks.mockRejectedValueOnce(new Error("closed"));
		await press(DONGLE_KEY, "check");
		await settle();
		expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("unknown");
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.unanswered"](),
		);
		expect(action(DONGLE_KEY, "check")).not.toBeNull();

		device.clear(DONGLE_KEY);
		setLink("connected");
		noteSessionRestored();
		await vi.waitFor(() =>
			expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("applied"),
		);
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.elsewhere"](),
		);
	});

	it.each([
		["check", "acknowledgeMutation", { checkable: true }],
		["keep", "acknowledgeMutation", {}],
		["keep", "rebaselineMutation", { state: "recommission-pending" }],
		["gone", "decommissionMutation", {}],
	] as const)(
		"%s through %s ends as unknown when the device never answers",
		async (name, call, entry) => {
			device.set(DONGLE_KEY, entry);
			await open();
			rpcFake[call].mockImplementationOnce(() => new Promise(() => {}));
			if (name !== "check") await press(DONGLE_KEY, name);
			await withinBound(call, async () => {
				if (name === "check") await press(DONGLE_KEY, name);
				else await fireEvent.click(confirmAction());
			});
			expect(outcome(DONGLE_KEY)?.dataset.outcome).toBe("unknown");
			expect(action(DONGLE_KEY, name)?.getAttribute("aria-disabled")).not.toBe(
				"true",
			);
		},
	);

	it("a list that never arrives does not hold the answer before it", async () => {
		device.set(DONGLE_KEY, { matches: false });
		await open();
		await press(DONGLE_KEY, "gone");
		rpcFake.listMutationBlocks.mockImplementationOnce(
			() => new Promise(() => {}),
		);
		await withinBound("listMutationBlocks", async () => {
			await fireEvent.click(confirmAction());
		});
		expect(outcome(DONGLE_KEY)?.textContent).toContain(
			m["network.block.stillThere"](),
		);
	});

	it("a failed read keeps the last answer instead of clearing it", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		rpcFake.listMutationBlocks.mockRejectedValueOnce(new Error("closed"));
		await fireEvent(document, new Event("visibilitychange"));
		await settle();
		expect(action(DONGLE_KEY, "check")).not.toBeNull();
	});
});

describe("no polling", () => {
	it("an idle hour of ordinary pushes reads nothing", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		await open();
		const before = rpcFake.listMutationBlocks.mock.calls.length;
		vi.useFakeTimers();
		for (let minute = 0; minute < 60; minute += 1) {
			push("netif", { eth0: { tp: minute, enabled: true, ip: "10.0.0.2" } });
			await vi.advanceTimersByTimeAsync(60_000);
		}
		expect(rpcFake.listMutationBlocks.mock.calls.length).toBe(before);
	});

	it("while the device is still replaying, its own updates re-read, and stop once it is done", async () => {
		device.replayComplete = false;
		await open();
		expect(notices()).toHaveLength(0);
		device.set(DONGLE_KEY, { checkable: true });
		device.replayComplete = true;
		push("netif", { eth0: { tp: 1, enabled: true, ip: "10.0.0.2" } });
		await vi.waitFor(() => expect(notice(DONGLE_KEY)).not.toBeNull());

		await settle();
		const before = rpcFake.listMutationBlocks.mock.calls.length;
		push("netif", { eth0: { tp: 2, enabled: true, ip: "10.0.0.2" } });
		await settle();
		expect(rpcFake.listMutationBlocks.mock.calls.length).toBe(before);
	});
});

describe("arriving from the Start refusal", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("brings the first notice into view and focuses it, once", async () => {
		device.set(DONGLE_KEY, { checkable: true });
		requestMutationBlockReveal();
		await open();
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(notice(DONGLE_KEY)),
		);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it("a reveal that found no list does not take focus on a later visit", async () => {
		rpcFake.listMutationBlocks.mockRejectedValue(new Error("not ready"));
		requestMutationBlockReveal();
		await open();
		cleanup();
		device.set(DONGLE_KEY);
		rpcFake.listMutationBlocks.mockImplementation(() =>
			Promise.resolve(device.list()),
		);
		await open();
		await vi.waitFor(() => expect(notice(DONGLE_KEY)).not.toBeNull());
		await settle();
		expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(notice(DONGLE_KEY));
	});

	it("leaves the page alone when nothing is blocked any more", async () => {
		requestMutationBlockReveal();
		await open();
		device.set(DONGLE_KEY, { checkable: true });
		await fireEvent(document, new Event("visibilitychange"));
		await vi.waitFor(() => expect(notice(DONGLE_KEY)).not.toBeNull());
		await settle();
		expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(document.body);
	});
});
