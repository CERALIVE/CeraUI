/**
 * The one way System Logs starts a browser download. Every request carries the
 * open it was issued under (`bootSelection.opened()`), and its download starts
 * only if that open is still the live one at the moment the file is ready: a
 * sharing ticket's URL, or a legacy file the device pushes on the socket.
 */
import { getBackendHttpUrl } from "$lib/env";
import { CallTimeoutError } from "$lib/rpc/rpc-timeouts";
import { socketEpoch } from "$lib/rpc/socket-epoch.svelte";

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

/**
 * A legacy request's one owner state. `current`: sent, its open live. Abandoned
 * (`current` once `issued()` turns false): its open ended. `failed`: its call
 * failed, so it is revoked even if the device still answers. Only a current
 * request with a live open is given its file.
 */
interface LegacyRequest {
	readonly id: string;
	readonly issued: Issued;
	readonly epoch: number;
	failed: boolean;
	answered: boolean;
	readonly done: PromiseWithResolvers<void>;
}

// The one legacy request in flight, across both kinds and every open, so a file
// from a device that echoes no id has one possible owner.
let outstanding: LegacyRequest | undefined;
// A timed-out request such a device may still answer on this socket: until that
// file arrives or the socket is replaced, no other request may be sent.
let held = $state.raw<LegacyRequest | null>(null);
// The socket epoch on which the device echoed a request id: its files carry their owner.
let taggedOn: number | null = null;
let sequence = 0;

function finish(request: LegacyRequest): void {
	if (outstanding === request) outstanding = undefined;
	request.done.resolve();
}

/** Whether a new legacy request must wait for a reconnect or an earlier request's late file. */
export function legacyLocked(): boolean {
	return held !== null && held.epoch === socketEpoch();
}

/**
 * Sends a legacy log request under `issued` once no other is in flight (the
 * caller shows it as running meanwhile), or not at all while locked. `send`
 * passes its id on for the device to echo with the file.
 */
export async function requestLegacyLog(
	issued: Issued,
	send: (request: string) => Promise<unknown>,
): Promise<void> {
	while (outstanding !== undefined) await outstanding.done.promise;
	if (!issued() || legacyLocked()) return;
	sequence += 1;
	const request: LegacyRequest = {
		id: String(sequence),
		issued,
		epoch: socketEpoch(),
		failed: false,
		answered: false,
		done: Promise.withResolvers<void>(),
	};
	outstanding = request;
	try {
		await send(request.id);
	} catch (error) {
		request.failed = true;
		// Timed out on a live socket: the device may still send the file, and only its
		// id, or this socket closing, can prove which request a file answers.
		if (
			error instanceof CallTimeoutError &&
			taggedOn !== request.epoch &&
			request.epoch === socketEpoch()
		)
			held = request;
		throw error;
	} finally {
		// Answered or failed: the device pushes a file before it answers, so none comes for it now.
		finish(request);
	}
}

/** The request a pushed file answers, or none when its owner cannot be proven. */
function owner(file: { request?: string }): LegacyRequest | undefined {
	if (file.request !== undefined) {
		taggedOn = socketEpoch();
		if (held?.id === file.request) return held;
		return outstanding?.id === file.request ? outstanding : undefined;
	}
	if (legacyLocked()) return held ?? undefined;
	return outstanding?.epoch === socketEpoch() ? outstanding : undefined;
}

/** The socket's `log` push: saved only for the current request it answers, while that request's open is live. */
export function deliverLegacyLog(file: {
	name: string;
	contents: string;
	request?: string;
}): boolean {
	const request = owner(file);
	if (request === undefined || request.answered) return false;
	request.answered = true;
	if (held === request) held = null;
	if (request.failed || !request.issued()) return false;
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
