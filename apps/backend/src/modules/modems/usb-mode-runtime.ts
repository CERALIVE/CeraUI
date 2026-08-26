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

/**
 * WHETHER A DEVICE CAN BE ASKED WHAT COMPOSITIONS IT HAS, AND WHETHER ITS ANSWER
 * PROVES A ROUTE BACK.
 *
 * This is CeraUI's consumption of modem-stack's runtime-composition model
 * (`control/src/usb-mode/runtime-capability.ts`, todo 9). Every function here is
 * asked for through {@link modemControlFunction} first and answers with the local
 * implementation only when the pinned package does not export it — the fourteen
 * frozen projection modules' seam, applied to a fifteenth. `@ceralive/modem-control@1.3.0`
 * exports `resolveRuntimeCompositionCapability`, so the package owns today's
 * read-side resolution while the local half remains its executable parity oracle
 * and fallback. The package's SET registry is intentionally not consumed here;
 * adding a write path is a separate reviewed feature, not a compatibility bump.
 *
 * WHY A LOCAL HALF EXISTS AT ALL, given the package owns the model. The seam's
 * whole point is that adopting a packaged function is a no-op for the shipped
 * consumer, so the consumer has to be able to run before the package release
 * lands. The alternative — a static import — makes this build fail rather than
 * degrade, and there is nothing to degrade TO: without the model every real
 * device is answered `uncertified`, which is the claim being retired.
 *
 * THE VENDOR IS RESOLVED FROM WHAT THE DEVICE PUBLISHES, NEVER FROM A MODEL LIST.
 * `resolveRuntimeVendor` matches the USB vendor id and the model string against
 * the four vendor FAMILIES the query registry knows how to address. That is not a
 * model allowlist re-entering by the back door: it answers "do we know the AT
 * dialect this silicon speaks", and every mode on offer afterwards comes from the
 * device's own reply rather than from anything written here. A vendor this build
 * has no reviewed READ form for is `unknown-vendor` — honest, and no control.
 */

import { constants as fsConstants, open } from "node:fs/promises";
import type {
	UsbModeRuntimeEvidence,
	UsbModeRuntimeSuppression,
} from "@ceraui/rpc/schemas";

import { modemControlFunction } from "../modem-control-compat.ts";

/** The vendor families with a reviewed READ/TEST form. Mirrors todo 9's registry. */
export const RUNTIME_COMPOSITION_VENDORS = [
	"fibocom",
	"quectel",
	"simcom",
	"sierra",
] as const;
export type RuntimeCompositionVendor =
	(typeof RUNTIME_COMPOSITION_VENDORS)[number];

export type RuntimeCompositionMode = number | string;

export interface RuntimeCompositionQuery {
	readonly current: string;
	readonly enumerate: string;
}

/**
 * The ONLY AT forms this path may send. Both are READ (`?`) or TEST (`=?`) forms;
 * no SET form appears anywhere in this module, which is what makes "a capability
 * read never writes" checkable rather than promised.
 */
export const RUNTIME_COMPOSITION_QUERY_REGISTRY: Readonly<
	Record<RuntimeCompositionVendor, RuntimeCompositionQuery>
> = Object.freeze({
	fibocom: Object.freeze({
		current: "AT+GTUSBMODE?",
		enumerate: "AT+GTUSBMODE=?",
	}),
	quectel: Object.freeze({
		current: 'AT+QCFG="usbnet"',
		enumerate: "AT+QCFG=?",
	}),
	simcom: Object.freeze({
		current: "AT+CUSBPIDSWITCH?",
		enumerate: "AT+CUSBPIDSWITCH=?",
	}),
	sierra: Object.freeze({
		current: "AT!USBCOMP?",
		enumerate: "AT!USBCOMP=?",
	}),
});

