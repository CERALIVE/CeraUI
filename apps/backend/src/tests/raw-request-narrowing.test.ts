import { describe, expect, test } from "bun:test";

import {
	asRawRequestClient,
	isRawRequestClient,
	RawRequestUnsupportedError,
} from "../modules/streaming/raw-request.ts";

describe("asRawRequestClient — the binding's undeclared escape hatch", () => {
	test("a client carrying rawRequest is returned and dispatches verbatim", async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const client = {
			hello: { schema_version: "0.9.0" },
			rawRequest: (method: string, params?: unknown) => {
				calls.push({ method, params });
				return Promise.resolve({ ok: true });
			},
		};

		const raw = asRawRequestClient(client, "reload-config");
		await expect(
			raw.rawRequest("reload-config", { audio: { meter_device: null } }),
		).resolves.toEqual({ ok: true });
		expect(calls).toEqual([
			{ method: "reload-config", params: { audio: { meter_device: null } } },
		]);
	});

	test("a client without rawRequest is a named error, not `not a function`", () => {
		let thrown: unknown;
		try {
			asRawRequestClient(
				{ hello: { schema_version: "0.9.0" } },
				"switch-audio",
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(RawRequestUnsupportedError);
		expect((thrown as RawRequestUnsupportedError).site).toBe("switch-audio");
	});

	test("the guard rejects every non-client value without throwing", () => {
		expect(isRawRequestClient(undefined)).toBe(false);
		expect(isRawRequestClient(null)).toBe(false);
		expect(isRawRequestClient("client")).toBe(false);
		expect(isRawRequestClient({ rawRequest: "not-callable" })).toBe(false);
		expect(isRawRequestClient({ rawRequest: () => Promise.resolve(1) })).toBe(
			true,
		);
	});
});
