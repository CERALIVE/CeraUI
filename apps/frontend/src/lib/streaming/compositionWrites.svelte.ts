import { m, resolveMessageKey } from "@ceraui/i18n/svelte";
import type {
	CompositionRect,
	StreamingSetConfigInput,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";

import { rpc } from "$lib/rpc/client";
import { NotSentError } from "$lib/rpc/rpc-error";
import {
	type ConfigChangeReport,
	configChangeReport,
} from "$lib/streaming/configChangeCopy";

/**
 * One ordered lane for this tab: every composition write (the layout card's
 * enable, presets, second input and opacity; the layout designer's placements)
 * and every Start and Stop it sends.
 *
 * Writes go out one at a time, in the order they were made, each after every
 * earlier entry's answer. A placement still waiting when a newer composition
 * write arrives is dropped unsent (its promise resolves `undefined`): sending it
 * later would undo the operator's newer choice. A Start or a Stop drops nothing,
 * because it is not a composition choice: a write made before it is sent before
 * it (idle before a Start, so the Start runs it; live before a Stop, so the
 * stream ends with it and the next Start begins from it), and one made after it
 * is sent after its answer. A Start or a Stop waits only for a write, never for
 * another Start or Stop: a Stop must still reach a device whose earlier Stop or
 * Start has not answered (the stop watchdog's redispatch, a retry).
 *
 * Whether a write changes the running stream (`apply_now`) is decided when it
 * is SENT, from the session at that moment, never when it is made: a write
 * made idle but sent after a Start must reach the running stream, or the
 * device would only save it for the next Start while the engine keeps the
 * older one. A session that ends or starts by itself (an engine failure, a
 * dropped socket, another tab) reaches the lane through the device's status.
 */
type CompositionInput = Omit<StreamingSetConfigInput, "apply_now">;
type Session = "live" | "idle";
type Write = {
	kind: "write";
	input: CompositionInput;
	streaming: () => boolean;
	resolve: (result: StreamingSetConfigOutput | undefined) => void;
	reject: (error: unknown) => void;
};
type Transition = {
	kind: "transition";
	launch: () => void;
};
type Entry = Write | Transition;

let waiting = $state.raw<Entry[]>([]);
let writing = $state.raw<Write | undefined>(undefined);
let transitions = 0;
// Set by a Start this lane had answered, until the device's status says it is
// streaming: that status can land after the answer, and a write in between
// still belongs to the running stream. `apply_now` to an idle device only saves.
let startedAhead = false;

const isPlacement = (entry: Entry | undefined): entry is Write =>
	entry?.kind === "write" && entry.input.composition_rect !== undefined;

/** The newest placement not yet answered, for the designer to show meanwhile. */
export function pendingPlacement(): CompositionRect | undefined {
	const newest =
		waiting.findLast(isPlacement) ??
		(isPlacement(writing) ? writing : undefined);
	return newest?.input.composition_rect;
}

/**
 * Send one composition write in order. `streaming` reads whether the device
 * reports a live stream (`getIsStreaming`), and is read when the write is sent.
 */
export function sendCompositionWrite(
	input: CompositionInput,
	streaming: () => boolean,
): Promise<StreamingSetConfigOutput | undefined> {
	for (const entry of waiting) if (isPlacement(entry)) entry.resolve(undefined);
	return new Promise((resolve, reject) => {
		waiting = [
			...waiting.filter((entry) => !isPlacement(entry)),
			{ kind: "write", input, streaming, resolve, reject },
		];
		pump();
	});
}

/** Start (`live`) or Stop (`idle`), in order with this tab's composition writes. */
export function sendSessionTransition<T>(
	to: Session,
	run: () => Promise<T>,
): Promise<T>;
/** Returning undefined from dispatch cancels the intent without a device transition. */
export function sendSessionTransition<T>(
	to: "live",
	run: () => Promise<T> | undefined,
): Promise<T | undefined>;
export function sendSessionTransition<T>(
	to: Session,
	run: () => Promise<T> | undefined,
): Promise<T | undefined> {
	// Nothing ahead of it: the device's own answer, untouched.
	if (writing === undefined) return launchTransition(to, run);
	return new Promise<T | undefined>((resolve, reject) => {
		waiting = [
			...waiting,
			{
				kind: "transition",
				launch: () => {
					launchTransition(to, run).then(resolve, reject);
				},
			},
		];
	});
}

function launchTransition<T>(
	to: Session,
	run: () => Promise<T> | undefined,
): Promise<T | undefined> {
	const answer = run();
	if (answer === undefined) return Promise.resolve(undefined);
	transitions += 1;
	answer.then(
		(result) => {
			startedAhead =
				to === "live" &&
				(result as { success?: boolean } | undefined)?.success !== false;
			transitionDone();
		},
		(error) => {
			// A Start whose answer was lost may be running; a Stop ends it either way.
			if (!(error instanceof NotSentError)) startedAhead = to === "live";
			transitionDone();
		},
	);
	return answer;
}

function transitionDone(): void {
	transitions -= 1;
	pump();
}

// Sends whatever may go now: nothing while a write is in flight; a write only
// when no Start or Stop is in flight either; a Start or a Stop past writes that
// are themselves waiting for one.
function pump(): void {
	while (writing === undefined && waiting.length > 0) {
		const head = waiting[0] as Entry;
		const next =
			head.kind === "write" && transitions > 0
				? waiting.find((entry) => entry.kind === "transition")
				: head;
		if (next === undefined) return;
		waiting = waiting.filter((entry) => entry !== next);
		if (next.kind === "transition") next.launch();
		else void write(next);
	}
}

async function write(entry: Write): Promise<void> {
	writing = entry;
	try {
		if (entry.streaming()) startedAhead = false;
		const input: StreamingSetConfigInput =
			entry.streaming() || startedAhead
				? { ...entry.input, apply_now: true }
				: entry.input;
		entry.resolve(await rpc.streaming.setConfig(input));
	} catch (error) {
		entry.reject(error);
	} finally {
		writing = undefined;
		pump();
	}
}

const REFUSAL_TOKENS = new Set([
	"composition_off",
	"composition_unsupported",
	"composition_geometry_unsupported",
	"composition_rect_invalid",
]);

/** The keyed copy for a composition write the device or the engine did not apply. */
export function compositionRefusal(
	result: StreamingSetConfigOutput,
): Readonly<Pick<ConfigChangeReport, "message" | "reasonKey">> | undefined {
	const change = result.configChange;
	if (change !== undefined && change.result !== "applied")
		return configChangeReport(change, m);
	if (result.success) return undefined;
	return {
		message:
			result.error !== undefined && REFUSAL_TOKENS.has(result.error)
				? resolveMessageKey(`live.layout.error.${result.error}`)
				: m["notifications.saveFailed"](),
	};
}
