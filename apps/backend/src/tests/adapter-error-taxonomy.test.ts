/*
 * RPC error taxonomy — VALIDATION_ERROR vs INTERNAL_ERROR (Task 2).
 *
 * The WS adapter dispatches procedures with oRPC's `call()` outside an
 * RPCHandler pipeline, so every failure lands in one catch block. Before this
 * task that block emitted a single opaque `code: "INTERNAL_ERROR"` for every
 * failure — a Zod-rejected input was indistinguishable from a genuine engine
 * crash on the wire, so the frontend could only ever show one generic toast.
 *
 * This suite pins the classification the adapter now performs on the OUTBOUND
 * error envelope (the frame actually sent to the client, not just the log):
 *
 *   - INPUT validation failure  → code "VALIDATION_ERROR" + safe field paths
 *   - OUTPUT validation failure → code "VALIDATION_ERROR" + safe field paths
 *   - any other thrown error    → code "INTERNAL_ERROR", no field paths
 *
 * The field paths ride an additive optional `fields` array; the existing
 * `{ message, code }` shape is untouched (additive-only). The outbound message
 * is scrubbed through `logRedact`, so a secret-shaped value can never leak to
 * the client via the error frame.
 */
import { describe, expect, test } from "bun:test";
import { os } from "@orpc/server";
import { z } from "zod";

import { handleORPCMessage } from "../rpc/adapter.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const KNOWN_SECRET = "v4.public.shouldNeverSurface";

interface ErrorEnvelope {
	id?: string;
	error?: { message: string; code: string; fields?: string[] };
}

/** Minimal Bun ServerWebSocket stand-in that records every frame sent. */
function fakeWs(): AppWebSocket & { __sent: string[] } {
	const sent: string[] = [];
	const ws = {
		remoteAddress: "203.0.113.7",
		data: {
			isAuthenticated: true,
			lastActive: Date.now(),
			senderId: "sender-7",
		},
		send: (payload: string) => {
			sent.push(payload);
			return payload.length;
		},
		__sent: sent,
	};
	return ws as unknown as AppWebSocket & { __sent: string[] };
}

/** Pull the single error envelope the adapter sent to the client. */
function sentEnvelope(ws: { __sent: string[] }): ErrorEnvelope {
	expect(ws.__sent.length).toBe(1);
	return JSON.parse(ws.__sent[0] as string) as ErrorEnvelope;
}

// Tiny router with no auth gate: one procedure that fails INPUT validation, one
// that fails OUTPUT validation, and one whose handler throws a plain Error.
const base = os.$context<RPCContext>();
const testRouter = os.$context<RPCContext>().router({
	probe: os.router({
		inputFail: base
			.input(z.object({ count: z.number() }))
			.output(z.object({ ok: z.boolean() }))
			.handler(() => ({ ok: true })),
		outputFail: base
			.input(z.object({ note: z.string() }))
			.output(z.object({ count: z.number() }))
			.handler(
				() => ({ count: "not-a-number" }) as unknown as { count: number },
			),
		throwPlain: base
			.input(z.object({ note: z.string() }))
			.output(z.object({ ok: z.boolean() }))
			.handler(() => {
				throw new Error("engine exploded");
			}),
	}),
});

describe("rpc adapter error taxonomy", () => {
	test("INPUT validation failure → VALIDATION_ERROR + field path", async () => {
		const ws = fakeWs();
		await handleORPCMessage(
			ws,
			{ id: "m1", path: ["probe", "inputFail"], input: { count: KNOWN_SECRET } },
			testRouter,
		);

		const envelope = sentEnvelope(ws);
		expect(envelope.id).toBe("m1");
		expect(envelope.error?.code).toBe("VALIDATION_ERROR");
		expect(envelope.error?.fields).toBeDefined();
		expect(envelope.error?.fields).toContain("count");
		// The secret-shaped input value must never reach the client.
		expect(ws.__sent[0]).not.toContain(KNOWN_SECRET);
	});

	test("OUTPUT validation failure → VALIDATION_ERROR + field path", async () => {
		const ws = fakeWs();
		await handleORPCMessage(
			ws,
			{ id: "m2", path: ["probe", "outputFail"], input: { note: "hi" } },
			testRouter,
		);

		const envelope = sentEnvelope(ws);
		expect(envelope.error?.code).toBe("VALIDATION_ERROR");
		expect(envelope.error?.fields).toContain("count");
	});

	test("plain thrown error → INTERNAL_ERROR, no field paths", async () => {
		const ws = fakeWs();
		await handleORPCMessage(
			ws,
			{ id: "m3", path: ["probe", "throwPlain"], input: { note: "hi" } },
			testRouter,
		);

		const envelope = sentEnvelope(ws);
		expect(envelope.error?.code).toBe("INTERNAL_ERROR");
		expect(envelope.error?.fields).toBeUndefined();
	});

	test("unknown procedure path → INTERNAL_ERROR, no field paths", async () => {
		const ws = fakeWs();
		await handleORPCMessage(
			ws,
			{ id: "m4", path: ["probe", "doesNotExist"], input: {} },
			testRouter,
		);

		const envelope = sentEnvelope(ws);
		expect(envelope.error?.code).toBe("INTERNAL_ERROR");
		expect(envelope.error?.fields).toBeUndefined();
	});
});
