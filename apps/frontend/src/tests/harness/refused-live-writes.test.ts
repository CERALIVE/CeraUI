// @vitest-environment jsdom
/**
 * What an out-of-date page shows when the device refuses its Start and its Live
 * writes. Both sides are real: the device is the backend's entrypoint, stamped
 * with a build the page is not from, and the page is a whole LiveView with its
 * own client, stores and socket, once as it was before the check (read from
 * git) and once as it is today.
 *
 * Start answers with its own `success: false`: a page reads a thrown Start as a
 * lost reply and shows nothing. The other calls throw: the audio pick answers a
 * resolved `success: false` with a second, silent try.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	cleanup,
	configure,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/svelte";
import { flushSync } from "svelte";
import { toast } from "svelte-sonner";
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

import { installJsdomShims } from "../fixtures/real-cockpit-harness";
import { checkOutOldTab } from "./old-tab";
import {
	operator,
	PASSWORD,
	SERVE_MS,
	type ServedDevice,
	serveDevice,
	servedUrl,
} from "./served-device";

vi.mock("svelte-sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
}));

// Bounds on a busy machine: each wait ends on the device's answer, not on these.
configure({ asyncUtilTimeout: 15_000 });
vi.setConfig({ testTimeout: 60_000 });

const RealWebSocket = globalThis.WebSocket;
const NOTICE = "This page is out of date. Reload to continue.";
const CONFIG = {
	source: "usb",
	asrc: "RØDE AI-Micro",
	srtla_addr: "127.0.0.1",
	srtla_port: 5000,
	srt_streamid: "e2e",
	max_br: 6000,
};

const testId = (id: string) => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	if (!found) throw new Error(`nothing on screen has the test id ${id}`);
	return found;
};
const named = (name: string) => {
	const found = [...document.querySelectorAll<HTMLElement>("button")].find(
		(button) =>
			(button.getAttribute("aria-label") ?? button.textContent?.trim()) ===
			name,
	);
	if (!found) throw new Error(`no "${name}" button on screen`);
	return found;
};
const click = async (target: HTMLElement) => {
	await fireEvent.click(target);
	flushSync();
};
/** A control a dialog or a menu shows once it has opened. */
const opened = (find: () => HTMLElement | null | undefined) =>
	waitFor(() => {
		flushSync();
		const found = find();
		expect(found).toBeTruthy();
		return found as HTMLElement;
	});

/** Both pages' modules; today's types stand for the old page's. */
interface Page {
	readonly subs: typeof import("$lib/rpc/subscriptions.svelte");
	readonly client: typeof import("$lib/rpc/client");
	readonly notices: typeof import("$lib/stores/notifications.svelte");
	readonly optimism: typeof import("$lib/rpc/streaming-optimism.svelte");
	readonly live: typeof import("../../main/LiveView.svelte");
	readonly sources: typeof import("../../main/dialogs/NetworkIngestDialog.svelte");
}

interface Write {
	/** What the operator does. */
	readonly does: string;
	/** The call it makes, exactly once. */
	readonly calls: string;
	act(): Promise<void>;
	/** What the page then says: a toast, or text beside the control. */
	readonly says: { toast: string } | { text: string } | "nothing of its own";
}

