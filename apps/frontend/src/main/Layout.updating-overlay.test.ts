// @vitest-environment jsdom
/**
 * The full-screen update overlay is mounted ONCE, globally, by Layout — driven
 * only by `status.updating`. It is deliberately NOT owned by whichever surface
 * started the update, so an operator who opened Settings → Software Updates and
 * one who tapped an update notification see the identical live progress.
 *
 * A live report read as "the overlay only appears from the notification path".
 * It did not: the mount is trigger-agnostic and always was — no update had
 * actually started, so no `status.updating` frame ever arrived (see
 * `software-updates-start-refusal.test.ts` in the backend for that root cause).
 * These tests lock the trigger-agnostic mount and the real percentage/phase
 * render, so a future refactor cannot quietly make the overlay path-specific.
 *
 * Every case drives the REAL `subscriptions.svelte.ts` ingestion — only the RPC
 * transport (`$lib/rpc/client`) is doubled. A mocked `getStatus()` would prove
 * the render and nothing about the store beneath it, and the reconnect case
 * below is precisely a claim about that store: an update survives a backend
 * restart because nothing on the socket-close path clears the `updating` slot,
 * and the post-login initial push replaces it rather than racing it.
 */
import type { StatusMessage } from "@ceraui/rpc/schemas";
import { render, waitFor } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { toast } from "svelte-sonner";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import restart from "../tests/fixtures/update-restart-tab.json";
import offline from "../tests/fixtures/update-restart-tab-offline.json";
import PackagesSection from "./dialogs/updates/PackagesSection.svelte";
import Layout from "./Layout.svelte";

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("./Auth.svelte", noop);
vi.mock("./DisconnectedBanner.svelte", noop);
vi.mock("./MainView.svelte", noop);
vi.mock("./layout/LayoutToastHost.svelte", noop);
vi.mock("./layout/UpdateBanner.svelte", noop);
vi.mock("$lib/components/custom/pwa", async () => {
	const Noop = (await import("../tests/fixtures/Noop.svelte")).default;
	return { OfflinePage: Noop, PWAStatus: Noop };
});

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The ONLY double: the RPC transport. `initSubscriptions()` registers the real
// `handleMessage` / `handleConnectionChange` here, so the tests below feed the
// genuine ingestion path rather than a stubbed getter.
const transport = vi.hoisted(() => ({
	message: undefined as
		| ((type: string, data: unknown, seq?: number) => void)
		| undefined,
	connection: undefined as ((state: string) => void) | undefined,
	// The reconnect safety hydrate deliberately says NOTHING about `updating`:
	// a hydrate that omits the field must not retract an update in progress.
	hydratedStatus: {} as Record<string, unknown>,
	hydrateCalls: 0,
	// What the device answered, in order, to which question.
	outcomes: [] as { request: unknown; outcome: unknown }[],
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: { login: vi.fn(async () => ({ success: true })) },
		streaming: { getConfig: vi.fn(async () => ({})) },
		ui: { heartbeat: vi.fn(async () => undefined) },
		system: {
			// The device answers only the question it was asked.
			updateOutcome: vi.fn((input: unknown) => {
				const next = transport.outcomes.shift();
				return Promise.resolve(
					next && JSON.stringify(next.request) === JSON.stringify(input)
						? next.outcome
						: { kind: "unknown" },
				);
			}),
		},
		status: {
			getStatus: vi.fn(async () => {
				transport.hydrateCalls += 1;
				return transport.hydratedStatus;
			}),
		},
	},
	rpcClient: {
		onMessage: (fn: (type: string, data: unknown, seq?: number) => void) => {
			transport.message = fn;
		},
		onConnectionChange: (fn: (state: string) => void) => {
			transport.connection = fn;
			return () => undefined;
		},
		connect: () => undefined,
		isConnected: () => true,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({
	getShouldShowOfflinePage: () => false,
}));

// The drop stamp stays null unless a case sets it, as a drop the layout saw.
vi.mock("$lib/stores/connection-ux.svelte", async () => ({
	deriveConnectionSurfaceUx: () => ({
		showOfflineBanner: false,
		showAuthTimeout: false,
	}),
	getDisconnectedSince: (
		await import("../tests/fixtures/disconnected-since.svelte.ts")
	).getDisconnectedSince,
	getGraceNow: () => 0,
	markAuthenticated: vi.fn(),
	clearSessionExpired: vi.fn(),
	markSessionExpired: vi.fn(),
	shouldExpireSession: () => false,
	wasAuthenticated: () => true,
}));

vi.mock("$lib/stores/auth-status.svelte", () => ({
	authenticate: vi.fn(async () => ({ kind: "ok" })),
	authenticateWithToken: vi.fn(async () => ({ kind: "ok" })),
	getAuthMessage: () => ({ success: true }),
	authStatusStore: {
		value: true,
		set: vi.fn(),
		subscribe: (cb: (v: boolean) => void) => {
			cb(true);
			return () => {};
		},
	},
}));

import { rpc } from "$lib/rpc/client";
import {
	initSubscriptions,
	resetState,
} from "../lib/rpc/subscriptions.svelte.ts";
import { setDisconnectedSince } from "../tests/fixtures/disconnected-since.svelte.ts";

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});

