import { expect, test } from "bun:test";

import type { MessageSocket } from "../modules/ui/message-socket.ts";
import { notificationSend } from "../modules/ui/notifications.ts";

test("message socket preserves sender id and notification payload", () => {
	const sent: string[] = [];
	const socket: MessageSocket = {
		data: { senderId: "f2-sender" },
		send: (message) => {
			sent.push(message);
		},
	};

	notificationSend(
		socket,
		"f2-contract",
		"warning",
		"structural socket payload",
		5,
	);

	const output = sent[0] ?? "";
	expect(output).toContain('"id":"f2-sender"');
	expect(output).toContain('"name":"f2-contract"');
	expect(output).toContain('"msg":"structural socket payload"');
});
