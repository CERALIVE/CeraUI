/**
 * A client that just signed in learns whether a stream runs before anything
 * else, and without the status snapshot: one unreadable inventory row makes
 * that builder throw, and a page with no stream state cannot offer Stop.
 *
 * Driven over a real Bun WebSocket server and the real login procedure.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { lifecycleStateSchema } from "@ceraui/rpc/schemas";
import type { Server } from "bun";

import * as modemStatus from "../modules/modems/modem-status.ts";
import { setup } from "../modules/setup.ts";
import { pinLaunchedAudio } from "../modules/streaming/armed-stream-marker.ts";
import { acceptStartAudio } from "../modules/streaming/start-audio.ts";
import { seedStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { getDeviceStatsSnapshot } from "../modules/system/device-stats-snapshot.ts";
import { createWebSocketHandler } from "../rpc/adapter.ts";
import { initSocketData } from "../rpc/context.ts";
import { issueKioskSessionToken } from "../rpc/procedures/auth.procedure.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";
import type { SocketData } from "../rpc/types.ts";

type Frame = Record<string, unknown> & { id?: string };

const PASSWORD = "first-frame-fixture";
let server: Server<SocketData>;
let savedHash: string | undefined;
let savedSshUser: string | undefined;
const open = new Set<WebSocket>();

/** A signed-out page on the real server, recording every frame in order. */
async function connect() {
	const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
	open.add(client);
	const frames: Frame[] = [];
	const waiting: Array<{ id: string; resolve: () => void }> = [];
	client.addEventListener("message", ({ data }) => {
		const frame: Frame = JSON.parse(String(data));
		frames.push(frame);
		for (const entry of waiting) if (entry.id === frame.id) entry.resolve();
	});
	const opened = Promise.withResolvers<void>();
	client.addEventListener("open", () => opened.resolve(), { once: true });
	await opened.promise;
	function call(id: string, path: string[], input?: unknown): Promise<void> {
		const reply = Promise.withResolvers<void>();
		waiting.push({ id, resolve: reply.resolve });
		client.send(JSON.stringify({ id, path, input }));
		return reply.promise;
	}
	return {
		frames,
		call,
		close: () => client.close(),
		/** Ends when the server answers a later request: every push is in. */
		drain: () => call("drain", ["no", "such", "procedure"]),
	};
}

const streamFacts = (frames: Frame[]) =>
	frames.filter(
		({ status }) =>
			typeof status === "object" &&
			status !== null &&
			("is_streaming" in status || "stream_lifecycle" in status),
	);

beforeAll(() => {
	savedHash = getPasswordHash();
	// buildInitialStatus() fires getSshStatus(), which rejects on a malformed
	// setup.ssh_user a sibling test file may have left in the shared setup object.
	savedSshUser = setup.ssh_user;
	setup.ssh_user = undefined;
	server = Bun.serve<SocketData>({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (request, self) =>
			self.upgrade(request, { data: initSocketData() })
				? undefined
				: new Response("no upgrade", { status: 400 }),
		websocket: createWebSocketHandler(),
	});
});

afterAll(async () => {
	await server.stop(true);
	setPasswordHash(savedHash);
	setup.ssh_user = savedSshUser;
});

beforeEach(() => {
	setPasswordHash(
		Bun.password.hashSync(PASSWORD, { algorithm: "bcrypt", cost: 4 }),
	);
});

afterEach(() => {
	for (const client of open) client.close();
	open.clear();
	updateStatus(false);
	seedStreamLifecycleState("idle");
	pinLaunchedAudio(undefined);
});

