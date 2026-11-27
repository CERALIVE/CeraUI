// @vitest-environment jsdom
/**
 * The reload notice lasts as long as it is true. The device is the backend's
 * entrypoint and is replaced mid-session, as a rollback or an update replaces
 * it; the page keeps running, reconnects with its own client and signs in again.
 * The page is today's, or the one from before the check, read from git.
 */
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { configure, waitFor } from "@testing-library/svelte";
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

import { checkOutOldTab } from "./old-tab";
import {
	PASSWORD,
	SERVE_MS,
	type ServedDevice,
	serveDevice,
	servedUrl,
} from "./served-device";

// Bounds on a busy machine: each wait ends on the device's answer, not on these.
configure({ asyncUtilTimeout: 15_000 });
vi.setConfig({ testTimeout: 60_000 });

const RealWebSocket = globalThis.WebSocket;
const NOTICE = "This page is out of date. Reload to continue.";
/** What today's page names on its socket under test. */
const PAGE_BUILD = "0.0.0-test";

let device: ServedDevice | undefined;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

describe.each([
	["today's page", () => resolve("src"), PAGE_BUILD],
	["a page from before the check", checkOutOldTab, undefined],
])("%s", (_page, checkOut, ownBuild) => {
	let root: string;
	let withdrawals: number;
	let onSocketOpen: ((target: ServedDevice) => void) | undefined;
	// Both pages' modules; today's types stand for the old page's.
	let page: {
		readonly subs: typeof import("$lib/rpc/subscriptions.svelte");
		readonly client: typeof import("$lib/rpc/client");
		readonly notices: typeof import("$lib/stores/notifications.svelte");
	};
	const load = <T>(path: string) =>
		import(/* @vite-ignore */ join(root, path)) as Promise<T>;

	const shown = () =>
		page.notices
			.getPersistent()
			.filter((entry) => entry.name === "ui-out-of-date")
			.map((entry) => entry.text);

	/** The device now running is `build`; the page is on it and signed in. */
	async function signInTo(build: string | undefined): Promise<void> {
		const opened = Promise.withResolvers<void>();
		let replacement: ServedDevice | undefined;
		onSocketOpen = (target) => {
			if (target === replacement) opened.resolve();
		};
		try {
			await device?.stop();
			replacement = await serveDevice(build, { max_br: 6000 });
			device = replacement;
			// Only the client's retry may dial; an open on the retired device is not readiness.
			await opened.promise;
		} finally {
			onSocketOpen = undefined;
		}
		expect(page.subs.getConnectionState()).toBe("connected");
		expect(
			await page.client.rpc.auth.login({
				password: PASSWORD,
				persistent_token: false,
			}),
		).toMatchObject({ success: true });
		// The sign-in's frames are decided before this later call is answered.
		await page.client.rpc.streaming.getConfig();
	}

	beforeAll(async () => {
		root = checkOut();
		vi.stubGlobal(
			"WebSocket",
			class extends RealWebSocket {
				constructor(url: string | URL) {
					const target = device;
					if (target === undefined) throw new Error("no device to reach");
					super(servedUrl(target, url));
					this.addEventListener("open", () => onSocketOpen?.(target), {
						once: true,
					});
					this.addEventListener("message", ({ data }) => {
						const { notification } = JSON.parse(data);
						for (const { id } of notification?.remove ?? [])
							if (id === "ui-out-of-date") withdrawals += 1;
					});
				}
			},
		);
		page = {
			subs: await load("lib/rpc/subscriptions.svelte.ts"),
			client: await load("lib/rpc/client.ts"),
			notices: await load("lib/stores/notifications.svelte.ts"),
		};
		device = await serveDevice("build-other", { max_br: 6000 });
		page.subs.initSubscriptions();
		await waitFor(() =>
			expect(page.subs.getConnectionState()).toBe("connected"),
		);
	}, SERVE_MS);

	afterAll(async () => {
		page?.client.rpcClient.disconnect();
		vi.unstubAllGlobals();
		await device?.stop();
		device = undefined;
		if (root !== resolve("src")) rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		page.notices.clearNotifications();
		withdrawals = 0;
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		error = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the notice while the device is still of another build", async () => {
		await signInTo("build-other");
		expect(shown()).toEqual([NOTICE]);

		await signInTo("build-third");

		expect(shown()).toEqual([NOTICE]);
		expect(withdrawals).toBe(0);
	});

	// The page from before the check names no build, so no device is of its own.
	it.each([
		...(ownBuild === undefined
			? []
			: [["in the page's own build", ownBuild] as const]),
		["with no build to compare", undefined] as const,
	])(
		"drops the notice when the device comes back %s, and saves",
		async (_how, build) => {
			await signInTo("build-other");
			expect(shown()).toEqual([NOTICE]);

			await signInTo(build);

			expect(shown()).toEqual([]);
			expect(
				await page.client.rpc.streaming.setConfig({ max_br: 5000 }),
			).toMatchObject({ success: true });
			expect(shown()).toEqual([]);
		},
	);

	it("takes the withdrawal of a notice it never showed without a word", async () => {
		await signInTo(undefined);

		expect(withdrawals).toBe(1);
		expect(shown()).toEqual([]);
		expect(
			[...warn.mock.calls, ...error.mock.calls].filter((call) =>
				JSON.stringify(call).includes("otification"),
			),
		).toEqual([]);
		// Still listening: a later notice is shown as before.
		await signInTo("build-other");
		expect(shown()).toEqual([NOTICE]);
	});
});
