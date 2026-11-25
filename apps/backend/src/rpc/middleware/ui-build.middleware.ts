/**
 * Refuses Live writes from a UI page built from other code than this backend.
 *
 * An open tab keeps running the bundle it loaded after an update installs a new
 * one, so it cannot apply `config_clear` and may show one choice while Start
 * launches another. A page names its build on its socket URL (`ui_build`); the
 * upgrade records it as `uiBuild`, `null` when the page named none (a bundle
 * from before this check). A different or missing build is out of date: the
 * gated procedure is refused before its input is read, so nothing changes and no
 * engine is called, and the socket is told to reload, in shapes the pre-upgrade
 * bundle already renders (its own failure message, the notification's free-text
 * `msg`), with a key a newer bundle localizes. Start answers with its own
 * `success: false`, because a page reads a thrown Start as a lost reply and shows
 * nothing; every other call throws, because some pages answer a resolved
 * `success: false` by retrying without a word. A context with no `uiBuild` at
 * all is not a page (the cloud dashboard's device-control channel) and is never
 * gated; neither is anything on a backend with no identity of its own (a dev
 * checkout without `CERAUI_BUILD_ID`).
 */
import type { StreamingStartOutputExtended } from "@ceraui/rpc/schemas";
import { ORPCError, os } from "@orpc/server";

import { logger } from "../../helpers/logger.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { nextRevision } from "../../modules/ui/notifications.ts";
import { sendToClient } from "../events.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";

export const UI_OUT_OF_DATE = "UI_OUT_OF_DATE";
export const UI_OUT_OF_DATE_MESSAGE =
	"This page is out of date. Reload to continue.";
const NOTICE = "ui-out-of-date";

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

async function isOutOfDateUi(ws: AppWebSocket): Promise<boolean> {
	const own = await identity;
	const announced = ws.data.uiBuild;
	return own !== undefined && announced !== undefined && announced !== own;
}

function sendOutOfDateNotice(ws: AppWebSocket): void {
	sendToClient(ws, "notification", {
		show: [
			{
				name: NOTICE,
				type: "error",
				// `msg` is what a bundle without the key shows.
				key: "notifications.uiOutOfDate",
				msg: UI_OUT_OF_DATE_MESSAGE,
				is_dismissable: true,
				// Shown in place, not as a toast that times out, until the page reloads
				// or signs in to a backend of its own build.
				is_persistent: true,
				duration: 0,
			},
		],
	});
}

/**
 * Tell a page that signed in whether to reload: an out-of-date one is shown the
 * notice, any other has the one an earlier backend left on it withdrawn.
 */
export async function syncOutOfDateNotice(ws: AppWebSocket): Promise<void> {
	if (await isOutOfDateUi(ws)) sendOutOfDateNotice(ws);
	else
		sendToClient(ws, "notification", {
			remove: [{ id: NOTICE, revision: nextRevision() }],
		});
}

/** Whether this call is refused; a page that is gets told to reload. */
async function refusesLiveWrite(
	ws: AppWebSocket,
	path: readonly string[],
): Promise<boolean> {
	if (!(await isOutOfDateUi(ws))) return false;
	logger.warn("rpc: refused a Live write from an out-of-date page", {
		module: "rpc.ui-build",
		procedure: path.join("."),
		announced: ws.data.uiBuild,
	});
	sendOutOfDateNotice(ws);
	return true;
}

export const uiBuildMiddleware = os
	.$context<RPCContext>()
	.middleware(async ({ context, next, path }) => {
		if (await refusesLiveWrite(context.ws, path)) {
			throw new ORPCError(UI_OUT_OF_DATE, {
				message: UI_OUT_OF_DATE_MESSAGE,
			});
		}
		return next();
	});

/** `streaming.start`'s form of the refusal: its own resolved failure. */
export const uiBuildStartMiddleware = os
	.$context<RPCContext>()
	.middleware(async ({ context, next, path }, _input, done) => {
		if (!(await refusesLiveWrite(context.ws, path))) return next();
		return done({
			output: {
				success: false,
				is_streaming: getIsStreaming(),
				error: UI_OUT_OF_DATE,
			} satisfies StreamingStartOutputExtended,
		});
	});
