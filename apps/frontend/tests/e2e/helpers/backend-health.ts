import type { PageRpc } from '../fixtures/page-rpc.js';

/**
 * Let the dev backend's OWN periodic `health` broadcast land before a spec
 * injects one of its own.
 *
 * `broadcastHealthIfChanged()` (backend `modules/streaming/health.ts`) runs on
 * the 5s heartbeat tick — right AFTER the `ping` that tick emits — and publishes
 * only on a state TRANSITION. A worker backend boots with no last-broadcast
 * state and its mock scenario never leaves `idle`, so it publishes EXACTLY ONE
 * unsolicited `health: idle` frame per process. Left unaccounted for, that frame
 * lands mid-test, replaces whatever the spec injected, and is never corrected: a
 * `dev.emit` driver stops emitting the moment the dot settles, so every later
 * assertion reads `idle` until the test times out.
 *
 * One socket delivers in order and a heartbeat tick is a synchronous block, so a
 * `ping` the spec has observed proves that tick's `health` frame is already
 * behind it. After it the backend can never broadcast health again (its state no
 * longer transitions), which makes every injected frame the last word.
 */
export async function settleBackendHealthBroadcast(pageRpc: PageRpc): Promise<void> {
	await pageRpc.waitForPushedEvent('ping');
}
