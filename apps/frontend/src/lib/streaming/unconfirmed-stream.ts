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
 * Stop. These predicates are where the Live view decides to offer that Stop,
 * when that Stop counts as confirmed, and when the device's word outranks a
 * local optimistic start.
 *
 * Every rule here is about DEVICE EVIDENCE. Presentation (whether a band is on
 * screen) and local optimism (what this client expects to happen) never stand in
 * for it: the backend publishes `stopping` before it has the engine's answer, and
 * the optimistic live cockpit shows a disabled "Starting...", not a Stop.
 */
import type { LifecycleState } from "@ceraui/rpc/schemas";

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";

/** The lifecycle states that hold protection until positive evidence or an operator Stop. */
export const UNCONFIRMED_STREAM_LIFECYCLES: ReadonlySet<LifecycleState> =
	new Set<LifecycleState>(["reconciling", "stop_failed"]);

/** The async-operation key the unconfirmed-state Stop is tracked under. */
export const UNCONFIRMED_STOP_OPERATION = "stream-stop-unconfirmed";

export interface DeviceStreamFacts {
	/** `status.stream_lifecycle`; absent on an older backend, which never shows the band. */
	lifecycle: LifecycleState | undefined;
	isStreaming: boolean;
}

export interface UnconfirmedStreamInput extends DeviceStreamFacts {
	/**
	 * Accepted and deliberately NOT consulted: a stale local `starting` (a lost
	 * start reply) must never hide the only usable Stop.
	 */
	optimismState: StreamingOptimismState;
	/** The band's own Stop is in flight (its operation is `pending`). */
	stopPending?: boolean;
}

/** The device projects an unconfirmed lifecycle while its last confirmed `is_streaming` is false. */
export function streamStateUnconfirmed(facts: DeviceStreamFacts): boolean {
	return (
		!facts.isStreaming &&
		facts.lifecycle !== undefined &&
		UNCONFIRMED_STREAM_LIFECYCLES.has(facts.lifecycle)
	);
}

/**
 * Whether the Live view must offer the unconfirmed-state band and its Stop.
 * With `is_streaming` true the live cockpit's own Stop is used, so the band never
 * doubles it. While the band's own Stop is pending it also covers `stopping`,
 * which the backend enters before the engine answers: the operator keeps one
 * continuous "Stopping..." instead of the band blinking out and back.
 */
export function showUnconfirmedStreamStop(
	input: UnconfirmedStreamInput,
): boolean {
	if (streamStateUnconfirmed(input)) return true;
	return (
		input.stopPending === true &&
		!input.isStreaming &&
		input.lifecycle === "stopping"
	);
}

/**
 * Whether the device has confirmed a Stop: its idle commit, which the backend
 * publishes before it replies `stopped`. `stopping`, an absent lifecycle and a
 * `stopped` reply on its own (the reconciling branch can answer it while a
 * pending launch keeps the lifecycle `reconciling`) are not confirmation.
 */
export function stopConfirmedByDevice(facts: DeviceStreamFacts): boolean {
	return !facts.isStreaming && facts.lifecycle === "idle";
}

export interface StartSupersedeInput extends DeviceStreamFacts {
	optimismState: StreamingOptimismState;
	/**
	 * This attempt's start reply was lost to a connection reset AND a session has
	 * been restored since, so the status now held is the post-reconnect hydrate,
	 * not the stale pre-reset view.
	 */
	rehydratedSinceLostReply: boolean;
}

/**
 * Whether device evidence has superseded a local `starting`. The backend refuses
 * a start in `reconciling`/`stop_failed` and its own start can only have ENDED
 * there, so those settle it at once. A lost start reply settles on the
 * current-epoch idle commit. A hydrate that says `starting` (still in progress),
 * an absent lifecycle (older backend: no evidence either way, the start watchdog
 * still bounds it) and `is_streaming` true (the ordinary reconcile) keep it.
 */
export function startOptimismSuperseded(input: StartSupersedeInput): boolean {
	if (input.optimismState !== "starting" || input.isStreaming) return false;
	if (streamStateUnconfirmed(input)) return true;
	return input.rehydratedSinceLostReply && input.lifecycle === "idle";
}