export type RuntimeCompositionCapability =
	| {
			readonly status: "available";
			readonly current: RuntimeCompositionMode;
			readonly enumerated: readonly RuntimeCompositionMode[];
			readonly returnPathProven: boolean;
			readonly offerable: readonly RuntimeCompositionMode[];
	  }
	| {
			readonly status: "unknown";
			readonly current: null;
			readonly enumerated: readonly [];
			readonly returnPathProven: false;
			readonly offerable: readonly [];
			readonly reason: "vendor-unsupported" | "malformed-response";
	  };

export interface RuntimeCompositionResponse {
	readonly vendor: string;
	readonly currentResponse: string;
	readonly enumerationResponse: string;
}

interface ParsedCapability {
	readonly current: RuntimeCompositionMode;
	readonly enumerated: readonly RuntimeCompositionMode[];
}

const UNKNOWN_VENDOR = Object.freeze({
	status: "unknown",
	current: null,
	enumerated: [],
	returnPathProven: false,
	offerable: [],
	reason: "vendor-unsupported",
} as const);

const MALFORMED_RESPONSE = Object.freeze({
	status: "unknown",
	current: null,
	enumerated: [],
	returnPathProven: false,
	offerable: [],
	reason: "malformed-response",
} as const);

function parseDecimalDomain(domain: string): readonly number[] | undefined {
	const values: number[] = [];
	for (const member of domain.split(",")) {
		const token = member.trim();
		const range = /^(\d+)-(\d+)$/.exec(token);
		if (range !== null) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start > end ||
				end - start > 255
			) {
				return undefined;
			}
			for (let value = start; value <= end; value += 1) values.push(value);
			continue;
		}
		if (!/^\d+$/.test(token)) return undefined;
		const value = Number(token);
		if (!Number.isSafeInteger(value)) return undefined;
		values.push(value);
	}
	return values.length > 0 && new Set(values).size === values.length
		? values
		: undefined;
}

function parseFibocom(
	input: RuntimeCompositionResponse,
): ParsedCapability | undefined {
	const current = /^\s*\+GTUSBMODE:\s*(\d+)\s*$/m.exec(input.currentResponse);
	const enumeration = /^\s*\+GTUSBMODE:\s*\(([^)]+)\)\s*$/m.exec(
		input.enumerationResponse,
	);
	if (current === null || enumeration === null) return undefined;
	const enumerated = parseDecimalDomain(enumeration[1] ?? "");
	return enumerated === undefined
		? undefined
		: { current: Number(current[1]), enumerated };
}

function parseQuectel(
	input: RuntimeCompositionResponse,
): ParsedCapability | undefined {
	const current = /^\s*\+QCFG:\s*"usbnet"\s*,\s*(\d+)\s*$/m.exec(
		input.currentResponse,
	);
	const enumeration = /^\s*\+QCFG:\s*"usbnet"\s*,\s*\(([^)]+)\)\s*$/m.exec(
		input.enumerationResponse,
	);
	if (current === null || enumeration === null) return undefined;
	const enumerated = parseDecimalDomain(enumeration[1] ?? "");
	return enumerated === undefined
		? undefined
		: { current: Number(current[1]), enumerated };
}

function parseSimcom(
	input: RuntimeCompositionResponse,
): ParsedCapability | undefined {
	const current = /^\s*\+CUSBPIDSWITCH:\s*([0-9A-Fa-f]{4})\s*$/m.exec(
		input.currentResponse,
	);
	const enumeration =
		/\+CUSBPIDSWITCH:\s*\(([^)]+)\)\s*,\s*\(0-1\)\s*,\s*\(0-1\)/m.exec(
			input.enumerationResponse,
		);
	if (current === null || enumeration === null) return undefined;
	const tokens = (enumeration[1] ?? "")
		.split(",")
		.map((token) => token.trim().toUpperCase());
	if (
		tokens.length === 0 ||
		tokens.some((token) => !/^[0-9A-F]{4}$/.test(token))
	) {
		return undefined;
	}
	if (new Set(tokens).size !== tokens.length) return undefined;
	return { current: (current[1] ?? "").toUpperCase(), enumerated: tokens };
}

