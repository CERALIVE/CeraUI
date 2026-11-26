/**
 * Cellular-stack readiness middleware.
 *
 * The `dbus` cellular backend has an init window (the composition root commits it
 * only on its first authoritative snapshot). Procedures using that backend
 * would otherwise read a half-initialised source. While the stack is not ready,
 * a gated call answers the typed
 * `CELLULAR_STACK_INITIALIZING` error rather than hanging or returning a
 * fabricated empty modem list.
 *
 * On the default mmcli backend the stack is ready from process start, so this is
 * an unconditional pass-through and the pre-Phase-B behaviour is unchanged.
 */
import { os } from "@orpc/server";

import { assertCellularStackReady } from "../../modules/cellular/cellular-stack.ts";
import type { RPCContext } from "../types.ts";

export const cellularReadyMiddleware = os
	.$context<RPCContext>()
	.middleware(async ({ next }) => {
		assertCellularStackReady();
		return next();
	});
