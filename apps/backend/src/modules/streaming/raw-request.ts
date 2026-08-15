/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * The published `@ceralive/cerastream` client exposes `rawRequest` at runtime
 * but omits it from the exported `CerastreamClient` interface, so every caller
 * that needs the escape hatch — an additive engine method, or a field the
 * binding's Zod schemas strip — used to launder the client through a cast.
 *
 * A cast asserts the method exists; this narrows on the runtime evidence
 * instead, so a binding that ever drops `rawRequest` fails with a named,
 * catchable error at the call site rather than a bare "not a function".
 */

/** The raw JSON-RPC primitive the binding ships but does not declare. */
export interface RawRequestClient {
	rawRequest(method: string, params?: unknown): Promise<unknown>;
}

/** Thrown when the connected binding exposes no raw JSON-RPC primitive. */
export class RawRequestUnsupportedError extends Error {
	constructor(readonly site: string) {
		super(
			`cerastream: the connected client exposes no rawRequest primitive (needed by ${site})`,
		);
		this.name = "RawRequestUnsupportedError";
	}
}

export function isRawRequestClient(
	client: unknown,
): client is RawRequestClient {
	return (
		typeof client === "object" &&
		client !== null &&
		typeof (client as { rawRequest?: unknown }).rawRequest === "function"
	);
}

/**
 * Narrow a client to its raw JSON-RPC primitive, or throw
 * {@link RawRequestUnsupportedError} naming the caller that needed it.
 */
export function asRawRequestClient(
	client: unknown,
	site: string,
): RawRequestClient {
	if (!isRawRequestClient(client)) throw new RawRequestUnsupportedError(site);
	return client;
}
