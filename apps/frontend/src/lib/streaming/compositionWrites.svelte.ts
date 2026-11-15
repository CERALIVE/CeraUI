import { m, resolveMessageKey } from "@ceraui/i18n/svelte";
import type {
	CompositionRect,
	StreamingSetConfigInput,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";

import { rpc } from "$lib/rpc";
import { configChangeReport } from "$lib/streaming/configChangeCopy";

/**
 * One ordered lane for every composition write this tab sends: the layout card
 * (enable, presets, second input, opacity) and the layout designer (placements).
 *
 * Writes go out one at a time, in the order they were made. A placement still
 * waiting when any newer write arrives is dropped unsent (its promise resolves
 * `undefined`): it is older than that write, so sending it later would undo the
 * operator's newer choice. Only the newest waiting placement is ever sent.
 */
type Write = {
	input: StreamingSetConfigInput;
	resolve: (result: StreamingSetConfigOutput | undefined) => void;
	reject: (error: unknown) => void;
};

let waiting = $state.raw<Write[]>([]);
let sending = $state.raw<Write | undefined>(undefined);

const isPlacement = (write: Write) =>
	write.input.composition_rect !== undefined;

/** The newest placement not yet answered, for the designer to show meanwhile. */
export function pendingPlacement(): CompositionRect | undefined {
	const newest =
		waiting.findLast(isPlacement) ??
		(sending && isPlacement(sending) ? sending : undefined);
	return newest?.input.composition_rect;
}

export function sendCompositionWrite(
	input: StreamingSetConfigInput,
): Promise<StreamingSetConfigOutput | undefined> {
	for (const write of waiting) if (isPlacement(write)) write.resolve(undefined);
	return new Promise((resolve, reject) => {
		waiting = [
			...waiting.filter((write) => !isPlacement(write)),
			{ input, resolve, reject },
		];
		void sendNext();
	});
}

async function sendNext(): Promise<void> {
	const next = waiting[0];
	if (sending !== undefined || next === undefined) return;
	waiting = waiting.slice(1);
	sending = next;
	try {
		next.resolve(await rpc.streaming.setConfig(next.input));
	} catch (error) {
		next.reject(error);
	} finally {
		sending = undefined;
		void sendNext();
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
): string | undefined {
	const change = result.configChange;
	if (change !== undefined && change.result !== "applied")
		return configChangeReport(change, m).message;
	if (result.success) return undefined;
	return result.error !== undefined && REFUSAL_TOKENS.has(result.error)
		? resolveMessageKey(`live.layout.error.${result.error}`)
		: m["notifications.saveFailed"]();
}
