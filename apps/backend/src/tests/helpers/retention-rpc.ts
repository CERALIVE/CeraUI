import { expect, spyOn } from "bun:test";
import { handleORPCMessage } from "../../rpc/adapter.ts";
import { logsSockets } from "./logs-rpc.ts";

export async function expectInvalidRetention(input: unknown): Promise<void> {
	const sockets = await logsSockets();
	const send = spyOn(sockets.ws, "send");
	try {
		await handleORPCMessage(sockets.ws, {
			id: "invalid-retention",
			path: ["logs", "setRetention"],
			input,
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
			id: "invalid-retention",
			error: { code: "VALIDATION_ERROR" },
		});
	} finally {
		send.mockRestore();
		sockets.close();
	}
}
