/**
 * Reactive test seam for the unconfirmed-stream tests: the lifecycle, the
 * authoritative `is_streaming` and the optimism overlay as module-level `$state`,
 * so a mocked getter that reads them re-runs LiveView's deriveds on
 * `value = …; flushSync()`.
 *
 * Setting the lifecycle models a status frame that CARRIES it: it stamps the
 * real lifecycle-delivery witness on the current link, as the subscription
 * store does (FIX-16-FRONT3 R1). `reset()` delivers nothing.
 */
import type { LifecycleState } from "@ceraui/rpc/schemas";

import { noteLifecycleDelivered } from "$lib/rpc/session-epoch.svelte";
import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";

let lifecycle = $state<LifecycleState | undefined>(undefined);
let streaming = $state(false);
let optimism = $state<StreamingOptimismState>("idle");

export const streamLifecycleFixture = {
	get lifecycle(): LifecycleState | undefined {
		return lifecycle;
	},
	set lifecycle(next: LifecycleState | undefined) {
		lifecycle = next;
		noteLifecycleDelivered();
	},
	get streaming(): boolean {
		return streaming;
	},
	set streaming(next: boolean) {
		streaming = next;
	},
	get optimism(): StreamingOptimismState {
		return optimism;
	},
	set optimism(next: StreamingOptimismState) {
		optimism = next;
	},
	reset(): void {
		lifecycle = undefined;
		streaming = false;
		optimism = "idle";
	},
};
