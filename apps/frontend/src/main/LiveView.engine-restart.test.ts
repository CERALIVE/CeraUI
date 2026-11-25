// @vitest-environment jsdom
/// <reference types="node" />
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { rpcClient } from "../lib/rpc/client";
import type * as Subscriptions from "../lib/rpc/subscriptions.svelte";
import {
	getStatus,
	initSubscriptions,
	resetState,
} from "../lib/rpc/subscriptions.svelte";
import {
	button,
	controls,
	installJsdomShims,
} from "../tests/fixtures/real-cockpit-harness";
import { FakeWebSocket, socket } from "../tests/helpers/update-device";
import LiveView from "./LiveView.svelte";

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) => {
	const real = await importOriginal<typeof Subscriptions>();
	const { deviceGettersMock } = await import(
		"../tests/fixtures/real-store-live"
	);
	return {
		...(await deviceGettersMock(real)),
		getCapabilities: real.getCapabilities,
	};
});
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));
const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/preview/PreviewCanvas.svelte", noop);
vi.mock("$lib/components/custom/ComingSoon.svelte", noop);
vi.mock("$main/dialogs/ServerDialog.svelte", noop);
vi.mock("$main/dialogs/AudioDialog.svelte", noop);
vi.mock("$main/dialogs/EncoderDialog.svelte", noop);

type Transcript = {
	readonly initial: readonly unknown[];
	readonly outage: readonly unknown[];
	readonly replacement: readonly unknown[];
	readonly modes: readonly unknown[];
	readonly mutations: readonly string[];
	readonly closes: number;
};

const run = promisify(execFile);
const Socket = globalThis.WebSocket;
// biome-ignore lint/complexity/useLiteralKeys: shared test-only socket URL seam
const getUrl = rpcClient["getUrl"];
beforeAll(() => installJsdomShims(vi.fn()));
afterEach(() => {
	cleanup();
	rpcClient.disconnect();
	resetState();
	globalThis.WebSocket = Socket;
	// biome-ignore lint/complexity/useLiteralKeys: restore the test-only seam
	rpcClient["getUrl"] = getUrl;
});

test.each(["snapshot", "legacy"] as const)(
	"an open LiveView recovers from engine loss with a %s replacement",
	async (kind) => {
		const dir = await mkdtemp(join(tmpdir(), "live-recovery-"));
		try {
			await writeFile(
				join(dir, "setup.json"),
				JSON.stringify({
					hw: "rk3588",
					engine: "cerastream",
					cerastream_socket: join(dir, "engine.sock"),
					ips_file: join(dir, "ips"),
				}),
			);
			const { stdout } = await run(
				"bun",
				[
					join(
						import.meta.dirname,
						"../../../backend/test-harness/live-engine-restart.ts",
					),
					kind,
				],
				{
					cwd: dir,
					env: {
						...process.env,
						CERALIVE_STREAMING_MARKER: join(dir, "streaming"),
						CERALIVE_EVENTS_DIR: join(dir, "events"),
					},
					timeout: 12_000,
				},
			);
			const line = stdout
				.split("\n")
				.find((s) => s.startsWith("LIVE_RESTART "));
			if (!line) throw new Error(`Missing WebSocket transcript: ${stdout}`);
			const frames: Transcript = JSON.parse(line.slice("LIVE_RESTART ".length));

			FakeWebSocket.current = undefined;
			globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
			// biome-ignore lint/complexity/useLiteralKeys: same seam as the adjacent socket tests
			rpcClient["getUrl"] = () => "ws://device.test/ws";
			initSubscriptions();
			if (!FakeWebSocket.current) rpcClient.connect();
			socket().readyState = FakeWebSocket.OPEN;
			socket().onopen?.();
			const deliver = (messages: readonly unknown[]) => {
				flushSync(() => {
					for (const message of messages) socket().deliver(message);
				});
			};
			deliver(frames.initial);
			const { container, queryByTestId } = render(LiveView);
			expect(
				container.querySelector('[data-testid="live-bar"]'),
			).not.toBeNull();

			deliver(frames.outage);
			const offline = () =>
				container.querySelector(
					'[data-testid="capability-engine-unavailable"]',
				);
			const startEnabled = () =>
				controls(container).some(
					({ label, disabled }) => label === "Start Stream" && !disabled,
				);
			expect(offline()).not.toBeNull();
			expect(getStatus()?.stream_lifecycle).toBe("reconciling");
			expect(startEnabled()).toBe(false);

			deliver(frames.replacement);
			expect(offline()).toBeNull();
			expect(getStatus()?.stream_lifecycle).toBe(
				kind === "snapshot" ? "idle" : "reconciling",
			);
			const done = queryByTestId("summary-done");
			if (done) await fireEvent.click(done);
			expect(startEnabled()).toBe(kind === "snapshot");
			if (kind === "snapshot")
				expect(button(container, "Start Stream").disabled).toBe(false);
			expect(frames.modes).toEqual([kind === "snapshot" ? true : null]);
			expect(frames.mutations).toEqual([]);
			expect(frames.closes).toBe(0);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	},
	16_000,
);
