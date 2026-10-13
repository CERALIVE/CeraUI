/**
 * The operator's escape from an UNCONFIRMED stream state.
 *
 * The backend holds stream protection (Start refused, update Check/Install and
 * reboot/power refused) whenever its lifecycle commits with UNKNOWN liveness.
 * Two lifecycle states do that with no bound of their own: `reconciling` (the
 * engine did not answer a runtime query) and `stop_failed` (a stop the engine
 * never acknowledged). Neither one changes `is_streaming`, so when the last
 * confirmed value was `false` the Live view used to show the idle cockpit with
 * no Stop at all, while the only clearing path is the operator's acknowledged
 * Stop. This predicate is where the Live view decides to offer that Stop.
 *
 * `is_streaming:true` keeps the live cockpit and its own Stop, and the optimistic
 * `starting` edge keeps the live cockpit too, so both stay out of this set: the
 * band never doubles a Stop that is already on screen. `starting`, `stopping`
 * and `reconfiguring` are bounded transients the backend settles by itself, so
 * they stay out as well.
 */
import type { LifecycleState } from "@ceraui/rpc/schemas";

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";

/** The lifecycle states that hold protection until positive evidence or an operator Stop. */
export const UNCONFIRMED_STREAM_LIFECYCLES: ReadonlySet<LifecycleState> =
	new Set<LifecycleState>(["reconciling", "stop_failed"]);

/** The async-operation key the unconfirmed-state Stop is tracked under. */
export const UNCONFIRMED_STOP_OPERATION = "stream-stop-unconfirmed";

export interface UnconfirmedStreamInput {
	/** `status.stream_lifecycle`; absent on an older backend, which never shows the band. */
	lifecycle: LifecycleState | undefined;
	isStreaming: boolean;
	optimismState: StreamingOptimismState;
}

/** Whether the Live view must offer the unconfirmed-state band and its Stop. */
export function showUnconfirmedStreamStop(
	input: UnconfirmedStreamInput,
): boolean {
	if (input.isStreaming || input.optimismState === "starting") return false;
	return (
		input.lifecycle !== undefined &&
		UNCONFIRMED_STREAM_LIFECYCLES.has(input.lifecycle)
	);
}
