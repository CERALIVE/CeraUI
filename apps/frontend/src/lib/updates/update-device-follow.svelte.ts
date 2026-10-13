/**
 * Keeps an OPEN Updates dialog's pulled details in step with the device.
 *
 * Two things make them stale. The pushed phase moved: the facts it implies are
 * pulled again, and the phase itself is evidence for an action. Or the link
 * dropped and the session was restored: the device may have run a whole cycle
 * and come back to the very phase it left, so an unchanged phase proves
 * nothing and only a fresh read can (round-2 review C, M2). That read covers
 * the settings as well as the details: a write whose reply the outage hid may
 * have been applied (round-3 review C, C3-3). The open edge itself is the
 * surface's `load()`, never a step here.
 */
import type { UpdateOrchestratorPhase } from "@ceraui/rpc/schemas";
import { untrack } from "svelte";

import { getRestoredSessions } from "$lib/rpc/session-epoch.svelte";
import type { UpdateSurface } from "./update-surface.svelte";

export interface DeviceFrame {
	readonly open: boolean;
	readonly phase: UpdateOrchestratorPhase | undefined;
	/** `getRestoredSessions()` when the frame was taken. */
	readonly restored: number;
}

export type FollowStep =
	| { readonly kind: "none" }
	| {
			readonly kind: "phase";
			readonly phase: UpdateOrchestratorPhase | undefined;
	  }
	| { readonly kind: "reread" };

/** What one new frame asks of the dialog, given the last frame it saw. */
export function followStep(seen: DeviceFrame, next: DeviceFrame): FollowStep {
	if (!next.open) return { kind: "none" };
	if (next.phase !== seen.phase) return { kind: "phase", phase: next.phase };
	if (next.restored !== seen.restored) return { kind: "reread" };
	return { kind: "none" };
}

/** Registers the follower; call during the dialog component's initialisation. */
export function followDeviceState(
	surface: Pick<UpdateSurface, "observePhase" | "reread">,
	frame: () => Omit<DeviceFrame, "restored">,
): void {
	let seen: DeviceFrame = {
		open: false,
		phase: undefined,
		restored: untrack(getRestoredSessions),
	};
	$effect(() => {
		const next = { ...frame(), restored: getRestoredSessions() };
		const step = followStep(seen, next);
		seen = next;
		untrack(() => {
			switch (step.kind) {
				case "none":
					return;
				case "phase":
					void surface.observePhase(step.phase);
					return;
				case "reread":
					void surface.reread();
					return;
				default: {
					const unreachable: never = step;
					return unreachable;
				}
			}
		});
	});
}
