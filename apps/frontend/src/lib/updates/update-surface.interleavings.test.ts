// @vitest-environment jsdom
/**
 * The REAL update surface against the reference world, for EVERY maximal
 * interleaving of up to BOUND events: the shell, `osCommand`, the `RPCClient`
 * with its 30 s timeout, its reset-on-close and reconnect loop, the details
 * read fences and the binder step, all on a scripted socket and Vitest's fake
 * clock. Each path is replayed from a fresh surface, and after EVERY event the
 * surface's bands, busy state, shown details, failure band and the requests it
 * put on the wire must equal the world's prediction. The pure exhaustive test
 * proves the world keeps U1–U6; this one proves the real code is that world.
 */
import type { UpdateDetails } from "@ceraui/rpc/schemas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	detailsOf,
	inFlight,
	initialWorld,
	type World,
	type WorldAction,
} from "../../tests/helpers/update-action-world";
import {
	applicable,
	step,
	WORLD_EVENTS,
	type WorldEvent,
} from "../../tests/helpers/update-action-world-events";
import {
	answer,
	CAPABLE,
	connectDevice,
	disconnectDevice,
	dropLink,
	elapse,
	FakeWebSocket,
	flush,
	outstanding,
	reject,
	restoreLink,
	SETTINGS,
	sentCount,
	socket,
} from "../../tests/helpers/update-device";
import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
import { rpcClient } from "../rpc/client";
import { actionBands, isBusy } from "./update-action-outcome";
import { type DeviceFrame, followStep } from "./update-device-follow.svelte";
import {
	createUpdateSurface,
	type UpdateSurface,
} from "./update-surface.svelte";

const BOUND = 5;

