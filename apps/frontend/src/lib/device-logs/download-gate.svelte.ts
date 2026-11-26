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

function save(
	href: string,
	name: string,
	remove = (anchor: HTMLAnchorElement) => anchor.remove(),
): void {
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = name;
	document.body.append(anchor);
	try {
		anchor.click();
	} finally {
		remove(anchor);
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

/** The two legacy log downloads, each with its own request slot and lock. */
export type LegacyKind = "device" | "system";

// The file name the device gives the full journal; every other legacy file is a unit's log.
const SYSTEM_LOG_FILE = "ceralive_system_log.txt";

/** How long an answered request still waits for its file before it is reported failed. */
export const FILE_AFTER_REPLY_MS = 10_000;

/**
 * One legacy request, owned until its file outcome is known. The file push ends
 * it at once, whether handed off, failed or dropped, and its reply is then
 * ignored. An error reply before the file fails it. An OK reply only acknowledges
 * the call: the request keeps its slot and waits for its file until
 * `FILE_AFTER_REPLY_MS` has passed, then fails (a device that could not read its
 * journal answers with no file).
 * Only a request whose call has not failed, with a live open, is given its file.
 */
interface LegacyRequest {
	readonly id: string;
	readonly kind: LegacyKind;
	readonly issued: Issued;
	readonly epoch: number;
	file: "awaited" | "consumed";
	reply: "awaited" | "answered" | "timed-out" | "failed";
	// Settles once, when the request ends: the caller's outcome.
	readonly outcome: PromiseWithResolvers<void>;
	// Resolves once, when the request ends: a waiting request of the same kind may go.
	readonly ended: PromiseWithResolvers<void>;
	deadline?: ReturnType<typeof setTimeout>;
}

const slots: Record<LegacyKind, LegacyRequest | undefined> = {
	device: undefined,
	system: undefined,
};
// The socket epoch on which the device echoed a request id: on it, a file is matched by id only.
let taggedOn: number | null = null;
let sequence = 0;
// Bumped on every slot change, so `legacyLocked` is read reactively.
let changes = $state(0);

function tagged(): boolean {
	return taggedOn === socketEpoch();
}

/**
 * Whether the request holds its kind's slot: while its file is awaited and its
 * reply is awaited or was an OK (the file deadline then ends it), or once it timed
 * out on this socket with its file still awaited from a device not known to echo
 * ids. Only that file, or a new socket, can then prove a later file's owner.
 */
function holds(request: LegacyRequest): boolean {
	if (request.file === "consumed") return false;
	if (request.reply === "awaited" || request.reply === "answered") return true;
	return (
		request.reply === "timed-out" &&
		request.epoch === socketEpoch() &&
		!tagged()
	);
}

function release(request: LegacyRequest): void {
	if (slots[request.kind] === request && !holds(request))
		slots[request.kind] = undefined;
	changes += 1;
}

/** Whether a new request of this kind must wait for a reconnect or a timed-out request's late file. */
export function legacyLocked(kind: LegacyKind): boolean {
	void changes;
	const request = slots[kind];
	return (
		request !== undefined && request.reply === "timed-out" && holds(request)
	);
}

/**
 * Sends a legacy log request of `kind` under `issued` once no other of that kind
 * is in flight (the caller shows it as running meanwhile), or not at all while
 * that kind is locked. `send` passes its id on for the device to echo.
 */
export async function requestLegacyLog(
	kind: LegacyKind,
	issued: Issued,
	send: (request: string) => Promise<unknown>,
): Promise<void> {
	for (let held = slots[kind]; held !== undefined; held = slots[kind]) {
		if (!holds(held)) {
			slots[kind] = undefined;
			break;
		}
		if (held.reply === "timed-out") return;
		await held.ended.promise;
	}
	if (!issued()) return;
	sequence += 1;
	const request: LegacyRequest = {
		id: String(sequence),
		kind,
		issued,
		epoch: socketEpoch(),
		file: "awaited",
		reply: "awaited",
		outcome: Promise.withResolvers<void>(),
		ended: Promise.withResolvers<void>(),
	};
	slots[kind] = request;
	changes += 1;
	// The reply settles only this request: the client pairs it with its call by id.
	Promise.resolve(send(request.id)).then(
		() => {
			request.reply = "answered";
			if (request.file !== "awaited") return;
			request.deadline = setTimeout(() => {
				if (request.file !== "awaited") return;
				request.reply = "failed";
				end(request, {
					error: new Error("The device answered but sent no log file"),
				});
			}, FILE_AFTER_REPLY_MS);
		},
		(error: unknown) => {
			request.reply =
				error instanceof CallTimeoutError ? "timed-out" : "failed";
			if (request.file === "awaited") end(request, { error });
		},
	);
	return request.outcome.promise;
}

/** Ends a request once: its caller learns the outcome, its slot frees unless it is the lock. */
function end(request: LegacyRequest, failure?: { error: unknown }): void {
	clearTimeout(request.deadline);
	if (failure) request.outcome.reject(failure.error);
	else request.outcome.resolve();
	request.ended.resolve();
	release(request);
}

/** The request a pushed file answers, or none when its owner cannot be proven. */
function owner(file: {
	name: string;
	request?: string;
}): LegacyRequest | undefined {
	if (file.request !== undefined) {
		if (!tagged()) {
			taggedOn = socketEpoch();
			changes += 1;
		}
		return Object.values(slots).find((request) => request?.id === file.request);
	}
	if (tagged()) return undefined;
	const request = slots[file.name === SYSTEM_LOG_FILE ? "system" : "device"];
	return request?.epoch === socketEpoch() ? request : undefined;
}

function cleanupLegacyDownload(
	resource: "anchor" | "object URL",
	cleanup: () => void,
): void {
	try {
		cleanup();
	} catch (error) {
		console.warn("Failed to clean up legacy log download:", resource, error);
	}
}

/** The socket's `log` push: saved only for the current request it answers, while that request's open is live. */
export function deliverLegacyLog(file: {
	name: string;
	contents: string;
	request?: string;
}): boolean {
	const request = owner(file);
	if (request === undefined || request.file === "consumed") return false;
	request.file = "consumed";
	const owned = request.reply === "awaited" || request.reply === "answered";
	if (!owned) {
		release(request);
		return false;
	}
	if (!request.issued()) {
		end(request);
		return false;
	}
	try {
		const contents = file.contents
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.join("\n");
		const url = URL.createObjectURL(
			new Blob([contents], { type: "text/plain" }),
		);
		// Cleanup must neither undo a successful handoff nor replace a click error.
		try {
			save(url, file.name, (anchor) =>
				cleanupLegacyDownload("anchor", () => anchor.remove()),
			);
		} finally {
			cleanupLegacyDownload("object URL", () => URL.revokeObjectURL(url));
		}
	} catch (error) {
		end(request, { error });
		return false;
	}
	end(request);
	return true;
}