function parseSierra(
	input: RuntimeCompositionResponse,
): ParsedCapability | undefined {
	const current = /^\s*!USBCOMP:\s*(\d+)(?:\s*,.*)?$/m.exec(
		input.currentResponse,
	);
	if (current === null) return undefined;
	const enumerated = Array.from(
		input.enumerationResponse.matchAll(/^\s*(\d+)\s*:\s*.+$/gm),
		(match) => Number(match[1]),
	);
	if (
		enumerated.length === 0 ||
		new Set(enumerated).size !== enumerated.length
	) {
		return undefined;
	}
	return { current: Number(current[1]), enumerated };
}

const PARSERS: Readonly<
	Record<
		RuntimeCompositionVendor,
		(input: RuntimeCompositionResponse) => ParsedCapability | undefined
	>
> = {
	fibocom: parseFibocom,
	quectel: parseQuectel,
	simcom: parseSimcom,
	sierra: parseSierra,
};

export function isRuntimeCompositionVendor(
	vendor: string,
): vendor is RuntimeCompositionVendor {
	return Object.hasOwn(RUNTIME_COMPOSITION_QUERY_REGISTRY, vendor);
}

export function resolveRuntimeCompositionCapabilityLocal(
	input: RuntimeCompositionResponse,
): RuntimeCompositionCapability {
	const vendor = input.vendor.trim().toLowerCase();
	if (!isRuntimeCompositionVendor(vendor)) return UNKNOWN_VENDOR;
	const parsed = PARSERS[vendor](input);
	if (parsed === undefined) return MALFORMED_RESPONSE;
	// The return path is the device's OWN claim that the mode it is in right now
	// is a member of the vocabulary it enumerates. Without it a switch is a
	// one-way door: the operator would have no advertised way back, and the whole
	// list is withheld rather than the current mode being assumed reachable.
	const returnPathProven = parsed.enumerated.includes(parsed.current);
	return {
		status: "available",
		current: parsed.current,
		enumerated: parsed.enumerated,
		returnPathProven,
		offerable: returnPathProven ? parsed.enumerated : [],
	};
}

export const resolveRuntimeCompositionCapability = modemControlFunction<
	(input: RuntimeCompositionResponse) => RuntimeCompositionCapability
>(
	"resolveRuntimeCompositionCapability",
	resolveRuntimeCompositionCapabilityLocal,
);

/** USB vendor ids of the four families, lowercase, as `vidPidOf` emits them. */
const VENDOR_IDS: Readonly<Record<string, RuntimeCompositionVendor>> =
	Object.freeze({
		"0e8d": "fibocom",
		"2cb7": "fibocom",
		"2c7c": "quectel",
		"1e0e": "simcom",
		"1199": "sierra",
		"03f0": "sierra",
		"413c": "sierra",
	});

/**
 * Which AT dialect this device speaks, or `undefined` when this build has none.
 *
 * The USB vendor id is asked FIRST because it is assigned by USB-IF and is the
 * one identifier a firmware update cannot restyle; the model string is a fallback
 * for the OEM rebrands that ship under a distributor's vendor id (Sierra silicon
 * alone registers under three). Neither is a claim about which compositions the
 * device has — only about which question it can be asked.
 */
export function resolveRuntimeVendor(identity: {
	readonly vidPid: string;
	readonly model: string;
}): RuntimeCompositionVendor | undefined {
	const vendorId = identity.vidPid.split(":")[0]?.trim().toLowerCase() ?? "";
	const byId = VENDOR_IDS[vendorId];
	if (byId !== undefined) return byId;

	const model = identity.model.trim().toLowerCase();
	if (model === "") return undefined;
	return RUNTIME_COMPOSITION_VENDORS.find((vendor) => model.includes(vendor));
}

