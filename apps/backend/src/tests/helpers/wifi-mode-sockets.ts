import { spyOn } from "bun:test";
import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import * as compat from "../../rpc/compat.ts";
import { addClient, broadcast, removeClient } from "../../rpc/events.ts";
import { fixture } from "./wifi-entry-fixture.ts";
import { wifiProtocolContext } from "./wifi-protocol-context.ts";

export async function wifiModeSockets() {
	const state = await fixture();
	const frames: string[][] = [[], [], []];
	const clients = frames.map((received) =>
		wifiProtocolContext((raw) => received.push(raw)),
	);
	for (const client of clients) addClient(client.ws);
	spyOn(compat, "broadcastMsg").mockImplementation((type, data) =>
		broadcast(type, data),
	);
	const [a, b, observer] = clients;
	const [receivedA, receivedB, receivedObserver] = frames;
	if (!a || !b || !observer || !receivedA || !receivedB || !receivedObserver)
		throw new Error("missing mode socket fixture");
	return {
		...state,
		a,
		b,
		observer,
		receivedA,
		receivedB,
		receivedObserver,
		modes: (received: readonly string[]) =>
			received.flatMap((raw) => {
				const mode = wifiMessageSchema.parse(JSON.parse(raw).wifi).adapter_mode;
				return mode === undefined ? [] : [mode];
			}),
		restore: async () => {
			for (const client of clients) removeClient(client.ws);
			await state.restore();
		},
	};
}