describe("the first frame after a sign-in", () => {
	test.each([
		["password", () => ({ password: PASSWORD, persistent_token: false })],
		[
			"token",
			() => ({ token: issueKioskSessionToken(), persistent_token: true }),
		],
	])(
		"a %s sign-in gets the stream state before a snapshot that cannot be built",
		async (_, credentials) => {
			updateStatus(true);
			seedStreamLifecycleState("streaming");
			const modems = spyOn(
				modemStatus,
				"buildModemsWireMessage",
			).mockImplementation(() => {
				throw new Error("unreadable modem row");
			});
			try {
				const page = await connect();
				await page.call("login", ["auth", "login"], credentials());
				await page.drain();

				expect(page.frames[0]).toMatchObject({
					id: "login",
					result: { success: true },
				});
				expect(page.frames[1]).toEqual({
					status: { is_streaming: true, stream_lifecycle: "streaming" },
				});
				expect(streamFacts(page.frames)).toHaveLength(1);
			} finally {
				modems.mockRestore();
			}
		},
	);

	test.each([
		{
			name: "returning tab borrows no silence from the previous session",
			asrc: "Pipeline default",
			audioOff: false,
			returning: true,
		},
		{
			name: "fresh tab learns the current stream is silent",
			asrc: "No audio",
			audioOff: true,
			returning: false,
		},
		{
			name: "an adopted stream does not claim known audio",
			asrc: undefined,
			audioOff: undefined,
			returning: true,
		},
	])(
		"$name before a failed inventory-dependent status pull",
		async ({ asrc, audioOff, returning }) => {
			const credentials = {
				token: issueKioskSessionToken(),
				persistent_token: true,
			};
			if (returning) {
				updateStatus(true);
				seedStreamLifecycleState("streaming");
				pinLaunchedAudio(acceptStartAudio({ asrc: "No audio" }).config);
				const previous = await connect();
				await previous.call("login", ["auth", "login"], credentials);
				await previous.drain();
				expect(streamFacts(previous.frames).at(-1)?.status).toMatchObject({
					audio_off_active: true,
				});
				previous.close();
				updateStatus(false);
				seedStreamLifecycleState("idle");
			}
			pinLaunchedAudio(
				asrc === undefined ? undefined : acceptStartAudio({ asrc }).config,
			);
			updateStatus(true);
			seedStreamLifecycleState("streaming");
			const inventory = spyOn(
				modemStatus,
				"buildModemsWireMessage",
			).mockImplementation(() => {
				throw new Error("unreadable modem row");
			});
			try {
				const page = await connect();
				await page.call("login", ["auth", "login"], credentials);
				await page.call("pull", ["status", "getStatus"]);
				expect(page.frames[0]).toMatchObject({
					id: "login",
					result: { success: true },
				});
				expect(page.frames[1]).toEqual({
					status: {
						is_streaming: true,
						stream_lifecycle: "streaming",
						...(audioOff === undefined ? {} : { audio_off_active: audioOff }),
					},
				});
				expect(page.frames.find(({ id }) => id === "pull")).toMatchObject({
					error: { code: "INTERNAL_ERROR" },
				});
				expect(streamFacts(page.frames)).toHaveLength(1);
			} finally {
				inventory.mockRestore();
			}
		},
	);

	test.each(
		lifecycleStateSchema.options.flatMap((stream_lifecycle) =>
			[true, false].map((is_streaming) => ({ is_streaming, stream_lifecycle })),
		),
	)(
		"carries the pair as it is once the sign-in resolves: %j",
		async (current) => {
			updateStatus(!current.is_streaming);
			seedStreamLifecycleState(
				current.stream_lifecycle === "idle" ? "streaming" : "idle",
			);
			// The stream moves on while the server is verifying the password.
			const verify = spyOn(Bun.password, "verify").mockImplementation(
				async () => {
					updateStatus(current.is_streaming);
					seedStreamLifecycleState(current.stream_lifecycle);
					return true;
				},
			);
			try {
				const page = await connect();
				await page.call("login", ["auth", "login"], {
					password: PASSWORD,
					persistent_token: false,
				});
				await page.drain();

				expect(verify).toHaveBeenCalledTimes(1);
				expect(page.frames[1]).toEqual({ status: current });
				for (const { status } of streamFacts(page.frames))
					expect(status).toMatchObject(current);
			} finally {
				verify.mockRestore();
			}
		},
	);

	test("is followed by the same hydration as before, in the same order", async () => {
		updateStatus(true);
		seedStreamLifecycleState("streaming");
		const page = await connect();
		await page.call("login", ["auth", "login"], {
			password: PASSWORD,
			persistent_token: false,
		});
		await page.drain();

		// Broadcasts carry a seq; the add-on snapshot is sent when it resolves.
		const [first, ...hydration] = page.frames.filter(
			(frame) => !("id" in frame) && !("seq" in frame) && !("addons" in frame),
		);
		expect(first).toEqual({
			status: { is_streaming: true, stream_lifecycle: "streaming" },
		});
		const snapshot = JSON.parse(JSON.stringify(buildInitialStatus()));
		expect(hydration.map((frame) => Object.keys(frame)[0])).toEqual([
			"config",
			"pipelines",
			...(snapshot.relays ? ["relays"] : []),
			"status",
			"netif",
			"uplinks",
			"uplink-steering",
			"uplink-shaper",
			"sharing_diag",
			"sensors",
			...(getDeviceStatsSnapshot() ? ["device-stats"] : []),
			"cpu",
			"revisions",
			"acodecs",
			"devices",
			"sources",
			...(snapshot.capabilities ? ["capabilities"] : []),
			"health",
			"notification",
			"notification",
		]);
		expect(hydration.at(-1)).toMatchObject({
			notification: { remove: [{ id: "ui-out-of-date" }] },
		});
		expect(hydration.find((frame) => "status" in frame)).toEqual({
			status: snapshot.status,
		});
	});

	test.each([
		["a wrong password", { password: "wrong", persistent_token: false }],
		["an unknown token", { token: "unknown", persistent_token: true }],
		["no credential", { persistent_token: false }],
	])("%s is told nothing about the stream", async (_, credentials) => {
		updateStatus(true);
		seedStreamLifecycleState("streaming");
		const page = await connect();
		await page.call("read", ["status", "getStatus"]);
		await page.call("login", ["auth", "login"], credentials);
		await page.call("stop", ["streaming", "stop"]);
		await page.drain();

		expect(page.frames.map(({ id }) => id)).toEqual([
			"read",
			"login",
			"stop",
			"drain",
		]);
		expect(page.frames[0]).toHaveProperty("error");
		expect(page.frames[1]).toMatchObject({ result: { success: false } });
		expect(JSON.stringify(page.frames)).not.toContain("is_streaming");
		expect(JSON.stringify(page.frames)).not.toContain("stream_lifecycle");
	});

	test("an unconfigured device tells a signed-out page only to set a password", async () => {
		setPasswordHash(undefined);
		updateStatus(true);
		const page = await connect();
		await page.call("login", ["auth", "login"], {
			password: PASSWORD,
			persistent_token: false,
		});
		await page.drain();

		expect(page.frames[0]).toEqual({ status: { set_password: true } });
		expect(streamFacts(page.frames)).toEqual([]);
	});

	test("goes to the page that signed in and to no other page", async () => {
		updateStatus(true);
		seedStreamLifecycleState("streaming");
		const credentials = { password: PASSWORD, persistent_token: false };
		const guest = await connect();
		const peer = await connect();
		await peer.call("login", ["auth", "login"], credentials);
		await peer.drain();
		const heard = peer.frames.length;

		const page = await connect();
		await page.call("login", ["auth", "login"], credentials);
		await page.drain();
		await Promise.all([guest.drain(), peer.call("after", ["none"])]);

		expect(streamFacts(page.frames)).toHaveLength(2);
		expect(streamFacts(peer.frames.slice(heard))).toEqual([]);
		expect(guest.frames.map(({ id }) => id)).toEqual(["drain"]);
	});
});
