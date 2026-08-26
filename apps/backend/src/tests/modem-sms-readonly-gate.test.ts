/*
 * The SMS inbox is READ-ONLY, and this is the lock.
 *
 * A comment saying "do not add a send path" is not a control — the next person
 * to touch this surface will not read it. This test greps the ACTUAL modem
 * source for every mmcli verb and identifier that would turn the inbox into a
 * write surface, and fails the build if one appears. Sending or deleting an SMS
 * is billable, irreversible, and adds real modem-control capability to what is
 * otherwise a diagnostic read; it is out of scope permanently, not until later.
 *
 * Deleting or weakening this test to land a send path is exactly the move it
 * exists to stop. If the product genuinely decides to ship SMS writes, that is a
 * new spec change with its own confirmation/interlock design — and this file is
 * the place that decision has to be argued.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MethodCall } from "@ceralive/modem-control/transport";

import {
	isAllowedMethodCall,
	LIVE_OBSERVATION_MEMBERS,
	LIVE_OBSERVATION_SIGNALS,
	NAMED_MUTATING_MEMBERS,
	SMS_OBSERVATION_METHOD_MEMBERS,
	SMS_OBSERVATION_SIGNAL_MEMBERS,
	STRICT_SHADOW_MEMBERS,
} from "../modules/cellular/dbus-audit-transport.ts";

const BACKEND_SRC = join(import.meta.dir, "..");
const REPO_ROOT = join(BACKEND_SRC, "..", "..", "..");

/** Every file that is allowed to mention mmcli's messaging flags at all. */
const MODEM_SURFACE_ROOTS = [
	join(BACKEND_SRC, "modules", "modems"),
	join(BACKEND_SRC, "modules", "cellular"),
	join(BACKEND_SRC, "mocks", "providers", "modems.ts"),
	join(BACKEND_SRC, "rpc", "procedures", "modems.procedure.ts"),
	join(REPO_ROOT, "packages", "rpc", "src", "schemas", "modems.schema.ts"),
	join(REPO_ROOT, "packages", "rpc", "src", "contracts", "modems.contract.ts"),
];

/** This gate names the forbidden verbs, so it must not scan itself. */
const SELF = "modem-sms-readonly-gate.test.ts";

