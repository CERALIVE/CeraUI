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

// Legacy log requests not yet answered, oldest first. The device pushes each
// request's file as a `log` event before it answers that request, in order.
const legacy: Issued[] = [];

/** Sends a legacy log request under `issued`: its pushed file downloads only while that open is live. */
export async function requestLegacyLog(
	issued: Issued,
	send: () => Promise<unknown>,
): Promise<void> {
	const request: Issued = () => issued();
	legacy.push(request);
	try {
		await send();
	} finally {
		// Answered without a file (the device failed to read it): no push will come for it.
		const at = legacy.indexOf(request);
		if (at !== -1) legacy.splice(at, 1);
	}
}

/** The socket's `log` push: the oldest waiting request's file, saved only while its open is live. */
export function deliverLegacyLog(file: {
	name: string;
	contents: string;
}): boolean {
	const issued = legacy.shift();
	if (issued === undefined || !issued()) return false;
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