/**
 * The capability read is bounded FAR shorter than the transaction's own AT
 * deadline (10 s) because it runs on every dialog open, not once per mutation.
 * A device that has not answered in two seconds is a device that could not be
 * asked, which is a rendered state; making the operator wait ten seconds per
 * command to reach the same state is not.
 */
const RUNTIME_AT_TIMEOUT_MS = 2_000;
const RUNTIME_AT_POLL_MS = 100;

/** `modem.generic.ports` entries look like `ttyUSB2 (at)`; only the AT one is ours. */
export function resolveAtPortPath(
	ports: readonly string[],
): string | undefined {
	for (const port of ports) {
		const match = /^(\S+)\s*\(at\)$/.exec(port.trim());
		const name = match?.[1];
		if (name !== undefined && name !== "") return `/dev/${name}`;
	}
	return undefined;
}

/**
 * Send ONE allowlisted READ/TEST form and return its raw reply.
 *
 * O_NONBLOCK is what makes this safe to issue against a port ModemManager may
 * still be holding: the failure being guarded against is precisely an open that
 * never returns, so a blocking open would wedge the dialog rather than report the
 * condition. It answers `undefined` on every failure — an unreachable port is a
 * suppression to render, never an exception to propagate into a read.
 */
async function sendRuntimeQuery(
	portPath: string,
	command: string,
): Promise<string | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(
			portPath,
			fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK,
		);
		await handle.write(`${command}\r`);
		const deadline = Date.now() + RUNTIME_AT_TIMEOUT_MS;
		let raw = "";
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, RUNTIME_AT_POLL_MS));
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			raw += buffer.subarray(0, bytesRead).toString("utf8");
			if (/\r?\nOK\r?\n?$/.test(raw) || raw.trimEnd().endsWith("OK"))
				return raw;
			if (/ERROR/.test(raw)) return undefined;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * The production capability read: the vendor's own READ form, then its TEST form.
 *
 * ONLY {@link RUNTIME_COMPOSITION_QUERY_REGISTRY} members are ever sent. No SET
 * form is reachable from this module at all, so "a capability read never writes"
 * is a property of what is importable here rather than of what a caller does.
 */
export async function defaultRuntimeCompositionQuery(
	identity: { readonly ports: readonly string[] },
	vendor: RuntimeCompositionVendor,
): Promise<RuntimeCompositionResponse | undefined> {
	const portPath = resolveAtPortPath(identity.ports);
	if (portPath === undefined) return undefined;

	const query = RUNTIME_COMPOSITION_QUERY_REGISTRY[vendor];
	const currentResponse = await sendRuntimeQuery(portPath, query.current);
	if (currentResponse === undefined) return undefined;
	const enumerationResponse = await sendRuntimeQuery(portPath, query.enumerate);
	if (enumerationResponse === undefined) return undefined;

	return { vendor, currentResponse, enumerationResponse };
}

/**
 * The offer this device's own answer supports, in the runtime vocabulary.
 *
 * A `malformed-response` is reported as `unknown-vendor` deliberately: both mean
 * "this build could not establish what the device has", and inventing a fifth
 * token for an unparseable reply would give the operator a distinction they can
 * do nothing with. What must NOT happen is either one becoming `no-return-path`,
 * which asserts the device answered and its answer excluded its own mode.
 */
export function foldRuntimeCapability(
	vendor: RuntimeCompositionVendor,
	capability: RuntimeCompositionCapability,
):
	| { readonly ok: true; readonly evidence: UsbModeRuntimeEvidence }
	| { readonly ok: false; readonly suppressed: UsbModeRuntimeSuppression } {
	if (capability.status !== "available") {
		return { ok: false, suppressed: "unknown-vendor" };
	}
	if (!capability.returnPathProven) {
		return { ok: false, suppressed: "no-return-path" };
	}
	return {
		ok: true,
		evidence: {
			vendor,
			current: capability.current,
			enumerated: [...capability.enumerated],
			return_path_proven: true,
		},
	};
}