/**
 * mmcli's SMS WRITE verbs (1.24 grammar) plus the identifiers a hand-rolled
 * write path would use. `--send` is listed on its own because mmcli spells the
 * send as `-s <path> --send`, with no `sms` token anywhere in the flag.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
	{ label: "mmcli --messaging-create-sms", re: /--messaging-create-sms/ },
	{ label: "mmcli --messaging-delete-sms", re: /--messaging-delete-sms/ },
	{ label: "mmcli --create-sms", re: /--create-sms/ },
	{ label: "mmcli --delete-sms", re: /--delete-sms/ },
	{ label: "mmcli --send (SMS send verb)", re: /["'`]--send["'`]/ },
	{ label: "mmcli --store (SMS store verb)", re: /["'`]--store["'`]/ },
	{ label: "a sendSms identifier", re: /\bsendSms\b/i },
	{ label: "a deleteSms identifier", re: /\bdeleteSms\b/i },
	{ label: "a createSms identifier", re: /\bcreateSms\b/i },
	{ label: "an smsSend identifier", re: /\bsmsSend\b/i },
	{ label: "an smsDelete identifier", re: /\bsmsDelete\b/i },
	{ label: "an smsStore identifier", re: /\bsmsStore\b/i },
	{ label: "a storeSms identifier", re: /\bstoreSms\b/i },
	// The port half of the same contract: `@ceralive/modem-control` reaches
	// ModemManager over D-Bus, where the write surface is the Messaging
	// `Create`/`Delete` methods and the Sms object's `Send`/`Store`. A migration
	// that moved the transport onto the port would otherwise carry those verbs
	// past a gate that only knew how to spell them as mmcli flags.
	{
		label: "a D-Bus SMS write member",
		re: /member:\s*["'`](?:Create|Delete|Send|Store)["'`]/,
	},
];

const isScannable = (name: string): boolean =>
	name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== SELF;

function collectSources(target: string): string[] {
	const stat = statSync(target);
	if (!stat.isDirectory()) {
		return isScannable(target) ? [target] : [];
	}
	const found: string[] = [];
	for (const entry of readdirSync(target, { withFileTypes: true })) {
		const child = join(target, entry.name);
		if (entry.isDirectory()) {
			found.push(...collectSources(child));
		} else if (isScannable(entry.name)) {
			found.push(child);
		}
	}
	return found;
}

/**
 * Scan CODE, not prose. Both the contract and the procedure documentation state
 * the read-only invariant by naming the very identifiers this gate forbids, and
 * a gate that cannot tell "we will never add `sendSms`" from an actual
 * `sendSms` is a gate nobody can document around. Full-line and block comments
 * are removed; a trailing `//` on a code line is left alone so a URL inside a
 * string literal cannot swallow the rest of that line.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
		.join("\n");
}

const SOURCES = MODEM_SURFACE_ROOTS.flatMap(collectSources);
const CODE = new Map(
	SOURCES.map((path) => [path, stripComments(readFileSync(path, "utf8"))]),
);

describe("the modem SMS surface is read-only, and stays that way", () => {
	it("scans a non-trivial set of modem source files", () => {
		// Guards the gate itself: a moved directory would otherwise make this
		// suite pass vacuously by scanning nothing.
		// Scanned 85 files before adding this count floor.
		expect(SOURCES.length).toBeGreaterThanOrEqual(85);
		expect(
			SOURCES.some((path) => path.endsWith("mmcli-sms.ts")),
			"the SMS module itself must be in scan scope",
		).toBe(true);
		expect(
			SOURCES.some((path) => path.endsWith("modems.procedure.ts")),
			"the modem procedures must be in scan scope",
		).toBe(true);
		expect(
			SOURCES.some((path) => path.endsWith("sms-port.ts")),
			"the modem-control port seam must be in scan scope",
		).toBe(true);
	});

	it("the port seam exposes normalization only — no transport verb", () => {
		// The seam is what a future migration onto `@ceralive/modem-control`
		// flows through, so the gate has to cover the SHAPE it resolves, not
		// only the identifiers around it: a normalizer that grew a send/delete
		// member would be a write path reachable through a purely additive
		// package bump.
		const seam = CODE.get(
			SOURCES.find((path) => path.endsWith("sms-port.ts")) ?? "",
		);
		expect(seam).toBeDefined();
		const members = [...(seam ?? "").matchAll(/^\t(\w+)[(:?]/gm)].map(
			(match) => match[1],
		);
		expect(members.length).toBeGreaterThan(0);
		for (const member of members) {
			expect(
				/^(?:create|send|store|delete|write)/i.test(member ?? ""),
				`the seam must not declare a mutating member: ${member}`,
			).toBe(false);
		}
	});

	for (const { label, re } of FORBIDDEN_PATTERNS) {
		it(`has no ${label} anywhere on the modem surface`, () => {
			const offenders = [...CODE.entries()]
				.filter(([, source]) => re.test(source))
				.map(([path]) => path.slice(REPO_ROOT.length + 1));

			expect(offenders).toEqual([]);
		});
	}

	it("uses exactly one messaging verb, and it is the list read", () => {
		const messagingFlags = new Set<string>();
		for (const source of CODE.values()) {
			for (const match of source.matchAll(/--messaging-[a-z-]+/g)) {
				messagingFlags.add(match[0]);
			}
		}
		expect([...messagingFlags]).toEqual(["--messaging-list-sms"]);
	});

	it("admits exactly the package D-Bus SMS methods and signals", () => {
		expect([...SMS_OBSERVATION_METHOD_MEMBERS]).toEqual([
			"org.freedesktop.ModemManager1.Modem.Messaging.List",
			"org.freedesktop.DBus.Properties.GetAll",
		]);
		expect([...SMS_OBSERVATION_SIGNAL_MEMBERS]).toEqual([
			"org.freedesktop.ModemManager1.Modem.Messaging.Added",
			"org.freedesktop.ModemManager1.Modem.Messaging.Deleted",
		]);
		for (const signal of SMS_OBSERVATION_SIGNAL_MEMBERS) {
			expect(LIVE_OBSERVATION_SIGNALS.has(signal)).toBe(true);
		}
	});

	it("scopes Properties.GetAll to SMS objects and the exact Sms interface", () => {
		const call: MethodCall = {
			destination: "org.freedesktop.ModemManager1",
			path: "/org/freedesktop/ModemManager1/SMS/7",
			interface: "org.freedesktop.DBus.Properties",
			member: "GetAll",
			signature: "s",
			args: ["org.freedesktop.ModemManager1.Sms"],
		};
		expect(isAllowedMethodCall(call, LIVE_OBSERVATION_MEMBERS)).toBe(true);
		expect(
			isAllowedMethodCall(
				{ ...call, path: "/org/freedesktop/ModemManager1/Modem/7" },
				LIVE_OBSERVATION_MEMBERS,
			),
		).toBe(false);
		expect(
			isAllowedMethodCall(
				{ ...call, args: ["org.freedesktop.ModemManager1.Modem"] },
				LIVE_OBSERVATION_MEMBERS,
			),
		).toBe(false);
	});

	it("refuses every D-Bus SMS write member under both policies", () => {
		const writes = [
			"org.freedesktop.ModemManager1.Modem.Messaging.Create",
			"org.freedesktop.ModemManager1.Modem.Messaging.Delete",
			"org.freedesktop.ModemManager1.Sms.Send",
			"org.freedesktop.ModemManager1.Sms.Store",
		];
		for (const member of writes) {
			expect(NAMED_MUTATING_MEMBERS).toContain(member);
			expect(STRICT_SHADOW_MEMBERS.has(member)).toBe(false);
			expect(LIVE_OBSERVATION_MEMBERS.has(member)).toBe(false);
		}
	});

	it("admits no Ussd member under either D-Bus policy", () => {
		for (const member of [
			"org.freedesktop.ModemManager1.Modem.Modem3gpp.Ussd.Initiate",
			"org.freedesktop.ModemManager1.Modem.Modem3gpp.Ussd.Respond",
			"org.freedesktop.ModemManager1.Modem.Modem3gpp.Ussd.Cancel",
		]) {
			expect(STRICT_SHADOW_MEMBERS.has(member)).toBe(false);
			expect(LIVE_OBSERVATION_MEMBERS.has(member)).toBe(false);
		}
	});

	it("exposes no mutating SMS procedure on the modems router", () => {
		const router = readFileSync(join(BACKEND_SRC, "rpc", "router.ts"), "utf8");
		const modemsBlock = router.slice(
			router.indexOf("modems: base.router({"),
			router.indexOf("wifi: base.router({"),
		);
		expect(modemsBlock).toContain("getSms:");
		for (const forbidden of ["sendSms", "deleteSms", "createSms", "setSms"]) {
			expect(modemsBlock).not.toContain(forbidden);
		}
	});
});
