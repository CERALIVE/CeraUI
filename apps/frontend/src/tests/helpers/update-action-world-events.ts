/**
 * The event alphabet of the reference world (`update-action-world.ts`): which
 * events can happen in a given state, and what each one does. A no-op event
 * returns the world itself, so an explorer can tell it changed nothing.
 */
import { isBusy } from "../../lib/updates/update-action-outcome";
import {
	apply,
	conclude,
	detailsOf,
	failRead,
	frame,
	inFlight,
	LOST,
	landRead,
	patchCall,
	push,
	startable,
	startRead,
	type World,
	type WorldCall,
} from "./update-action-world";

export const WORLD_EVENTS = [
	"dispatch",
	"duplicate",
	"device-starts",
	"refuse",
	"internal",
	"success",
	"timeout",
	"late-success",
	"drop-link",
	"reconnect",
	"phase-unrelated",
	"phase-same",
	"read-oldest",
	"read-newest",
	"read-fail",
	"close",
	"reopen",
] as const;
export type WorldEvent = (typeof WORLD_EVENTS)[number];

function deviceStarts(w: World, id: number): World {
	const started = patchCall(w, id, { started: true });
	if (w.action === "install") {
		const staged = {
			phase: "os-staging",
			checkedAt: w.device.checkedAt,
			staged: true,
		} as const;
		return push({ ...started, device: staged }, "os-staging");
	}
	const device = {
		...w.device,
		phase: "idle",
		checkedAt: w.device.checkedAt + 1_000,
	} as const;
	return push(push({ ...started, device }, "checking"), "idle");
}

function dispatch(w: World): World {
	const call: WorldCall = {
		id: w.calls.length + 1,
		session: w.session,
		order: w.order + 1,
		delivered: w.link,
		started: false,
		transport: "flight",
		verdict: "pending",
		baseline: w.shown,
		afterRead: w.seq,
		evidence: false,
	};
	const shown = w.shown === undefined ? undefined : detailsOf(w.shown);
	const sent = apply(
		{ ...w, order: call.order, calls: [...w.calls, call] },
		{
			type: "dispatch",
			action: w.action,
			call: call.id,
			context: {
				afterRead: w.seq,
				clocks: shown?.checks,
				staged: shown?.os.staged,
			},
		},
	);
	if (w.link) return { ...sent, sent: w.sent + 1 };
	return conclude(
		sent,
		call,
		{ kind: "refused", reason: "not_connected" },
		"done",
	);
}

/** Every outstanding request expires, oldest first, as the client's timers fire. */
function expireAll(w: World, call: WorldCall): World {
	const queue = [
		...w.reads.map((read) => ({ order: read.order, read })),
		{ order: call.order, read: undefined },
	].sort((a, b) => a.order - b.order);
	let out = w;
	for (const entry of queue)
		out =
			entry.read === undefined
				? conclude(out, call, LOST, "abandoned")
				: failRead(out, entry.read);
	return out;
}

function dropLink(w: World): World {
	let out: World = { ...w, link: false };
	for (const read of w.reads) out = failRead(out, read);
	const call = inFlight(out);
	return call === undefined ? out : conclude(out, call, LOST, "done");
}

function must<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`world: no ${what} for this event`);
	return value;
}

export function applicable(w: World, event: WorldEvent): boolean {
	switch (event) {
		case "dispatch":
			return w.open && !isBusy(w.machine, w.action);
		case "duplicate":
			return w.open && isBusy(w.machine, w.action);
		case "device-starts":
			return startable(w) !== undefined;
		case "refuse":
			return inFlight(w)?.started === false;
		case "internal":
		case "success":
			return inFlight(w) !== undefined;
		case "timeout":
			return w.link && inFlight(w) !== undefined;
		case "late-success":
			return w.calls.some((call) => call.transport === "abandoned");
		case "drop-link":
		case "phase-same":
			return w.link;
		case "reconnect":
			return !w.link;
		case "phase-unrelated":
			return (
				w.link && (w.device.phase === "idle" || w.device.phase === "available")
			);
		case "read-oldest":
		case "read-fail":
			return w.reads.length > 0;
		case "read-newest":
			return w.reads.length > 1;
		case "close":
			return w.open;
		case "reopen":
			return !w.open;
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

/** Apply one applicable event. A no-op event returns `w` itself. */
export function step(w: World, event: WorldEvent): World {
	const flight = () => must(inFlight(w), "request in flight");
	switch (event) {
		case "dispatch":
			return dispatch(w);
		case "duplicate":
		case "phase-same":
			return w;
		case "device-starts":
			return deviceStarts(w, must(startable(w), "startable request").id);
		case "refuse":
			return conclude(w, flight(), { kind: "refused", reason: "busy" }, "done");
		case "internal":
			return conclude(
				w,
				flight(),
				{ kind: "uncertain", cause: "error" },
				"done",
			);
		case "success": {
			const call = flight();
			const started = call.started ? w : deviceStarts(w, call.id);
			return conclude(started, call, { kind: "accepted" }, "done");
		}
		case "timeout":
			return expireAll(w, flight());
		case "late-success": {
			const late = must(
				w.calls.find((entry) => entry.transport === "abandoned"),
				"abandoned request",
			);
			const answered = patchCall(w, late.id, { transport: "done" });
			return late.started ? answered : deviceStarts(answered, late.id);
		}
		case "drop-link":
			return dropLink(w);
		case "reconnect": {
			const hydrated = frame({ ...w, link: true }, { phase: w.device.phase });
			return frame(hydrated, { restored: hydrated.seen.restored + 1 });
		}
		case "phase-unrelated": {
			const phase = w.device.phase === "idle" ? "available" : "idle";
			return push({ ...w, device: { ...w.device, phase } }, phase);
		}
		case "read-oldest":
			return landRead(w, must(w.reads[0], "outstanding read"));
		case "read-newest":
			return landRead(w, must(w.reads.at(-1), "outstanding read"));
		case "read-fail":
			return failRead(w, must(w.reads[0], "outstanding read"));
		case "close":
			return frame(
				{
					...apply(w, { type: "reset" }),
					open: false,
					session: w.session + 1,
					seq: w.seq + 1,
				},
				{ open: false },
			);
		case "reopen":
			return startRead(frame({ ...w, open: true }, { open: true }), true);
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}
