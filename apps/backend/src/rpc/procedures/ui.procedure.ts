import { successResponseSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { noteUiHeartbeat } from "../../modules/system/idle-state.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

export const heartbeatProcedure = os
	.$context<RPCContext>()
	.use(authMiddleware)
	.output(successResponseSchema)
	.handler(() => {
		noteUiHeartbeat();
		return { success: true };
	});