const IDLE: readonly Write[] = [
	{
		does: "presses Start",
		calls: "streaming.start",
		act: () => click(named("Start Stream")),
		says: { toast: "Failed to start stream" },
	},
	{
		does: "picks another camera",
		calls: "streaming.setConfig",
		act: () => click(testId("source-select-usb2")),
		says: { toast: "Failed to save" },
	},
	{
		does: "picks a network source",
		calls: "streaming.setConfig",
		act: () => click(testId("source-network-ingest-select-rtmp")),
		says: { toast: "Failed to save" },
	},
	{
		does: "picks a capture format",
		calls: "streaming.setConfig",
		act: () => click(testId("source-mode-usb-mjpeg")),
		says: { toast: "Couldn't change the capture format" },
	},
	{
		does: "picks another microphone",
		calls: "streaming.setConfig",
		act: async () => {
			const select = testId("audio-source-select");
			select.focus();
			await fireEvent.keyDown(select, { key: "ArrowDown" });
			const option = await opened(() =>
				[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
					(entry) => entry.textContent?.trim() === "Elgato Wave:3",
				),
			);
			await fireEvent.pointerMove(option, { pointerType: "mouse" });
			await fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
		},
		says: { toast: "Failed to save" },
	},
	{
		does: "saves the encoder settings",
		calls: "streaming.setConfig",
		act: async () => {
			await click(testId("open-encoder-dialog"));
			await click(
				await opened(() =>
					document.querySelector<HTMLElement>(
						'[role="dialog"] [role="switch"][aria-label="Enable Bitrate Overlay"]',
					),
				),
			);
			await click(named("Save"));
		},
		says: { toast: "Failed to save" },
	},
	{
		does: "saves the receiver",
		calls: "streaming.setConfig",
		act: async () => {
			await click(testId("open-server-dialog"));
			const streamId = await opened(() =>
				document.querySelector<HTMLElement>("#srt-streamid"),
			);
			await fireEvent.input(streamId, { target: { value: "other" } });
			await click(named("Save"));
		},
		says: { toast: "Failed to save" },
	},
	// These two switches snap back and say nothing, whatever the shape of the
	// answer: the notice is what tells the operator.
	{
		does: "combines two inputs",
		calls: "streaming.setConfig",
		act: () => click(testId("composition-enable")),
		says: "nothing of its own",
	},
	{
		does: "switches the preview encoder",
		calls: "streaming.setConfig",
		act: () => click(testId("preview-encode-switch")),
		says: "nothing of its own",
	},
	{
		does: "mutes a microphone",
		calls: "streaming.setAudioMix",
		act: () => click(testId("audio-strip-mute-RØDE AI-Micro")),
		says: { text: "Failed to save" },
	},
	{
		does: "puts a microphone on a track",
		calls: "streaming.setAudioMix",
		act: () => click(testId("audio-strip-track-RØDE AI-Micro-2")),
		says: { text: "Failed to save" },
	},
];

