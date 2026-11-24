/**
 * The one way a `config` broadcast leaves the device (GAP-2).
 *
 * The runtime config holds a cleared setting as absent, and the broadcast is
 * JSON, which drops an absent key: a `config` frame cannot say a key is gone,
 * and a client's merge keeps the old value. This remembers the keys clients
 * were sent and, after a broadcast that no longer carries one of them, sends
 * `config_clear` naming them, on the same sockets and after the `config` frame,
 * so a client never re-adds a cleared key from the same write. The `config`
 * frame itself is unchanged: old tabs and the cloud relay parse it as before,
 * and a client that predates `config_clear` ignores it. It is not relayed.
 */
import { CONFIG_CLEAR_EVENT } from "@ceraui/rpc/schemas";

import { broadcastMsg } from "./compat.ts";

let sent = new Set<string>();

function carried(config: object): Set<string> {
	return new Set(
		Object.entries(config)
			.filter(([, value]) => value !== undefined)
			.map(([key]) => key),
	);
}

/** A client was sent `config` outside a broadcast: its login snapshot. */
export function rememberConfigSent(config: object): void {
	for (const key of carried(config)) sent.add(key);
}

/** Broadcast `config`, then `config_clear` for every key it no longer carries. */
export function broadcastConfig(config: object): void {
	const now = carried(config);
	const cleared = [...sent].filter((key) => !now.has(key));
	broadcastMsg("config", config);
	if (cleared.length > 0) broadcastMsg(CONFIG_CLEAR_EVENT, { keys: cleared });
	sent = now;
}
