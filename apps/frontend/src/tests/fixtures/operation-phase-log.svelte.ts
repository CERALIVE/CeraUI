/**
 * Records every distinct phase an async operation passes through, in order, so
 * a test can assert the whole history ("confirmed exactly once", "never
 * confirmed before it failed") against a literal array instead of sampling.
 */
import { flushSync } from "svelte";

import { getOperationPhase } from "$lib/rpc/async-operation.svelte";

export function recordOperationPhases(key: string): {
	phases: string[];
	stop: () => void;
} {
	const phases: string[] = [];
	const stop = $effect.root(() => {
		$effect(() => {
			const phase = getOperationPhase(key);
			if (phases.at(-1) !== phase) phases.push(phase);
		});
	});
	flushSync();
	return { phases, stop };
}
