import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";
import { call } from "@orpc/server";
import { getConfig } from "../modules/config.ts";
import {
	canDialControlChannel,
	initIdentity,
} from "../modules/identity/index.ts";
import {
	completePlatformPairing,
	getPlatformUrl,
	type PlatformFetch,
	platformClaimErrorForStatus,
} from "../modules/pairing/platform-claim.ts";
import { getRemoteWebSocket } from "../modules/remote/remote.ts";
import { createContext } from "../rpc/context.ts";
import { completePairingProcedure } from "../rpc/procedures/pairing.procedure.ts";
import type { RPCContext, SocketData } from "../rpc/types.ts";

const SERIAL = "CERATESTSERIAL22";
const PLATFORM_URL = "https://platform.test.example";

const CLAIM_RESPONSE = {
	deviceToken: "ct_abc123opaque",
	tokenType: "opaque",
	deviceId: "7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e",
	tenantId: "tenant-id-abc",
	serial: SERIAL,
	claimedAt: "2026-06-08T10:00:00.000Z",
};

let savedPlatformUrl: string | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let savedConfigFile: string | undefined;

beforeEach(() => {
	savedPlatformUrl = process.env.PLATFORM_URL;
	process.env.PLATFORM_URL = PLATFORM_URL;
	savedConfigFile = readFileSync("config.json", "utf8");
	getConfig().remote_key = undefined;
	getConfig().device_id = undefined;
});

afterEach(() => {
	fetchSpy?.mockRestore();
	getRemoteWebSocket()?.terminate();
	if (savedPlatformUrl === undefined) delete process.env.PLATFORM_URL;
	else process.env.PLATFORM_URL = savedPlatformUrl;
	if (savedConfigFile !== undefined)
		writeFileSync("config.json", savedConfigFile);
});

/** Build a fetch stub that records the request and returns a canned Response. */
function stubFetch(response: Response): {
	fetchImpl: PlatformFetch;
	calls: { url: string; body: unknown }[];
} {
	const calls: { url: string; body: unknown }[] = [];
	const fetchImpl: PlatformFetch = async (input, init) => {
		const url = input instanceof URL ? input.toString() : String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, body });
		return response;
	};
	return { fetchImpl, calls };
}

function openRpcContext(): Promise<{
	readonly context: RPCContext;
	readonly close: () => void;
}> {
	return new Promise((resolve, reject) => {
		const server = Bun.serve<SocketData>({
			port: 0,
			fetch(request, server) {
				const upgraded = server.upgrade(request, {
					data: { isAuthenticated: true, lastActive: Date.now() },
				});
				if (upgraded) return;
				return new Response("expected WebSocket upgrade", { status: 400 });
			},
			websocket: {
				open(ws) {
					resolve({
						context: createContext(ws),
						close: () => {
							client.close();
							ws.close();
							server.stop(true);
						},
					});
				},
				message() {},
			},
		});
		const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
		client.addEventListener("error", () => {
			server.stop(true);
			reject(new Error("failed to open test RPC WebSocket"));
		});
	});
}

describe("platform claim — error-status mapping", () => {
	test("maps documented platform statuses to stable machine codes", () => {
		expect(platformClaimErrorForStatus(400)).toBe("invalid-claim-code");
		expect(platformClaimErrorForStatus(402)).toBe("subscription-required");
		expect(platformClaimErrorForStatus(409)).toBe("claim-code-consumed");
		expect(platformClaimErrorForStatus(410)).toBe("claim-code-expired");
		expect(platformClaimErrorForStatus(500)).toBe("platform-error-500");
	});
});

describe("getPlatformUrl — env sourcing", () => {
	test("reads PLATFORM_URL and treats blank/whitespace as unset", () => {
		expect(getPlatformUrl()).toBe(PLATFORM_URL);
		process.env.PLATFORM_URL = "   ";
		expect(getPlatformUrl()).toBeUndefined();
		delete process.env.PLATFORM_URL;
		expect(getPlatformUrl()).toBeUndefined();
	});
});

describe("completePlatformPairing — real POST /api/claim", () => {
	test("posts claimCode+serial to <PLATFORM_URL>/api/claim and applies the token", async () => {
		const { fetchImpl, calls } = stubFetch(
			new Response(JSON.stringify(CLAIM_RESPONSE), { status: 200 }),
		);
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(true);
		expect(result.device_id).toBe(CLAIM_RESPONSE.deviceId);
		expect(applied).toBe(CLAIM_RESPONSE.deviceToken);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${PLATFORM_URL}/api/claim`);
		expect(calls[0]?.body).toEqual({ claimCode: "ABCDEFGH", serial: SERIAL });
	});

	test("completePairingProcedure persists token plus device_id through setRemoteConfig", async () => {
		const claimResponse = new Response(JSON.stringify(CLAIM_RESPONSE), {
			status: 200,
		});
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (..._args: Parameters<typeof fetch>) => claimResponse,
				{
					preconnect: globalThis.fetch.preconnect,
				},
			),
		);

		const rpc = await openRpcContext();
		try {
			const result = await call(
				completePairingProcedure,
				{ code: "ABCDEFGH" },
				{ context: rpc.context },
			);
			await initIdentity();

			expect(result.paired).toBe(true);
			expect(result.device_id).toBe(CLAIM_RESPONSE.deviceId);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(getConfig().remote_key).toBe(CLAIM_RESPONSE.deviceToken);
			expect(getConfig().device_id).toBe(CLAIM_RESPONSE.deviceId);
			expect(canDialControlChannel()).toBe(true);
		} finally {
			rpc.close();
		}
	});

	test("surfaces 402 subscription-required and applies no token", async () => {
		const { fetchImpl } = stubFetch(
			new Response(JSON.stringify({ error: "subscription_required" }), {
				status: 402,
			}),
		);
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("subscription-required");
		expect(applied).toBeUndefined();
	});

	test("surfaces 409 consumed / 410 expired / 400 invalid without a token", async () => {
		for (const [status, error] of [
			[409, "claim-code-consumed"],
			[410, "claim-code-expired"],
			[400, "invalid-claim-code"],
		] as const) {
			const { fetchImpl } = stubFetch(new Response("{}", { status }));
			let applied: string | undefined;
			const result = await completePlatformPairing("ABCDEFGH", {
				applyToken: (token) => {
					applied = token;
				},
				serial: SERIAL,
				fetchImpl,
			});
			expect(result.paired).toBe(false);
			expect(result.error).toBe(error);
			expect(applied).toBeUndefined();
		}
	});

	test("maps a network/timeout failure to network-error", async () => {
		const fetchImpl: PlatformFetch = async () => {
			throw new Error("connection refused");
		};
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("network-error");
		expect(applied).toBeUndefined();
	});

	test("rejects a malformed success body as invalid-platform-response", async () => {
		const { fetchImpl } = stubFetch(
			new Response(JSON.stringify({ deviceToken: 123 }), { status: 200 }),
		);
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("invalid-platform-response");
		expect(applied).toBeUndefined();
	});

	test("errors when PLATFORM_URL is not configured", async () => {
		delete process.env.PLATFORM_URL;
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl: async () => new Response("{}"),
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("platform-not-configured");
		expect(applied).toBeUndefined();
	});
});