describe.each([
	["a page from before the check", checkOutOldTab, "/ws"],
	[
		"today's page, on a device of another build",
		() => resolve("src"),
		"/ws?ui_build=0.0.0-test",
	],
])("%s", (_page, checkOut, dials) => {
	let root: string;
	let device: ServedDevice;
	let owner: Awaited<ReturnType<typeof operator>>;
	let dialled: string[];
	let sent: string[];
	let answered: string[];
	let page: Page;

	const load = <T>(path: string) =>
		import(/* @vite-ignore */ join(root, path)) as Promise<T>;
	const says = () => vi.mocked(toast.error).mock.calls.map(([text]) => text);
	const shownNotices = () =>
		page.notices
			.getPersistent()
			.filter((entry) => entry.name === "ui-out-of-date")
			.map((entry) => entry.text);
	const streaming = async () =>
		(await (await fetch(`http://127.0.0.1:${device.port}/status`)).json())
			.is_streaming;

	beforeAll(async () => {
		installJsdomShims(vi.fn());
		root = checkOut();
		device = await serveDevice("build-device", CONFIG);
		owner = await operator(device, "build-device", RealWebSocket);
		dialled = [];
		sent = [];
		answered = [];
		vi.stubGlobal(
			"WebSocket",
			class extends RealWebSocket {
				constructor(url: string | URL) {
					const { pathname, search } = new URL(url);
					dialled.push(pathname + search);
					super(servedUrl(device, url));
				}
				override send(data: string): void {
					const { id, path } = JSON.parse(data);
					if (path) {
						const call = path.join(".");
						sent.push(call);
						this.addEventListener("message", (event) => {
							if (JSON.parse(event.data).id === id) answered.push(call);
						});
					}
					super.send(data);
				}
			},
		);
		vi.doMock(
			join(root, "lib/components/preview/PreviewCanvas.svelte"),
			async () => ({
				default: (await import("../fixtures/Noop.svelte")).default,
			}),
		);
		page = {
			subs: await load("lib/rpc/subscriptions.svelte.ts"),
			client: await load("lib/rpc/client.ts"),
			notices: await load("lib/stores/notifications.svelte.ts"),
			optimism: await load("lib/rpc/streaming-optimism.svelte.ts"),
			live: await load("main/LiveView.svelte"),
			sources: await load("main/dialogs/NetworkIngestDialog.svelte"),
		};
		page.notices.clearNotifications();
		page.subs.initSubscriptions();
		await waitFor(() =>
			expect(page.subs.getConnectionState()).toBe("connected"),
		);
		expect(dialled).toEqual([dials]);
		expect(
			await page.client.rpc.auth.login({
				password: PASSWORD,
				persistent_token: false,
			}),
		).toMatchObject({ success: true });
		await waitFor(() => {
			expect(page.subs.getSources()?.sources.length).toBeGreaterThan(0);
			expect(shownNotices()).toEqual([NOTICE]);
		});
	}, SERVE_MS);

	afterAll(async () => {
		page?.client.rpcClient.disconnect();
		owner?.close();
		vi.unstubAllGlobals();
		await device?.stop();
		if (root !== resolve("src")) rmSync(root, { recursive: true, force: true });
	});

	let before: unknown;
	beforeEach(async () => {
		before = await owner.call("streaming.getConfig");
		// Dismissed, so what a refusal shows is its own.
		page.notices.clearNotifications();
		vi.clearAllMocks();
		sent.length = 0;
		answered.length = 0;
	});

	afterEach(() => {
		cleanup();
		// A Start's failure outlives its LiveView: the next one would say it again.
		page.optimism.destroyStreamingOptimism();
		document.body.innerHTML = "";
	});

	/** The call was made once, nothing changed, and the page was told to reload. */
	async function refused(write: Write): Promise<void> {
		await waitFor(() => expect(answered).toContain(write.calls));
		// A round trip after that answer: the page has acted on it.
		expect(await owner.call("streaming.getConfig")).toEqual(before);
		await waitFor(() => {
			flushSync();
			expect(shownNotices()).toEqual([NOTICE]);
			if (write.says === "nothing of its own") expect(says()).toEqual([]);
			else if ("toast" in write.says)
				expect(says()).toEqual([write.says.toast]);
			else {
				expect(document.body.textContent).toContain(write.says.text);
				expect(says()).toEqual([]);
			}
		});
		expect(sent.filter((path) => path === write.calls)).toHaveLength(1);
		expect(vi.mocked(toast.success).mock.calls).toEqual([]);
	}

	it.each(IDLE)("$does: $calls is refused", async (write) => {
		render(page.live.default);
		await opened(() => testId("source-select-usb"));

		await write.act();

		await refused(write);
		expect(await streaming()).toBe(false);
		// Back to where it was, and ready to be pressed again.
		expect((named("Start Stream") as HTMLButtonElement).disabled).toBe(false);
		expect(document.body.textContent).not.toContain("Starting...");
	});

	it("hides the test pattern: streaming.setSourceVisibility is refused", async () => {
		const write: Write = {
			does: "hides the test pattern",
			calls: "streaming.setSourceVisibility",
			act: async () =>
				click(await opened(() => testId("sources-test-pattern-toggle"))),
			says: { text: "Couldn't complete the action" },
		};
		render(page.sources.default, { open: true });

		await write.act();

		await refused(write);
	});

	it("switches the camera while live: streaming.switchInput is refused", async () => {
		await owner.call("streaming.start", {});
		try {
			await waitFor(() => expect(page.subs.getIsStreaming()).toBe(true));
			before = await owner.call("streaming.getConfig");
			render(page.live.default);
			const write: Write = {
				does: "switches the camera",
				calls: "streaming.switchInput",
				act: async () =>
					click(await opened(() => named("Switch \u2013 HDMI Input"))),
				says: { toast: "Failed to switch input" },
			};

			await write.act();

			await refused(write);
			expect(await streaming()).toBe(true);
		} finally {
			await owner.call("streaming.stop");
			await waitFor(() => expect(page.subs.getIsStreaming()).toBe(false));
		}
	});

	// No control on either page makes these two calls today.
	it.each([
		[
			"switchAudio",
			(rpc: Page["client"]["rpc"]) =>
				rpc.streaming.switchAudio({ audio_input_id: "audio:elgato_wave3" }),
		],
		[
			"reloadAudioDelay",
			(rpc: Page["client"]["rpc"]) =>
				rpc.streaming.reloadAudioDelay({ delay_ms: 100 }),
		],
	])("streaming.%s is refused", async (_method, call) => {
		await expect(call(page.client.rpc)).rejects.toThrow(NOTICE);
		expect(shownNotices()).toEqual([NOTICE]);
		expect(await owner.call("streaming.getConfig")).toEqual(before);
	});

	it("calls streaming.reloadAudioDelay from nowhere", () => {
		const callers = (readdirSync(root, { recursive: true }) as string[])
			.filter((file) => /^(lib|main)\/.*\.(ts|svelte)$/.test(file))
			.filter((file) => !file.endsWith(".test.ts"))
			.filter((file) =>
				readFileSync(join(root, file), "utf8").includes("reloadAudioDelay"),
			);

		expect(callers).toEqual(["lib/rpc/client.ts"]);
	});
});
