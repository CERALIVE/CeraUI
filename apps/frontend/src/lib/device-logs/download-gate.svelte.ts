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

/** The two legacy log downloads, each with its own request slot and lock. */
export type LegacyKind = "device" | "system";

// The file name the device gives the full journal; every other legacy file is a unit's log.
const SYSTEM_LOG_FILE = "ceralive_system_log.txt";

/**
 * One legacy request. Its file is `awaited` until a push is matched to it, then
 * `consumed` (saved or dropped) exactly once. Its reply is `awaited` until the
 * call settles. It is current while its reply is awaited and its open is live,
 * and only a current request whose file is awaited is given that file.
 */
interface LegacyRequest {
	readonly id: string;
	readonly kind: LegacyKind;
	readonly issued: Issued;
	readonly epoch: number;
	file: "awaited" | "consumed";
	reply: "awaited" | "answered" | "timed-out" | "failed";
	readonly settled: PromiseWithResolvers<void>;
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
 * Whether the request holds its kind's slot: while its reply is awaited, or once
 * it timed out on this socket with its file still awaited from a device not known
 * to echo ids. Only that file, or a new socket, can then prove a later file's owner.
 */
function holds(request: LegacyRequest): boolean {
	if (request.reply === "awaited") return true;
	return (
		request.reply === "timed-out" &&
		request.file === "awaited" &&
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
	return request !== undefined && request.reply !== "awaited" && holds(request);
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
		if (held.reply !== "awaited") return;
		await held.settled.promise;
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
		settled: Promise.withResolvers<void>(),
	};
	slots[kind] = request;
	changes += 1;
	try {
		await send(request.id);
		request.reply = "answered";
	} catch (error) {
		request.reply = error instanceof CallTimeoutError ? "timed-out" : "failed";
		throw error;
	} finally {
		request.settled.resolve();
		release(request);
	}
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

/** The socket's `log` push: saved only for the current request it answers, while that request's open is live. */
export function deliverLegacyLog(file: {
	name: string;
	contents: string;
	request?: string;
}): boolean {
	const request = owner(file);
	if (request === undefined || request.file === "consumed") return false;
	request.file = "consumed";
	release(request);
	if (request.reply !== "awaited" || !request.issued()) return false;
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
