/**
 * Relay Procedures
 *
 * `validate` proves a manual custom-relay endpoint is usable WITHOUT starting a
 * stream. It walks ordered stages and returns the first failure so the UI can
 * point the operator at the exact problem:
 *
 *   input    → address/port shape
 *   protocol → a working transport adapter exists for the protocol
 *   endpoint → the transport adapter accepts the config (golden srtla rules)
 *   dns      → the host resolves
 *
 * The endpoint stage reuses the Task 7 transport adapter so validation stays in
 * lock-step with the live resolver.
 */

import { lookup } from "node:dns/promises";

import {
	type RelayValidateOutput,
	relayValidateInputSchema,
	relayValidateOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { getAdapter } from "../../modules/streaming/transport/registry.ts";
import {
	NotImplementedError,
	UnknownProtocolError,
} from "../../modules/streaming/transport/types.ts";
import { validatePortNo } from "../../helpers/number.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const baseProcedure = os.$context<RPCContext>();
const authedProcedure = baseProcedure.use(authMiddleware);

function fail(stage: RelayValidateOutput["stage"], reason: string): RelayValidateOutput {
	return { ok: false, stage, reason };
}

export const relayValidateProcedure = authedProcedure
	.input(relayValidateInputSchema)
	.output(relayValidateOutputSchema)
	.handler(async ({ input }): Promise<RelayValidateOutput> => {
		const addr = input.addr.trim();
		if (addr === "") return fail("input", "Address is required");
		if (!validatePortNo(input.port)) return fail("input", "Port must be between 1 and 65535");

		const protocol = input.protocol ?? "srtla";
		let adapter: ReturnType<typeof getAdapter>;
		try {
			adapter = getAdapter(protocol);
		} catch (error) {
			if (error instanceof UnknownProtocolError) return fail("protocol", error.message);
			throw error;
		}

		try {
			adapter.validate({
				srtla_addr: addr,
				srtla_port: input.port,
				srt_streamid: input.streamid ?? "",
			});
		} catch (error) {
			const stage = error instanceof NotImplementedError ? "protocol" : "endpoint";
			return fail(stage, error instanceof Error ? error.message : "Invalid endpoint");
		}

		try {
			await lookup(addr);
		} catch {
			return fail("dns", `Cannot resolve host '${addr}'`);
		}

		return { ok: true, stage: "ok" };
	});