type UpdatingFrame = Exclude<StatusMessage["updating"], boolean | null>;

/** Push a `status` broadcast through the real ingestion path. */
function pushStatus(frame: Record<string, unknown>): void {
	transport.message?.("status", frame);
	flushSync();
}

// The backend's install-phase markers; the number is APT's own percentage.
const installing = { total: 1, downloading: 0, unpacking: 0, setting_up: 1 };

function updating(frame: UpdatingFrame): void {
	pushStatus({ updating: frame });
}

/**
 * The overlay's own title node. Identity matters: if the mount predicate ever
 * dips false, Svelte destroys this node and builds a new one on the way back —
 * so a stable reference across a transition IS the "no flicker" proof, and it
 * does not depend on catching an intermediate paint.
 */
function overlayTitle(): Element | undefined {
	return Array.from(document.querySelectorAll("h1")).find((el) =>
		el.textContent?.includes("Updating Device Software"),
	);
}

beforeEach(() => {
	localStorage.setItem("auth", "token-abc");
	transport.hydratedStatus = {};
	transport.hydrateCalls = 0;
	transport.outcomes = [];
	setDisconnectedSince(null);
	resetState();
	initSubscriptions();
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("Layout — the update overlay is mounted globally, not per trigger", () => {
	it("mounts on any status.updating frame, whatever started the update", async () => {
		updating({ total: 4, downloading: 4, unpacking: 2, setting_up: 0 });
		render(Layout);

		await waitFor(() => {
			expect(document.body.textContent).toContain("Updating Device Software");
		});
	});

	it("renders the real percentage and phase, not a bare 'Applying…'", async () => {
		// APT reports 50% of its install plan.
		updating({ ...installing, percent: 50 });
		render(Layout);

		await waitFor(() => {
			expect(document.body.textContent).toContain("50%");
		});
		expect(document.body.textContent).toContain("Installing");
		expect(document.body.textContent).not.toMatch(/\d+\s+of\s+\d+\s+steps/);
	});

	it("stays unmounted while no update is running", async () => {
		render(Layout);

		await waitFor(() => {
			expect(document.body.textContent).not.toContain(
				"Updating Device Software",
			);
		});
	});
});

describe("Layout — the update overlay survives a backend restart", () => {
	it("shows honest activity before stdout, never rewinds across reattach, then shows the replayed install phase", async () => {
		const silent = { total: 0, downloading: 0, unpacking: 0, setting_up: 0 };
		updating(silent);
		render(Layout);
		await waitFor(() => expect(overlayTitle()).toBeDefined());
		const mounted = overlayTitle();
		const phase = () => document.querySelector('[data-testid="update-phase"]');
		const bar = () =>
			document.querySelector(
				'[data-testid="updating-overlay"] [role="progressbar"]',
			);

		expect(phase()?.textContent).toContain("Preparing or downloading packages");
		expect(bar()?.getAttribute("data-state")).toBe("indeterminate");

		// The old process published APT's install percentage before the
		// package's postinst restarted it.
		updating({ ...installing, percent: 40 });
		expect(bar()?.getAttribute("aria-valuenow")).toBe("40");
		transport.connection?.("disconnected");
		flushSync();
		expect(overlayTitle()).toBe(mounted);
		transport.connection?.("connected");
		await vi.waitFor(() => expect(transport.hydrateCalls).toBeGreaterThan(0));

		// The restarted backend has not read the unit yet, so its initial push
		// omits `updating`; the overlay keeps APT's last number.
		pushStatus({
			is_streaming: false,
			wifi: {},
			modems: {},
			update_state: { kind: "idle" },
		});
		flushSync();
		expect(overlayTitle()).toBe(mounted);
		expect(bar()?.getAttribute("aria-valuenow")).toBe("40");

		// A stale download frame or an empty one never rewinds this install, and
		// the 40 that no frame carries any more is not shown as live.
		updating({
			total: 1,
			downloading: 1,
			unpacking: 0,
			setting_up: 0,
			percent: 96,
		});
		expect(overlayTitle()).toBe(mounted);
		expect(phase()?.textContent).toContain("Installing");
		expect(bar()?.getAttribute("data-state")).toBe("indeterminate");
		expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
		updating(silent);
		expect(overlayTitle()).toBe(mounted);
		expect(phase()?.textContent).toContain("Installing");
		expect(bar()?.getAttribute("data-state")).toBe("indeterminate");
		expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
		expect(document.body.textContent).not.toMatch(/\d+\s+of\s+\d+\s+steps/);

		// The new process replays the status file and publishes where APT is.
		updating({ ...installing, percent: 60 });
		expect(overlayTitle()).toBe(mounted);
		expect(phase()?.textContent).toContain("Installing");
		expect(bar()?.getAttribute("aria-valuenow")).toBe("60");
		expect(bar()?.getAttribute("aria-valuemax")).toBe("100");
		expect(bar()?.getAttribute("aria-valuetext")).toBe("60%");
	});

	it("an unchanged frame delivered after a drop shows its number again", async () => {
		updating({ ...installing, percent: 60 });
		render(Layout);
		const bar = () =>
			document.querySelector(
				'[data-testid="updating-overlay"] [role="progressbar"]',
			);
		await waitFor(() =>
			expect(bar()?.getAttribute("aria-valuenow")).toBe("60"),
		);
		// The socket drops: the held 60 is no longer live.
		transport.connection?.("disconnected");
		setDisconnectedSince(1);
		flushSync();
		expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
		// Back, re-authenticated, but nothing delivered on the new link yet.
		transport.connection?.("connected");
		setDisconnectedSince(null);
		await vi.waitFor(() => expect(transport.hydrateCalls).toBeGreaterThan(0));
		flushSync();
		expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
		// The device's first frame is the same 60: delivered now, so live.
		updating({ ...installing, percent: 60 });
		expect(bar()?.getAttribute("aria-valuenow")).toBe("60");
	});

	it("starts the next install from its own phase, not the last one's", () => {
		updating({ ...installing, percent: 70 });
		render(Layout);
		expect(overlayTitle()).toBeDefined();
		updating({ ...installing, result: "E: dpkg returned an error code (1)" });
		expect(overlayTitle()).toBeUndefined();

		updating({ total: 0, downloading: 0, unpacking: 0, setting_up: 0 });
		const phase = document.querySelector('[data-testid="update-phase"]');
		expect(phase?.textContent).toContain("Preparing or downloading packages");
	});

	it("is on screen from the FIRST paint when Layout re-mounts onto an update already in flight", () => {
		updating({ total: 4, downloading: 4, unpacking: 1, setting_up: 0 });
		render(Layout);

		// Deliberately no `waitFor`: the store already carries the frame, so the
		// overlay must be on screen the moment the mount settles, with no extra
		// async round. Do not "fix" a future failure here by adding `waitFor` —
		// that would let a mount predicate that needs a second settle pass, and a
		// second settle is exactly the flash of idle layout this locks out.
		expect(overlayTitle()).toBeDefined();
	});

	it("stays mounted across close → reconnect → initial push, with no flicker to the idle layout", async () => {
		updating({ ...installing, percent: 30 });
		render(Layout);

		await waitFor(() => {
			expect(overlayTitle()).toBeDefined();
		});
		const mounted = overlayTitle();
		expect(mounted).toBeDefined();

		// 1. The socket drops. Nothing on this path clears the `updating` slot —
		//    `resetState()` is a test/logout seam and is NOT wired to a close — so
		//    the overlay must stay exactly where it is.
		transport.connection?.("disconnected");
		flushSync();
		await tick();
		expect(overlayTitle()).toBe(mounted);

		// 2. The socket comes back. The reconnect re-auth + safety hydrate run, and
		//    that hydrate says nothing about `updating`; an omitted field is
		//    preserved by the status merge, so it must not retract the overlay.
		transport.connection?.("connected");
		flushSync();
		await tick();
		expect(overlayTitle()).toBe(mounted);

		// Drain the async reauth/hydrate dispatches.
		await vi.waitFor(() => {
			expect(transport.hydrateCalls).toBeGreaterThan(0);
		});
		await tick();
		flushSync();
		expect(overlayTitle()).toBe(mounted);

		// 3. The backend's post-login initial push arrives and REPLACES the slot
		//    with the live frame (todo 15 locks that `buildInitialStatus()` carries
		//    `updating`/`update_state`). The overlay updates in place — the same
		//    node, never destroyed and rebuilt.
		pushStatus({
			is_streaming: false,
			wifi: {},
			modems: {},
			updating: { ...installing, percent: 58 },
			update_state: { kind: "idle" },
		});
		await tick();

		expect(overlayTitle()).toBe(mounted);
		expect(document.body.textContent).toContain("Updating Device Software");
		// The progress moved, so the mount really is reading the post-reconnect
		// frame rather than a frozen pre-drop snapshot.
		expect(document.body.textContent).toContain("58%");
	});
});

describe("Layout — one tab across the owner's two-restart update", () => {
	type Seen =
		| { readonly at: "connected" | "disconnected" }
		| { readonly at: "push" | "pull"; readonly status: Record<string, unknown> }
		| { readonly at: "moment"; readonly name: string }
		| {
				readonly at: "asked";
				readonly request: unknown;
				readonly outcome: unknown;
		  };

	// What the open tab shows: the overlay's phase and number, and Settings' line.
	function view(): string {
		const overlay = document.querySelector('[data-testid="updating-overlay"]');
		const phase = document.querySelector('[data-testid="update-phase"]');
		const bar = overlay?.querySelector('[role="progressbar"]');
		const settings = document.querySelector(
			'[data-testid="update-package-phase"]',
		);
		const text = (node: Element | null | undefined) =>
			node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
		return [
			overlay
				? `overlay: ${text(phase)} ${bar?.getAttribute("aria-valuenow") ?? "-"}`
				: "no overlay",
			`settings: ${text(settings) || "-"}`,
		].join(" | ");
	}

	// Feeds the real backend's frames through the real store, as the tab got them.
	async function replay(seen: readonly Seen[]) {
		render(Layout);
		render(PackagesSection, {
			props: {
				surface: {
					packagesReady: true,
					packagesOutcome: undefined,
					installPackages: vi.fn(),
					observeLegacy: vi.fn(),
					pending: () => false,
				} as never,
			},
		});
		// The device answers the tab's questions as it answered the recorded tab.
		transport.outcomes = seen.flatMap((e) =>
			e.at === "asked" ? [{ request: e.request, outcome: e.outcome }] : [],
		);
		// A tab that is opening has no connection yet.
		transport.connection?.("disconnected");
		const moments: Record<string, string> = {};
		const trace: string[] = [];
		for (const [index, event] of seen.entries()) {
			if (event.at === "connected") {
				const next = seen.slice(index + 1).find((e) => e.at !== "moment");
				transport.hydratedStatus = next?.at === "pull" ? next.status : {};
				const calls = transport.hydrateCalls;
				transport.connection?.("connected");
				await vi.waitFor(() =>
					expect(transport.hydrateCalls).toBeGreaterThan(calls),
				);
				await tick();
			} else if (event.at === "disconnected") {
				transport.connection?.("disconnected");
			} else if (event.at === "push") {
				pushStatus(event.status);
			} else if (event.at === "pull") {
				// The hydrate at connect already applied it; a later pull is ingested too.
				if (seen[index - 1]?.at !== "connected") pushStatus(event.status);
			} else if (event.at === "moment") {
				moments[event.name] = view();
				continue;
			} else if (event.at === "asked") {
				// The tab acts on the answer to its last question before the next event.
				await vi.mocked(rpc.system.updateOutcome).mock.results.at(-1)?.value;
				await tick();
			}
			flushSync();
			trace.push(view());
		}
		return { moments, trace };
	}

	const installing = (n: number) =>
		`overlay: Installing ${n} | settings: Installing · ${n}%`;
	const held = (phase: string) => `overlay: ${phase} - | settings: ${phase}`;
	const nothing = "no overlay | settings: -";
	const asking = "overlay: Installing - | settings: -";
	// The vector the install's own frames carried, as the backend sent them.
	const carriedIn = (seen: readonly Seen[]) =>
		seen
			.flatMap((e) => {
				const u =
					e.at === "push" || e.at === "pull"
						? (e.status.updating as { targets?: unknown } | null | undefined)
						: undefined;
				return u?.targets === undefined ? [] : [u.targets];
			})
			.at(0);
	const askedIn = (seen: readonly Seen[]) =>
		seen.flatMap((e) => (e.at === "asked" ? [e.request] : []));
	// Settings' own line, per continuous run of frames: never a lower phase or
	// number. It shows the device's state, so the restart's gap starts it over.
	function settingsNeverRewinds(trace: readonly string[]) {
		const rank = (phase: string) =>
			phase === "Installing" ? 2 : phase === "Downloading" ? 1 : 0;
		let reached = { phase: -1, n: -1 };
		for (const shown of trace) {
			const [, phase = "-", n] =
				/settings: ([^·]+?)(?: · (\d+)%)?$/.exec(shown) ?? [];
			if (phase === "-") {
				reached = { phase: -1, n: -1 };
				continue;
			}
			expect(rank(phase)).toBeGreaterThanOrEqual(reached.phase);
			if (rank(phase) > reached.phase) reached = { phase: rank(phase), n: -1 };
			if (n === undefined) continue;
			expect(Number(n)).toBeGreaterThanOrEqual(reached.n);
			reached = { ...reached, n: Number(n) };
		}
	}

	it("renders every moment the real backend processes sent it", async () => {
		const { moments, trace } = await replay(restart.seen as Seen[]);

		expect(moments).toEqual({
			idle: nothing,
			downloading: held("Downloading"),
			"installing 40%": installing(40),
			"postinst stopped the backend": installing(40),
			// main's first status says nothing is updating: the tab holds the phase
			// without its number while it asks, and the device says it still runs.
			"re-authenticated before recovery": asking,
			// The reattached unit's first frame is an earlier phase: never shown.
			"attached, nothing read yet": `overlay: Installing - | settings: Preparing or downloading packages`,
			"recovered at installing 60%": installing(60),
			"installing 80%": installing(80),
			outcome: nothing,
			"completion restart": nothing,
			"re-authenticated after the outcome": nothing,
		});
		// It asked once, about the vector the install's own frames carried:
		// the very question the recorded tab asked the real backend.
		const targets = carriedIn(restart.seen as Seen[]);
		expect(targets).toHaveLength(10);
		expect(
			vi.mocked(rpc.system.updateOutcome).mock.calls.map(([input]) => input),
		).toEqual([{ targets }]);
		expect(askedIn(restart.seen as Seen[])[0]).toEqual({ targets });
		settingsNeverRewinds(trace);
		// After every event: no step counts, and from the first download to the
		// outcome never an empty frame, a lower phase or a lower number.
		expect(trace.some((shown) => /\bsteps?\b|\bof\b/.test(shown))).toBe(false);
		const first = trace.indexOf(held("Downloading"));
		const closed = trace.findIndex(
			(shown, i) => i > first && shown === nothing,
		);
		// A phase held without its number is unknown, never a lower number.
		const parse = (shown: string) => {
			const [, phase, n] = /overlay: (\w+) (\d+|-)/.exec(shown) ?? [];
			return {
				phase: phase === "Installing" ? 2 : phase === "Downloading" ? 1 : 0,
				n: n === undefined || n === "-" ? undefined : Number(n),
			};
		};
		const live = trace.slice(first, closed).map(parse);
		expect(live.every((frame) => frame.phase >= 1)).toBe(true);
		let reached = { phase: 0, n: -1 };
		for (const frame of live) {
			expect(frame.phase).toBeGreaterThanOrEqual(reached.phase);
			if (frame.phase > reached.phase) reached = { phase: frame.phase, n: -1 };
			if (frame.n === undefined) continue;
			expect(frame.n).toBeGreaterThanOrEqual(reached.n);
			reached = { ...reached, n: frame.n };
		}
		expect(trace.slice(closed).every((shown) => shown === nothing)).toBe(true);
		// The outcome is announced once, as a success.
		expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
	});

	it("a lower number after the device said it does not know is never shown", async () => {
		const frame = (percent?: number) => ({
			total: 1,
			downloading: 0,
			unpacking: 0,
			setting_up: 1,
			...(percent === undefined ? {} : { percent }),
		});
		const at = (percent?: number) => ({
			updating: frame(percent),
			update_state: { kind: "installing", progress: frame(percent) },
		});
		const { moments } = await replay([
			{ at: "connected" },
			{ at: "pull", status: at(60) },
			{ at: "moment", name: "60" },
			{ at: "push", status: at() },
			{ at: "moment", name: "unknown" },
			{ at: "push", status: at(40) },
			{ at: "moment", name: "40" },
			{ at: "push", status: at(70) },
			{ at: "moment", name: "70" },
		]);
		expect(moments).toEqual({
			"60": installing(60),
			unknown: held("Installing"),
			"40": held("Installing"),
			"70": installing(70),
		});
	});

	it("a tab offline through the outcome learns it from the next backend", async () => {
		const { moments, trace } = await replay(offline.seen as Seen[]);
		expect(moments).toMatchObject({
			"installing 80%": installing(80),
			"offline through the outcome": installing(80),
			// Told only that nothing is updating: it holds the phase and asks.
			"re-authenticated after the outcome": asking,
		});
		// The device answers from the installed versions: the overlay closes on success.
		expect(trace.at(-1)).toBe(nothing);
		// Asked after each restart, each time about the frames' own vector: told
		// the unit still runs, then that its versions are installed.
		const targets = carriedIn(offline.seen as Seen[]);
		expect(
			vi.mocked(rpc.system.updateOutcome).mock.calls.map(([input]) => input),
		).toEqual([{ targets }, { targets }]);
		expect(askedIn(offline.seen as Seen[]).slice(0, 2)).toEqual([
			{ targets },
			{ targets },
		]);
		settingsNeverRewinds(trace);
		expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
	});
});

describe("Layout — a tab that missed the install's result is told what the device knows", () => {
	const ended = (update_state: Record<string, unknown>) =>
		pushStatus({ updating: null, update_state });

	it.each([
		["success", { kind: "success" }, "success"],
		[
			"failure",
			{ kind: "failed", reason: "E: dpkg returned an error code (1)" },
			"error",
		],
	] as const)(
		"announces the device's %s as the overlay closes",
		(_name, state, method) => {
			updating({ ...installing, percent: 70 });
			render(Layout);
			expect(overlayTitle()).toBeDefined();
			ended(state);
			expect(overlayTitle()).toBeUndefined();
			expect(vi.mocked(toast[method])).toHaveBeenCalledTimes(1);
			expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
		},
	);

	// The vector the install was launched with, as its own frames carry it.
	const targets = [
		{
			name: "ceralive-ui",
			version: "2026.11.3",
			arch: "arm64",
			from: "2026.11.2",
		},
	];
	const asked = () => vi.mocked(rpc.system.updateOutcome);
	async function endsAndAsks(answer: Promise<unknown>) {
		// An offer the tab saw earlier is not what it asks about.
		pushStatus({
			update_state: {
				kind: "available",
				identity: { version: "2026.11.2", packages: ["ceralive-ui"] },
				package_count: 1,
				packages: [
					{ name: "ceralive-ui", version: "2026.11.2", actionable: true },
				],
			},
		});
		updating({ ...installing, percent: 70, run: 1, targets });
		render(Layout);
		const title = overlayTitle();
		asked().mockReturnValueOnce(answer as never);
		ended({ kind: "idle" });
		expect(asked()).toHaveBeenCalledWith({ targets });
		// Until the device answers, the phase is held without its number.
		expect(overlayTitle()).toBe(title);
		expect(
			document.querySelector('[data-testid="update-phase"]')?.textContent,
		).toContain("Installing");
		expect(
			document
				.querySelector('[role="progressbar"]')
				?.getAttribute("aria-valuenow"),
		).toBeNull();
		await answer.catch(() => undefined);
		await tick();
		flushSync();
	}

	it("says the outcome is not confirmed when the device does not know it", async () => {
		await endsAndAsks(Promise.resolve({ kind: "unknown" }));
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
			"Outcome not confirmed",
		);
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
	});

	it("says the outcome is not confirmed when its question gets no answer", async () => {
		await endsAndAsks(Promise.reject(new Error("socket closed")));
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
			"Outcome not confirmed",
		);
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
	});

	it("announces success when the device reads the install's own versions as installed", async () => {
		await endsAndAsks(Promise.resolve({ kind: "success" }));
		expect(overlayTitle()).toBeUndefined();
		// Versions reached, said as such: never the observed exit's title.
		expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
			"Packages installed",
			{
				description:
					"The device now has this update's versions installed. CeraUI did not see the update finish.",
			},
		);
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
	});

	it("shows the fixed-name unit's failed exit only as an unattributed hint, never Update Failed", async () => {
		await endsAndAsks(Promise.resolve({ kind: "unknown", exit: 100 }));
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
			"Outcome not confirmed",
			{
				description:
					"The update service last stopped with exit code 100. That may have been a different update.",
			},
		);
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
	});

	it("a run that ends without a vector (legacy mode) asks with none and is not confirmed", async () => {
		updating({ ...installing, percent: 70 });
		render(Layout);
		asked().mockResolvedValueOnce({ kind: "unknown" } as never);
		ended({ kind: "idle" });
		expect(asked()).toHaveBeenCalledWith({ targets: [] });
		await tick();
		flushSync();
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
			"Outcome not confirmed",
		);
	});

	it("the device's own failure frame for the current run is still Update Failed", () => {
		updating({ ...installing, percent: 70, targets });
		render(Layout);
		pushStatus({
			updating: {
				...installing,
				percent: 70,
				targets,
				result: "E: Sub-process /usr/bin/dpkg returned an error code (1)",
			},
		});
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
		expect(asked()).not.toHaveBeenCalled();
	});

	it("keeps the phase while the device still reports the unit, and follows its frames again", async () => {
		await endsAndAsks(Promise.resolve({ kind: "running" }));
		const title = overlayTitle();
		expect(title).toBeDefined();
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
		updating({ ...installing, percent: 80 });
		expect(overlayTitle()).toBe(title);
		expect(
			document
				.querySelector('[role="progressbar"]')
				?.getAttribute("aria-valuenow"),
		).toBe("80");
		pushStatus({
			updating: { ...installing, percent: 80, result: 0 },
			update_state: { kind: "success" },
		});
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
		expect(asked()).toHaveBeenCalledTimes(1);
	});

	it("leaves a refused preflight to its own notice", () => {
		updating({ total: 0, downloading: 0, unpacking: 0, setting_up: 0 });
		render(Layout);
		ended({
			kind: "update_preflight_failed",
			preflight_reason: "insufficient_space",
		});
		expect(overlayTitle()).toBeUndefined();
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
	});
});

