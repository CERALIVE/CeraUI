// @vitest-environment jsdom
/**
 * A tab loaded before `config_clear` existed keeps working as it does today.
 *
 * Both sides are real. The bytes are what the backend's own `streaming.setConfig`
 * puts on a socket when Encoder is switched to Automatic, captured from a child
 * process. The old tab is the socket client, merge and stores of the last commit
 * before the message existed, read from git and driven over a scripted socket;
 * only the shared packages (`@ceraui/rpc`, `@ceraui/i18n`) are today's.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";

import { checkOutOldTab } from "./old-tab";
import { realDevice } from "./real-device";

let oldSource: string;
/** [config with the manual codec], [config without it, then the clear]. */
let frames: string[];

class ScriptedSocket {
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	static readonly CLOSED = 3;
	static latest: ScriptedSocket;
	readyState = ScriptedSocket.OPEN;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: string }) => void;
	constructor() {
		ScriptedSocket.latest = this;
	}
	send(): void {}
	close(): void {}
}

/** Boot one build's real client and merge on a scripted socket. */
async function openTab(lib: string) {
	const subscriptions = await import(
		/* @vite-ignore */ `${lib}/rpc/subscriptions.svelte.ts`
	);
	subscriptions.initSubscriptions();
	const socket = ScriptedSocket.latest;
	socket.onopen?.();
	return {
		config: () => subscriptions.getConfig() as Record<string, unknown>,
		receive: (bytes: string) => socket.onmessage?.({ data: bytes }),
	};
}

beforeAll(async () => {
	const device = await realDevice();
	// Encoder goes from H.264 to Automatic.
	const config = { max_br: 6000, balancer: "adaptive", video_codec: "h264" };
	const write = { video_codec: null, balancer: "fixed" };
	frames = [
		...(await device.call("become", config)).frames,
		...(await device.call("setConfig", write)).frames,
	];
	device.close();
	oldSource = checkOutOldTab();
	// Compiled here, not out of a test's time budget.
	for (const lib of [`${oldSource}/lib`, resolve("src/lib")])
		await import(/* @vite-ignore */ `${lib}/rpc/subscriptions.svelte.ts`);
}, 180_000);

afterAll(() => {
	if (oldSource) rmSync(oldSource, { recursive: true, force: true });
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", ScriptedSocket);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("the device sends the config frame it always sent, then config_clear", () => {
	const parsed = frames.map((frame) => JSON.parse(frame));

	expect(parsed.map((frame) => Object.keys(frame)[0])).toEqual([
		"config",
		"config",
		"config_clear",
	]);
	expect(parsed[0].config).toMatchObject({
		balancer: "adaptive",
		video_codec: "h264",
	});
	expect(parsed[1].config).toMatchObject({ balancer: "fixed" });
	expect(parsed[1].config).not.toHaveProperty("video_codec");
	expect(parsed[2].config_clear).toEqual({ keys: ["video_codec"] });
});

it("an old tab ignores config_clear without error and keeps today's behavior", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const tab = await openTab(`${oldSource}/lib`);
	const [manual, automatic, clear] = frames as [string, string, string];
	tab.receive(manual);
	tab.receive(automatic);
	const afterConfig = tab.config();
	// Its merge: the new value is applied, the key the frame dropped is kept.
	expect(afterConfig).toMatchObject({ balancer: "fixed", video_codec: "h264" });

	expect(() => tab.receive(clear)).not.toThrow();

	expect(tab.config()).toBe(afterConfig);
	expect(warn.mock.calls).toEqual([
		["Unhandled message type:", "config_clear", { keys: ["video_codec"] }],
	]);
	expect(error).not.toHaveBeenCalled();
	// Still listening: the next frame is applied as before.
	tab.receive(JSON.stringify({ config: { max_br: 7000 } }));
	expect(tab.config()).toEqual({ ...afterConfig, max_br: 7000 });
});

it("a current tab shows the same bytes cleared", async () => {
	const tab = await openTab(resolve("src/lib"));
	for (const frame of frames) tab.receive(frame);

	expect(tab.config()).toMatchObject({ balancer: "fixed" });
	expect(tab.config()).not.toHaveProperty("video_codec");
});
