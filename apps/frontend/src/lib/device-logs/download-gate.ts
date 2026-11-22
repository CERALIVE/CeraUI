/**
 * The one way System Logs starts a browser download. Every request carries the
 * open it was issued under (`bootSelection.opened()`), and its download starts
 * only if that open is still the live one at the moment the file is ready: a
 * sharing ticket's URL, or a legacy file the device pushes on the socket.
 */
import { getBackendHttpUrl } from "$lib/env";

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

/** How long a request the device never answered (a timeout, a dropped socket) still claims its late file. */
export const LATE_FILE_MS = 60_000;

interface LegacyRequest {
	readonly id: string;
	readonly issued: Issued;
}

// Sent and not yet given their file. The device reads the journals concurrently,
// so a file is tied to its request by the id it echoes, never by order.
const outstanding = new Map<string, LegacyRequest>();
let sequence = 0;

/** Sends a legacy log request under `issued`; `send` passes its id on for the device to echo with the file. */
export async function requestLegacyLog(
	issued: Issued,
	send: (request: string) => Promise<unknown>,
): Promise<void> {
	sequence += 1;
	const request: LegacyRequest = { id: String(sequence), issued };
	outstanding.set(request.id, request);
	try {
		await send(request.id);
	} catch (error) {
		// Unanswered: its file may still come, and must not reach another request.
		setTimeout(() => outstanding.delete(request.id), LATE_FILE_MS);
		throw error;
	}
	// Answered: the device pushes the file before it answers, so none comes now.
	outstanding.delete(request.id);
}

/** The request a pushed file answers: by its echoed id, or the only one outstanding from a device that sends none. */
function answered(file: { request?: string }): LegacyRequest | undefined {
	if (file.request !== undefined) return outstanding.get(file.request);
	const [only, other] = outstanding.values();
	return other === undefined ? only : undefined;
}

/** The socket's `log` push: saved only for the request it answers, and only while that request's open is live. */
export function deliverLegacyLog(file: {
	name: string;
	contents: string;
	request?: string;
}): boolean {
	const request = answered(file);
	if (request === undefined) return false;
	outstanding.delete(request.id);
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
