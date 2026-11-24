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
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";

/** main just before the live-audio plan: the last handler with no `config_clear`. */
const OLD_TAB = "17dda165792862a009823440cb4b78e2812914d0";
const FRONTEND = resolve(".");
const BACKEND = resolve("../backend");

let oldSource: string;
/** [config with the manual codec], [config without it, then the clear]. */
let frames: string[];

/** What a client's socket is sent while Encoder goes from H.264 to Automatic. */
function broadcastBytes(): string[] {
	const cwd = mkdtempSync(join(tmpdir(), "old-tab-backend-"));
	try {
		copyFileSync(join(BACKEND, "setup.json"), join(cwd, "setup.json"));
		execFileSync(
			"bun",
			[
				"-e",
				`
				const src = ${JSON.stringify(join(BACKEND, "src"))};
				const { getConfig, setConfigFilePath } = await import(src + "/modules/config.ts");
				const { broadcastConfig } = await import(src + "/rpc/config-broadcast.ts");
				const { createContext } = await import(src + "/rpc/context.ts");
				const { addClient } = await import(src + "/rpc/events.ts");
				const { setConfigProcedure } = await import(src + "/rpc/procedures/streaming.procedure.ts");
				const { call } = await import(Bun.resolveSync("@orpc/server", src));
				setConfigFilePath(process.cwd() + "/config.json");
				Object.assign(getConfig(), { max_br: 6000, balancer: "adaptive", video_codec: "h264" });
				const sent = [];
				const ws = { data: { isAuthenticated: true, lastActive: 0 }, send: (m) => { sent.push(m); }, close() {} };
				addClient(ws);
				broadcastConfig(getConfig());
				await call(setConfigProcedure, { video_codec: null, balancer: "fixed" }, { context: createContext(ws) });
				const kinds = ["config", "config_clear"];
				await Bun.write("frames.json", JSON.stringify(sent.filter((m) => kinds.includes(Object.keys(JSON.parse(m))[0]))));
				process.exit(0);
				`,
			],
			{ cwd, stdio: ["ignore", "ignore", "pipe"] },
		);
		return JSON.parse(readFileSync(join(cwd, "frames.json"), "utf8"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

/** The old frontend's `src/lib` and `src/main`, importing each other, not today's. */
function checkOutOldTab(): string {
	mkdirSync(".vitest", { recursive: true });
	const root = mkdtempSync(join(FRONTEND, ".vitest/old-tab-"));
	const archive = execFileSync(
		"git",
		[
			"archive",
			`${OLD_TAB}:apps/frontend/src`,
			"lib",
			"main",
			":(exclude,glob)**/*.test.ts",
		],
		{ cwd: resolve("../.."), maxBuffer: 1 << 28 },
	);
	execFileSync("tar", ["-x", "-C", root], { input: archive });
	for (const entry of readdirSync(root, { recursive: true }) as string[]) {
		if (!/\.(ts|svelte)$/.test(entry)) continue;
		const path = join(root, entry);
		const source = readFileSync(path, "utf8");
		writeFileSync(
			path,
			source.replace(/(["'])\$(lib|main)(?=[/"'])/g, `$1${root}/$2`),
		);
	}
	return root;
}

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

beforeAll(() => {
	frames = broadcastBytes();
	oldSource = checkOutOldTab();
}, 60_000);

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
