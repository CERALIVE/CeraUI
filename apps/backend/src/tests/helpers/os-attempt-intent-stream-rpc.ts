import { os } from "@orpc/server";
import { z } from "zod";
import { createStreamSessionOrchestrator } from "../../modules/streaming/stream-session-orchestrator.ts";
import { admitAndPrepareStreamStart } from "../../modules/system/update-orchestrator/runtime.ts";
import { handleORPCMessage } from "../../rpc/adapter.ts";
import { initSocketData } from "../../rpc/context.ts";
import type { RPCContext, SocketData } from "../../rpc/types.ts";

const replySchema = z.object({
	id: z.string(),
	error: z
		.object({ code: z.string(), retryable: z.boolean().optional() })
		.optional(),
	result: z.object({ result: z.string() }).optional(),
});

export async function streamRpcFixture() {
	let launches = 0;
	let failure: Error | undefined;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "stream-attempt",
		setStreamingStatus: () => undefined,
		stopRuntime: async () => undefined,
		queryRuntime: async () => "idle",
		admitUpdate: admitAndPrepareStreamStart,
	});
	const router = {
		streaming: {
			start: os.$context<RPCContext>().handler(async () => {
				failure = undefined;
				try {
					return await session.start({
						origin: "ui",
						launch: async () => {
							launches++;
						},
					});
				} catch (error) {
					if (error instanceof Error) failure = error;
					throw error;
				}
			}),
		},
	};
	let response = Promise.withResolvers<z.infer<typeof replySchema>>();
	const opened = Promise.withResolvers<void>();
	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request, { data: initSocketData() })) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			async message(ws) {
				await handleORPCMessage(
					ws,
					{ id: "stream", path: ["streaming", "start"], input: {} },
					router,
				);
			},
		},
	});
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
	socket.onopen = () => opened.resolve();
	socket.onerror = (error) => {
		opened.reject(error);
		response.reject(error);
	};
	socket.onmessage = ({ data }) => {
		try {
			response.resolve(replySchema.parse(JSON.parse(String(data))));
		} catch (error) {
			response.reject(error);
		}
	};
	try {
		await opened.promise;
	} catch (error) {
		socket.close();
		await server.stop(true);
		throw error;
	}
	return {
		request: async () => {
			response = Promise.withResolvers<z.infer<typeof replySchema>>();
			socket.send("start");
			return response.promise;
		},
		failure: () => failure,
		launches: () => launches,
		[Symbol.asyncDispose]: async () => {
			socket.close();
			await server.stop(true);
		},
	};
}
