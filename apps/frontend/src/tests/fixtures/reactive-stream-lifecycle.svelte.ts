/**
 * Reactive test seam for the unconfirmed-stream tests: the lifecycle, the
 * authoritative `is_streaming` and the optimism overlay as module-level `$state`,
 * so a mocked getter that reads them re-runs LiveView's deriveds on
 * `value = …; flushSync()`.
 */
import type { LifecycleState } from "@ceraui/rpc/schemas";

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
