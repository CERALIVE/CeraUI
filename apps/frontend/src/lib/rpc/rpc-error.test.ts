/**
 * RPC error taxonomy — frontend mapping (Task 2).
 *
 * Proves the two backend wire codes resolve to two DISTINCT operator toasts:
 * a `VALIDATION_ERROR` names the offending field(s), while any other failure
 * (`INTERNAL_ERROR`, a raw transport `Error`) gets the generic request-failed
 * copy. The strings are resolved against the REAL `en` locale so the test
 * fails if either i18n key is missing or stops interpolating `{fields}`.
 */
import { describe, expect, it } from "vitest";

import en from "../../../../../packages/i18n/src/en";
import {
	describeRpcError,
	RpcError,
	rpcErrorToNotification,
} from "./rpc-error";

/** Walk a dotted i18n key into the raw `en` tree and interpolate params. */
function resolveEn(key: string, params: Record<string, string>): string {
	const template = key
		.split(".")
		.reduce<unknown>(
			(node, segment) =>
				node && typeof node === "object"
					? (node as Record<string, unknown>)[segment]
					: undefined,
			en,
		);
	if (typeof template !== "string") {
		throw new Error(`missing i18n key: ${key}`);
	}
	return template.replace(/\{(\w+)(?::\w+)?\}/g, (match, name: string) =>
		params[name] !== undefined ? params[name] : match,
	);
}

describe("describeRpcError", () => {
	it("VALIDATION_ERROR resolves to a distinct toast naming the fields", () => {
		const error = new RpcError({
			code: "VALIDATION_ERROR",
			message: "Input validation failed",
			fields: ["srtla_addr", "srt_latency"],
		});

		const descriptor = describeRpcError(error);
		expect(descriptor.key).toBe("notifications.validationFailed");
		expect(descriptor.params.fields).toBe("srtla_addr, srt_latency");

		const toast = resolveEn(descriptor.key, descriptor.params);
		expect(toast).toContain("srtla_addr");
		expect(toast).toContain("srt_latency");
	});

	it("INTERNAL_ERROR resolves to the generic request-failed toast", () => {
		const error = new RpcError({
			code: "INTERNAL_ERROR",
			message: "engine exploded",
		});

		const descriptor = describeRpcError(error);
		expect(descriptor.key).toBe("notifications.requestFailed");
		expect(descriptor.params).toEqual({});
	});

	it("emits two DISTINCT toast strings for the two codes", () => {
		const validation = new RpcError({
			code: "VALIDATION_ERROR",
			message: "bad",
			fields: ["srtla_port"],
		});
		const internal = new RpcError({
			code: "INTERNAL_ERROR",
			message: "boom",
		});

		const validationToast = resolveEn(
			describeRpcError(validation).key,
			describeRpcError(validation).params,
		);
		const internalToast = resolveEn(
			describeRpcError(internal).key,
			describeRpcError(internal).params,
		);

		expect(validationToast).not.toBe(internalToast);
		expect(validationToast).toContain("srtla_port");
		expect(internalToast).not.toContain("srtla_port");
	});

	it("a VALIDATION_ERROR with no field paths falls back to generic copy", () => {
		const error = new RpcError({
			code: "VALIDATION_ERROR",
			message: "bad",
			fields: [],
		});
		expect(describeRpcError(error).key).toBe("notifications.requestFailed");
	});

	it("a plain transport Error is treated as a generic failure", () => {
		const descriptor = describeRpcError(new Error("WebSocket not connected"));
		expect(descriptor.key).toBe("notifications.requestFailed");
		expect(descriptor.fallback).toBe("WebSocket not connected");
	});
});

describe("rpcErrorToNotification", () => {
	it("bridges each code to a deduped error notification with its i18n key", () => {
		const validation = rpcErrorToNotification(
			new RpcError({
				code: "VALIDATION_ERROR",
				message: "bad",
				fields: ["srtla_addr"],
			}),
		);
		expect(validation.type).toBe("error");
		expect(validation.name).toBe("rpc-error:VALIDATION_ERROR");
		expect(validation.key).toBe("notifications.validationFailed");
		expect(validation.params).toEqual({ fields: "srtla_addr" });
		expect(validation.is_persistent).toBe(false);

		const internal = rpcErrorToNotification(
			new RpcError({ code: "INTERNAL_ERROR", message: "boom" }),
		);
		expect(internal.name).toBe("rpc-error:INTERNAL_ERROR");
		expect(internal.key).toBe("notifications.requestFailed");
		expect(internal.name).not.toBe(validation.name);
	});
});
