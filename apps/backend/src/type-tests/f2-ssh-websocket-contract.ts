import { startStopSsh } from "../modules/system/ssh.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const startStopSshAcceptsAppWebSocket: (
	socket: AppWebSocket,
	command: "start_ssh" | "stop_ssh",
) => Promise<boolean> = startStopSsh;
void startStopSshAcceptsAppWebSocket;
