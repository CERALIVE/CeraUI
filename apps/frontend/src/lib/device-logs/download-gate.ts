/**
 * The one way System Logs starts a browser download. Every request carries the
 * open it was issued under (`bootSelection.opened()`), and its download starts
 * only if that open is still the live one at the moment the file is ready: a
 * sharing ticket's URL, or a legacy file the device pushes on the socket.
 */
import { getBackendHttpUrl } from "$lib/env";
import { CallTimeoutError } from "$lib/rpc/rpc-timeouts";

/** Whether the open a request was issued under is still the live one. */
export type Issued = () => boolean;

function save(href: string, name: string): void {
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = name;
	document.body.append(anchor);
	try {
		anchor.click();
	} finally {
		anchor.remove();
	}
}

/**
 * Hands a backend download path to the browser, which streams the file to disk
 * (the page never holds its bytes), only while `issued` holds. A browser that
 * refuses the download throws.
 */
export function startBackendDownload(issued: Issued, path: string): boolean {
	if (!issued()) return false;
	save(getBackendHttpUrl(path), "");
	return true;
}

/** How long a timed-out legacy request still holds the slot, so its late file reaches no other request. */
export const LATE_FILE_MS = 60_000;

/**
 * A legacy request's one owner state. `current`: sent, its open live. Abandoned
 * (`current` once `issued()` turns false): its open ended. `failed`: its call
 * timed out, so it is revoked though the device may still send its file. Only a
 * current request with a live open is given its file; a done request is no longer
 * outstanding.
 */
interface LegacyRequest {
	readonly id: string;
	readonly issued: Issued;
	state: "current" | "failed";
	readonly done: PromiseWithResolvers<void>;
}

// The one legacy request outstanding, across both kinds and every open: a device
// that echoes no id leaves a pushed file only one possible owner. A device that
// echoes the id is matched by it as well.
let outstanding: LegacyRequest | undefined;
let sequence = 0;

function finish(request: LegacyRequest): void {
	if (outstanding === request) outstanding = undefined;
	request.done.resolve();
}

/**
 * Sends a legacy log request under `issued` once no other is outstanding (the
 * caller shows it as running meanwhile). `send` passes its id on for the device to
 * echo with the file.
 */
export async function requestLegacyLog(
	issued: Issued,
	send: (request: string) => Promise<unknown>,
): Promise<void> {
	while (outstanding !== undefined) await outstanding.done.promise;
	if (!issued()) return;
	sequence += 1;
	const request: LegacyRequest = {
		id: String(sequence),
		issued,
		state: "current",
		done: Promise.withResolvers<void>(),
	};
	outstanding = request;
	try {
		await send(request.id);
	} catch (error) {
		request.state = "failed";
		// Timed out on a live socket: the file may still come, so the slot stays this
		// request's until the window ends. Any other failure sends no file.
		if (error instanceof CallTimeoutError)
			setTimeout(() => finish(request), LATE_FILE_MS);
		else finish(request);
		throw error;
	}
	// Answered: the device pushes the file before it answers, so none comes now.
	finish(request);
}

/** The socket's `log` push: saved only for the current request it answers, while that request's open is live. */
export function deliverLegacyLog(file: {
	name: string;
	contents: string;
	request?: string;
}): boolean {
	const request = outstanding;
	if (
		request === undefined ||
		(file.request !== undefined && file.request !== request.id)
	)
		return false;
	if (request.state === "failed") {
		// Its late file came: nothing more to wait for, and nothing to save.
		finish(request);
		return false;
	}
	if (!request.issued()) return false;
	const contents = file.contents
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n");
	const url = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
	try {
		save(url, file.name);
	} finally {
		URL.revokeObjectURL(url);
	}
	return true;
}
