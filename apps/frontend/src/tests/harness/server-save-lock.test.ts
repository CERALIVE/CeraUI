// @vitest-environment jsdom
/**
 * Every server save that picks no managed slot clears the selected one by
 * sending it empty. Its lock must not outlive that clear, whether the device had
 * a slot to clear (it names it) or none (it names nothing): another tab's pick
 * shows as soon as the device says so, not when the lock expires. The save is
 * the dialog's own command, the device the backend's own process.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyDirtyRegistry } from "$lib/rpc/dirty-registry.svelte";
import { getConfig, resetState } from "$lib/rpc/subscriptions.svelte";
import { buildServerSetConfig } from "$lib/streaming/receiver-experience";
import { type HeldRpc, heldRpc, ingestFrame } from "./device-loop";
import { DEVICE_START_MS, type RealDevice, realDevice } from "./real-device";

const held = vi.hoisted(() => ({ rpc: undefined as HeldRpc | undefined }));
vi.mock("$lib/rpc", () => ({
	get rpc() {
		return held.rpc;
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { saveServerConfig } from "../../main/dialogs/server/server-dialog-commands";

const slotShown = () => getConfig()?.selected_ingest_endpoint;

beforeEach(() => {
	resetState();
	destroyDirtyRegistry();
	held.rpc = heldRpc();
});

afterEach(() => {
	resetState();
	destroyDirtyRegistry();
});

describe("a server save with no managed slot, on the real device", () => {
	let device: RealDevice;

	beforeAll(async () => {
		device = await realDevice();
	}, DEVICE_START_MS);
	afterAll(() => device?.close());

	/** Another tab picks the managed slot `ep-2`; this tab hears of it. */
	async function otherTabPicksSlot(): Promise<void> {
		const { frames } = await device.call("setConfig", {
			selected_ingest_endpoint: "ep-2",
			srtla_addr: "slot.example",
			srtla_port: 5001,
		});
		for (const frame of frames) ingestFrame(frame);
	}

	const save = (destination: "custom" | "managed") =>
		saveServerConfig({
			input: buildServerSetConfig(
				{
					latency: 2000,
					protocol: "srtla",
					addr: "own.example",
					portStr: "5000",
					streamId: "",
					relayStreamId: "",
					relayServer: "fra",
					relayAccount: "",
				},
				{ destination },
			),
			onSaved: () => undefined,
			savedMessage: "saved",
			failedMessage: "failed",
		});

	it.each([
		["custom", "ep-1"],
		["managed", "ep-1"],
		["custom", undefined],
		["managed", undefined],
	] as const)(
		"%s, with the slot %s selected before: another tab's pick shows at once",
		async (destination, slot) => {
			await device.become({
				max_br: 6000,
				srtla_addr: "old.example",
				srtla_port: 5000,
				...(slot === undefined ? {} : { selected_ingest_endpoint: slot }),
			});
			expect(slotShown()).toBe(slot);
			const saved = save(destination);
			await device.answer(await (held.rpc as HeldRpc).next("setConfig"));
			await saved;
			expect(slotShown()).toBeUndefined();

			await otherTabPicksSlot();

			expect(slotShown()).toBe("ep-2");
		},
	);
});
