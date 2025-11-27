/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * WebSocket Server Compatibility Layer
 *
 * This module re-exports functions from the new RPC system for backward compatibility.
 * The actual WebSocket server is now integrated with HTTP via Bun.serve() in src/rpc/server.ts
 *
 * @deprecated Use imports from src/rpc/index.ts directly for new code
 */

// Re-export compatibility functions
export {
	addAuthedSocket,
	broadcastMsg,
	broadcastMsgExcept,
	broadcastMsgLocal,
	buildMsg,
	deleteAuthedSocket,
	deleteSocketSenderId,
	getLastActive,
	getSocketSenderId,
	isAuthedSocket,
	markConnectionActive,
	setSocketSenderId,
} from "../../rpc/compat.ts";

// Export Message type for backward compatibility
import type { ModemsMessage } from "../modems/modems.ts";
import type { NetworkInterfaceMessage } from "../network/network-interfaces.ts";
import type { BitrateParams } from "../streaming/encoder.ts";
import type { StartMessage } from "../streaming/streaming.ts";
import type { WifiMessage } from "../wifi/wifi.ts";
import type { AuthMessage } from "./auth.ts";

type KeepAliveMessage = { keepalive: unknown };
type StopMessage = { stop: unknown };
type BitrateMessage = { bitrate: BitrateParams };

type ConfigPasswordMessage = {
	password: string;
};

type ConfigRemoteKeyMessage = {
	remote_key: string;
};

type ConfigMessage = {
	config: ConfigPasswordMessage | ConfigRemoteKeyMessage;
};

type CommandMessage = {
	command: string;
};

export type Message =
	| KeepAliveMessage
	| StartMessage
	| StopMessage
	| BitrateMessage
	| AuthMessage
	| ConfigMessage
	| CommandMessage
	| WifiMessage
	| ModemsMessage
	| NetworkInterfaceMessage;

/**
 * @deprecated WebSocket server is now integrated with HTTP server
 * This function is a no-op for backward compatibility
 */
export function initWebSocketServer() {
	// No-op: WebSocket is now handled by Bun.serve() in src/rpc/server.ts
}

/**
 * @deprecated Use handleMessage from RPC adapter
 * This is kept for modules that may import it
 */
export function handleMessage() {
	// No-op: Messages are handled in src/rpc/adapter.ts
}