describe("Layout — an answer counts only for the question it was given", () => {
	const target = (version: string) => [
		{ name: "ceralive-ui", version, arch: "arm64", from: "2026.11.2" },
	];
	const A = target("2026.11.3");
	const B = target("2026.11.4");
	// Each launched run's frames carry its start, as the backend sends them.
	const RUN = new Map([
		[A, 1],
		[B, 2],
	]);
	const asked = () => vi.mocked(rpc.system.updateOutcome);
	const phase = () =>
		document.querySelector('[data-testid="update-phase"]')?.textContent ?? "";
	const runs = (targets: typeof A, percent: number, run = RUN.get(targets)) =>
		updating({ ...installing, percent, run, targets });
	const endsUnseen = () =>
		pushStatus({ updating: null, update_state: { kind: "idle" } });
	async function settle() {
		await tick();
		flushSync();
	}

	it.each([
		["B's answer first", ["B", "A"]],
		["A's answer first", ["A", "B"]],
	] as const)(
		"run A's deferred answer is never taken for run B (%s)",
		async (_, order) => {
			const answers = {
				A: Promise.withResolvers<unknown>(),
				B: Promise.withResolvers<unknown>(),
			};
			asked()
				.mockReturnValueOnce(answers.A.promise as never)
				.mockReturnValueOnce(answers.B.promise as never);
			runs(A, 70);
			render(Layout);
			endsUnseen();
			runs(B, 30);
			endsUnseen();
			expect(asked().mock.calls).toEqual([[{ targets: A }], [{ targets: B }]]);
			const replies = { A: { kind: "success" }, B: { kind: "unknown" } };
			for (const run of order) {
				answers[run].resolve(replies[run]);
				await settle();
			}
			// Only B's own answer is announced: A's success never closes B.
			expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
			expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1);
			expect(overlayTitle()).toBeUndefined();
		},
	);

	it("a running frame after the question makes its answer stale", async () => {
		const answer = Promise.withResolvers<unknown>();
		asked().mockReturnValueOnce(answer.promise as never);
		runs(A, 70);
		render(Layout);
		endsUnseen();
		runs(B, 20);
		answer.resolve({ kind: "success" });
		await settle();
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
		// The tab shows B from its own frame, not A's 70%.
		expect(overlayTitle()).toBeDefined();
		expect(
			document
				.querySelector('[role="progressbar"]')
				?.getAttribute("aria-valuenow"),
		).toBe("20");
	});

	async function reconnectInto(frame: Record<string, unknown>) {
		transport.connection?.("disconnected");
		transport.hydratedStatus = {
			updating: frame,
			update_state: { kind: "downloading", progress: frame },
		};
		const calls = transport.hydrateCalls;
		transport.connection?.("connected");
		await vi.waitFor(() =>
			expect(transport.hydrateCalls).toBeGreaterThan(calls),
		);
		await settle();
	}
	const downloadingOf = (run: number, targets?: typeof A) => ({
		total: 1,
		downloading: 1,
		unpacking: 0,
		setting_up: 0,
		run,
		...(targets ? { targets } : {}),
	});

	it.each([
		["its admitted frame (another vector)", downloadingOf(2, B), B],
		["a same-vector retry", downloadingOf(2, A), A],
	])(
		"a fresh connection into an active new run drops the old run's phase and ceiling: %s",
		async (_, frame, asks) => {
			runs(A, 80);
			render(Layout);
			expect(phase()).toContain("Installing");
			await reconnectInto(frame);
			expect(phase()).toContain("Downloading");
			expect(phase()).not.toContain("Installing");
			// When the new run ends unseen, the question is about its own vector.
			asked().mockResolvedValueOnce({ kind: "unknown" } as never);
			endsUnseen();
			expect(asked()).toHaveBeenLastCalledWith({ targets: asks });
		},
	);

	it("a fresh connection into a new run's first frame, before it names a vector, holds nothing of the old run", async () => {
		runs(A, 80);
		render(Layout);
		await reconnectInto({
			total: 0,
			downloading: 0,
			unpacking: 0,
			setting_up: 0,
			run: 2,
		});
		expect(phase()).toContain("Preparing or downloading packages");
		expect(phase()).not.toContain("Installing");
		// The run then names its vector; a missed end asks about that one.
		updating(downloadingOf(2, B));
		expect(phase()).toContain("Downloading");
		asked().mockResolvedValueOnce({ kind: "unknown" } as never);
		endsUnseen();
		expect(asked()).toHaveBeenLastCalledWith({ targets: B });
	});

	it.each([
		["the later answer first", ["second", "first"]],
		["the earlier answer first", ["first", "second"]],
	] as const)(
		"two quick runs of the same vector: only the later question's answer counts (%s)",
		async (_, order) => {
			const answers = {
				first: Promise.withResolvers<unknown>(),
				second: Promise.withResolvers<unknown>(),
			};
			asked()
				.mockReturnValueOnce(answers.first.promise as never)
				.mockReturnValueOnce(answers.second.promise as never);
			runs(A, 70, 1);
			render(Layout);
			endsUnseen();
			runs(A, 30, 2);
			endsUnseen();
			expect(asked().mock.calls).toEqual([[{ targets: A }], [{ targets: A }]]);
			const replies = {
				first: { kind: "success" },
				second: { kind: "unknown" },
			};
			for (const which of order) {
				answers[which].resolve(replies[which]);
				await settle();
			}
			expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
			expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1);
		},
	);

	it("a tab opened mid-run has no vector: it shows progress, and its question names none", async () => {
		// A recovered unit's frames: no run start, no vector.
		updating({ ...installing, percent: 50 });
		render(Layout);
		expect(phase()).toContain("Installing");
		asked().mockResolvedValueOnce({ kind: "unknown" } as never);
		endsUnseen();
		// An empty question can learn only running or not confirmed.
		expect(asked()).toHaveBeenLastCalledWith({ targets: [] });
		await settle();
		expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
			"Outcome not confirmed",
		);
		expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
	});

	it("a reconnect into the same run (no vector after a restart) keeps its phase", async () => {
		runs(A, 80);
		render(Layout);
		const title = overlayTitle();
		asked().mockResolvedValueOnce({ kind: "running" } as never);
		endsUnseen();
		await settle();
		// The restarted backend's first frame for the recovered unit names no vector.
		updating({ total: 0, downloading: 0, unpacking: 0, setting_up: 0 });
		expect(overlayTitle()).toBe(title);
		expect(phase()).toContain("Installing");
		// It still asks about A's vector if this run's end is missed too.
		asked().mockResolvedValueOnce({ kind: "success" } as never);
		endsUnseen();
		expect(asked()).toHaveBeenLastCalledWith({ targets: A });
	});
});
