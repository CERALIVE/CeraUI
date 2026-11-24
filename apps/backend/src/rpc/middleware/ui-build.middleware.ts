/**
 * Refuses Live writes from a UI page built from other code than this backend.
 *
 * An open tab keeps running the bundle it loaded after an update installs a new
 * one, so it cannot apply `config_clear` and may show one choice while Start
 * launches another. A page names its build on its socket URL (`ui_build`); the
 * upgrade records it as `uiBuild`, `null` when the page named none (a bundle
 * from before this check). A different or missing build is out of date: the
 * gated procedure throws before its handler runs, so nothing changes and no
 * engine is called, and the socket is told to reload, in shapes the pre-upgrade
 * bundle already renders (a failure toast, the notification's free-text
 * `msg`). A context with no `uiBuild` at all is not a page (the cloud
 * dashboard's device-control channel) and is never gated; neither is anything
 * on a backend with no identity of its own (a dev checkout without
 * `CERAUI_BUILD_ID`).
 */
import { ORPCError, os } from "@orpc/server";

import { logger } from "../../helpers/logger.ts";
import { sendToClient } from "../events.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";

export const UI_OUT_OF_DATE_MESSAGE =
	"This page is out of date. Reload to continue.";

let identity: Promise<string | undefined> = Promise.resolve(undefined);

/**
 * Read this backend's build identity once, at boot. Started before the server
 * binds and never awaited there (the bind comes first); every check awaits it,
 * so no call is decided before the read settles.
 */
export function initUiBuildIdentity(
	read: () => Promise<string | undefined>,
): Promise<void> {
	identity = read().then(
		(value) => {
			logger.info("UI build identity", {
				module: "rpc.ui-build",
				identity: value ?? "none (check off)",
			});
			return value;
		},
		(error: unknown) => {
			logger.error("UI build identity unreadable; check off", {
				module: "rpc.ui-build",
				err: error,
			});
			return undefined;
		},
	);
	return identity.then(() => undefined);
}

export async function isOutOfDateUi(ws: AppWebSocket): Promise<boolean> {
	const own = await identity;
	const announced = ws.data.uiBuild;
	return own !== undefined && announced !== undefined && announced !== own;
}

export function sendOutOfDateNotice(ws: AppWebSocket): void {
	sendToClient(ws, "notification", {
		show: [
			{
				name: "ui-out-of-date",
				type: "error",
				msg: UI_OUT_OF_DATE_MESSAGE,
				is_dismissable: true,
				// Shown in place, not as a toast that times out, until the page reloads.
				is_persistent: true,
				duration: 0,
			},
		],
	});
}

export const uiBuildMiddleware = os
	.$context<RPCContext>()
	.middleware(async ({ context, next, path }) => {
		if (await isOutOfDateUi(context.ws)) {
			logger.warn("rpc: refused a Live write from an out-of-date page", {
				module: "rpc.ui-build",
				procedure: path.join("."),
				announced: context.ws.data.uiBuild,
			});
			sendOutOfDateNotice(context.ws);
			throw new ORPCError("UI_OUT_OF_DATE", {
				message: UI_OUT_OF_DATE_MESSAGE,
			});
		}
		return next();
	});