// A late reply to a request the client already abandoned is expected here; the
// client's "unknown request" warning would otherwise flood the run.
let quietWarnings: { mockRestore(): void } | undefined;
beforeAll(() => {
	quietWarnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => {
	quietWarnings?.mockRestore();
});

/** Every maximal path replayed, pinned: a shrinking alphabet must not pass silently. */
const MAXIMAL_PATHS: Readonly<Record<WorldAction, number>> = {
	check: 10_436,
	install: 9_375,
};

const ACTION_PATH: Readonly<Record<WorldAction, string>> = {
	check: "system.checkUpdatesNow",
	install: "system.installUpdatesNow",
};

function maximalPaths(action: WorldAction): WorldEvent[][] {
	const paths: WorldEvent[][] = [];
	const visit = (w: World, path: WorldEvent[]): void => {
		const next = WORLD_EVENTS.filter((event) => applicable(w, event));
		if (path.length === BOUND || next.length === 0) {
			paths.push(path);
			return;
		}
		for (const event of next) visit(step(w, event), [...path, event]);
	};
	visit(initialWorld(action), []);
	return paths;
}

interface Harness {
	readonly surface: UpdateSurface;
	readonly requests: Map<number, string>;
	seen: DeviceFrame;
}

function frame(h: Harness, patch: Partial<DeviceFrame>): void {
	const next = { ...h.seen, ...patch };
	const move = followStep(h.seen, next);
	h.seen = next;
	if (move.kind === "phase") void h.surface.observePhase(move.phase);
	if (move.kind === "reread") void h.surface.reloadDetails();
}

function deliver(
	h: Harness,
	call: number,
	frameOf: (id: string) => unknown,
): void {
	const id = h.requests.get(call);
	const live = socket();
	if (id === undefined || live.answered.has(id)) return;
	if (!live.sent.some((request) => request.id === id)) return;
	live.answered.add(id);
	live.deliver(frameOf(id));
}

function startOnDevice(h: Harness, w: World): void {
	if (!w.link) return;
	if (w.action === "install") frame(h, { phase: "os-staging" });
	else {
		frame(h, { phase: "checking" });
		frame(h, { phase: "idle" });
	}
}

async function perform(
	h: Harness,
	w: World,
	event: WorldEvent,
	after: World,
): Promise<void> {
	const flight = inFlight(w);
	switch (event) {
		case "dispatch":
		case "duplicate":
			void (w.action === "check"
				? h.surface.checkNow()
				: h.surface.installNow());
			await flush();
			if (event === "dispatch" && w.link)
				h.requests.set(
					after.calls.length,
					outstanding(ACTION_PATH[w.action]).at(-1)?.id ?? "",
				);
			return;
		case "device-starts":
			startOnDevice(h, w);
			break;
		case "refuse":
			deliver(h, flight?.id ?? 0, (id) => ({
				id,
				result: { success: false, error: "busy" },
			}));
			break;
		case "internal":
			deliver(h, flight?.id ?? 0, (id) => ({
				id,
				error: { message: "x", code: "INTERNAL_ERROR" },
			}));
			break;
		case "success":
			if (flight?.started === false) startOnDevice(h, w);
			deliver(h, flight?.id ?? 0, (id) => ({ id, result: { success: true } }));
			break;
		case "timeout":
			await elapse(31_000);
			break;
		case "late-success": {
			const late = w.calls.find((call) => call.transport === "abandoned");
			deliver(h, late?.id ?? 0, (id) => ({ id, result: { success: true } }));
			if (late?.started === false) startOnDevice(h, w);
			break;
		}
		case "drop-link":
			dropLink();
			break;
		case "reconnect":
			await restoreLink();
			frame(h, { phase: w.device.phase });
			frame(h, { restored: h.seen.restored + 1 });
			break;
		case "phase-unrelated":
		case "phase-same":
			frame(h, { phase: after.device.phase });
			break;
		case "read-oldest":
		case "read-newest":
			answer(
				"system.getUpdateDetails",
				detailsOf(after.device),
				event === "read-oldest" ? "oldest" : "newest",
			);
			break;
		case "read-fail":
			reject("system.getUpdateDetails", "INTERNAL_ERROR");
			break;
		case "close":
			h.surface.reset();
			frame(h, { open: false });
			break;
		case "reopen":
			frame(h, { open: true });
			void h.surface.load();
			await flush();
			if (w.link) {
				answer("system.getUpdateCapabilities", CAPABLE, "newest");
				answer("system.getUpdateSettings", SETTINGS, "newest");
			}
			break;
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
	await flush();
}

function shownOf(details: UpdateDetails | undefined) {
	return details === undefined
		? undefined
		: {
				checkedAt: details.checks.os.lastAttemptAt,
				staged: details.os.staged !== null,
			};
}

function realView(h: Harness, action: WorldAction) {
	return {
		bands: h.surface.bands,
		busy: h.surface.pending(action),
		shown: shownOf(h.surface.details),
		detailsFailed: h.surface.detailsFailed,
		sent: sentCount(ACTION_PATH[action]),
	};
}

function predictedView(w: World) {
	return {
		bands: actionBands(w.machine),
		busy: isBusy(w.machine, w.action),
		shown: w.shown,
		detailsFailed: w.capsFailed || w.detailsFailed,
		sent: w.sent,
	};
}

async function replay(
	action: WorldAction,
	path: readonly WorldEvent[],
): Promise<string | undefined> {
	connectDevice();
	const surface = createUpdateSurface();
	const opening = surface.load();
	answer("system.getUpdateCapabilities", CAPABLE);
	answer("system.getUpdateSettings", SETTINGS);
	answer(
		"system.getUpdateDetails",
		detailsOf({ checkedAt: 1_000, staged: false }),
	);
	await opening;
	const h: Harness = {
		surface,
		requests: new Map(),
		seen: initialWorld(action).seen,
	};
	let world = initialWorld(action);
	let failure: string | undefined;
	for (const [index, event] of path.entries()) {
		const after = step(world, event);
		await perform(h, world, event, after);
		world = after;
		const real = JSON.stringify(realView(h, action));
		const predicted = JSON.stringify(predictedView(world));
		if (real !== predicted) {
			failure = `[${path.slice(0, index + 1).join(", ")}]\n  real      ${real}\n  predicted ${predicted}`;
			break;
		}
	}
	rpcClient.disconnect();
	await flush();
	await flush();
	disconnectDevice();
	destroyAsyncOperations();
	FakeWebSocket.current = undefined;
	return failure;
}

describe.each(["check", "install"] as const)(
	"the real surface replays every %s interleaving",
	(action) => {
		it(`matches the world after every event, up to ${BOUND} events`, async () => {
			// Given every maximal path of applicable events up to the bound.
			const paths = maximalPaths(action);

			// When each is replayed against the real stack from a fresh surface.
			const failures: string[] = [];
			for (const path of paths) {
				const failure = await replay(action, path);
				if (failure !== undefined && failures.length < 3)
					failures.push(failure);
			}

			// Then every state matched the world's prediction.
			expect(failures).toEqual([]);
			expect(paths.length).toBe(MAXIMAL_PATHS[action]);
		}, 120_000);
	},
);
