/**
 * Remote Control Plane v2.0 — outbound status relay (device → hub).
 *
 * This is the device half of the spec §8 "Status Frames" flow: the same
 * broadcast event types CeraUI already pushes to local clients are wrapped in a
 * `kind:status` envelope frame and emitted on the dedicated control channel, so
 * the hub can fan them out to subscribed operator clients.
 *
 * It is the resolution of the "v2 relay planned" TODOs in `rpc/compat.ts`
 * (`broadcastMsg` / `broadcastMsgExcept`). Local broadcast and the BCRPT relay
 * socket (`modules/remote/remote.ts`) are entirely untouched — this is a second,
 * independent outbound path.
 *
 * The control channel itself (the WS dialer, Task 13) is injected via
 * {@link setControlChannel}. Until it is wired, {@link relayStatusToGateway} is a
 * safe no-op (no channel set, or channel reports disconnected), so broadcasting
 * never throws or blocks the local path.
 */

import { advanceSeq } from "../../rpc/events.ts";
import { PROTOCOL_VERSION, type Status } from "./protocol.ts";

/**
 * Structural seam for the control-channel WS (Task 13 provides the concrete
 * impl). Kept intentionally minimal — the relay only needs to ask whether the
 * channel is up and hand it a fully-built frame to serialize and send.
 */
export interface ControlChannel {
	/** True when the control WS is open and the handshake has completed. */
	isConnected(): boolean;
	/** Serialize and send a single control frame. Best-effort (spec §8). */
	sendFrame(frame: unknown): void;
}

/**
 * The closed v2.0 set of relayable upstream status `type` values (spec §8).
 * This is exactly the broadcast set the hub fans out — it carries NO
 * secret-bearing or local-only types (see the no-secrets contract test).
 */
export const RELAYABLE_TYPES = [
	"status",
	"config",
	"sensors",
	"netif",
	"modems",
	"device-stats",
	"notifications",
] as const;
export type RelayableType = (typeof RELAYABLE_TYPES)[number];

const RELAYABLE_SET: ReadonlySet<string> = new Set(RELAYABLE_TYPES);

/** Whether a broadcast `type` is relayable onto the control channel (spec §8). */
export function isRelayable(type: string): boolean {
	return RELAYABLE_SET.has(type);
}

/**
 * The injected control channel. `null` until Task 13 wires the WS dialer; while
 * null the relay is a no-op so the local broadcast path is unaffected.
 */
let channel: ControlChannel | null = null;

/** Wire (or clear) the control channel. Task 13 calls this once the WS is up. */
export function setControlChannel(next: ControlChannel | null): void {
	channel = next;
}

/** Current control channel, or `null` if none is wired. */
export function getControlChannel(): ControlChannel | null {
	return channel;
}

/**
 * Per-`type` monotonic sequence counters for the relay path. Mirrors the local
 * fan-out machinery (`rpc/events.ts` `advanceSeq`) so each status `type` carries
 * an independently increasing `seq` for hub-side drop detection. Resets to 0 on
 * process restart (spec §8).
 */
const relaySeqCounters = new Map<string, number>();

/**
 * Advance and return the next relay `seq` for a status `type` (1-based,
 * monotonic per type). Exported so the broadcast bridge can stamp the frame.
 */
export function nextRelaySeq(type: string): number {
	return advanceSeq(relaySeqCounters, type);
}

/**
 * Wrap a relayable broadcast payload in a `kind:status` envelope frame and emit
 * it on the control channel — but only when a channel is wired and reports
 * connected. A missing or disconnected channel is a silent no-op (best-effort,
 * spec §8); it never throws and never disturbs the local broadcast.
 *
 * `cid` is a fresh UUID v4 — status is unsolicited and does not correlate to any
 * command (spec §8).
 */
export function relayStatusToGateway(
	type: string,
	payload: unknown,
	seq: number,
): void {
	if (!channel?.isConnected()) {
		return;
	}

	const frame: Status = {
		v: PROTOCOL_VERSION,
		kind: "status",
		type,
		cid: crypto.randomUUID(),
		seq,
		...(payload === undefined
			? {}
			: { payload: payload as Record<string, unknown> }),
	};

	channel.sendFrame(frame);
}

/**
 * Test-only: clear the wired channel and reset the per-type relay seq counters
 * so each test starts from a clean slate.
 */
export function resetStatusRelay(): void {
	channel = null;
	relaySeqCounters.clear();
}
