/*
 * Gated USSD module — redaction proof.
 *
 * A USSD exchange is a credential class in BOTH directions. The reply carries a
 * balance, a subscriber number, or a one-time code; the COMMAND carries a prepaid
 * voucher code, because `*123*<digits>#` is how a subscriber tops up a line.
 * Neither may reach ANY transport, so this drives the REAL logger (via its
 * capture ring, which sits downstream of `redact()`) rather than asserting on a
 * mock — and it drives the REAL module, so a future call site that logs an mmcli
 * answer verbatim turns this suite red.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	clearRecentLogLines,
	getRecentLogLines,
	isUssdSensitiveKey,
	logger,
	logRedact,
	REDACTED,
} from "../helpers/logger.ts";
import { getConfig } from "../modules/config.ts";
import { setModemCapabilityEvidenceReader } from "../modules/modems/capability-gates.ts";
import type { UssdCliRunner } from "../modules/modems/mmcli-ussd.ts";
import {
	initiateModemUssd,
	resetModemUssdState,
	respondModemUssd,
} from "../modules/modems/ussd.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const DEVICE = "0";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.4";

const REPLY = "Saldo $4.20. Tu codigo es 9113";
const VOUCHER = "*123*1234567890123456#";
const MENU_ANSWER = "Andres Cerdas";

const LEAKY_STATUS = [
	"modem.3gpp.ussd.status              : user-response",
	`modem.3gpp.ussd.network-request     : ${REPLY}`,
	`modem.3gpp.ussd.network-notification: ${REPLY}`,
].join("\n");

const SECRETS = [REPLY, VOUCHER, MENU_ANSWER, "9113", "1234567890123456"];

function expectNoUssdContent(haystack: string, where: string): void {
	for (const secret of SECRETS) {
		if (haystack.includes(secret)) {
			throw new Error(`${where} leaked USSD content: ${secret}`);
		}
	}
}

describe("isUssdSensitiveKey — anchored, not substring", () => {
	it("matches the keys that genuinely name USSD carrier text", () => {
		for (const key of [
			"ussd",
			"ussdCommand",
			"ussd_command",
			"ussd-reply",
			"ussdReply",
			"ussdResponse",
			"ussdText",
			"networkNotification",
			"network-request",
			"modem.3gpp.ussd.network-notification",
			"modem.3gpp.ussd.network-request",
		]) {
			expect(isUssdSensitiveKey(key)).toBe(true);
		}
	});

	it("does NOT over-redact the ordinary keys a substring rule would eat", () => {
		// This is exactly why USSD keys are their own whole-key set: the substring
		// regex would scrub every RPC `response`, every CLI `command`, and the
		// module's own non-secret state fields.
		for (const key of [
			"reply",
			"command",
			"response",
			"ussdCapable",
			"ussdSessionState",
			"session",
			"state",
			"outcome",
			"refusal",
			"network",
		]) {
			expect(isUssdSensitiveKey(key)).toBe(false);
		}
	});
});

describe("logRedact — USSD carrier text never survives", () => {
	it("scrubs the reply AND the command, and keeps the non-secret siblings", () => {
		const redacted = logRedact({
			modem: "0",
			session: { state: "awaiting-reply", outcome: undefined },
			ussdReply: REPLY,
			ussdCommand: VOUCHER,
			nested: { ussdResponse: MENU_ANSWER },
		}) as Record<string, unknown>;

		expect(redacted.ussdReply).toBe(REDACTED);
		expect(redacted.ussdCommand).toBe(REDACTED);
		expect(redacted.modem).toBe("0");
		expect((redacted.session as Record<string, unknown>).state).toBe(
			"awaiting-reply",
		);
		expectNoUssdContent(JSON.stringify(redacted), "logRedact");
	});

	it("scrubs a raw mmcli USSD record that arrives as a bare string value", () => {
		const redacted = logRedact({ output: LEAKY_STATUS }) as Record<
			string,
			unknown
		>;
		expect(redacted.output).toBe(REDACTED);
		expectNoUssdContent(JSON.stringify(redacted), "logRedact value-shape");
	});
});

describe("the REAL logger emits no USSD content", () => {
	beforeEach(() => {
		clearRecentLogLines();
	});

	it("scrubs a raw USSD record logged as a free-text message", () => {
		logger.warn(LEAKY_STATUS);
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain(REDACTED);
		expectNoUssdContent(emitted, "logger message");
	});

	it("scrubs USSD metadata attached to an ordinary log line", () => {
		logger.info("USSD dialogue advanced", {
			modem: "0",
			ussdCommand: VOUCHER,
			ussdReply: REPLY,
		});
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("USSD dialogue advanced");
		expectNoUssdContent(emitted, "logger metadata");
	});
});

describe("the module itself is content-free", () => {
	const identity = () => Promise.resolve({ stableKey: KEY });

	function runner(script: { fail?: boolean }): UssdCliRunner {
		return (argv) => {
			const flag = argv.find((entry) => entry.startsWith("--3gpp-ussd"));
			if (flag === undefined) {
				return Promise.resolve(
					"modem.3gpp.registration-state : home\nmodem.generic.access-technologies : lte",
				);
			}
			if (flag === "--3gpp-ussd-status") {
				return Promise.resolve(LEAKY_STATUS);
			}
			if (script.fail === true) {
				// mmcli's own USSD failure text quotes the command back at the caller,
				// which is the single most likely way a voucher code re-enters a log.
				return Promise.reject(
					new Error(`error: couldn't send USSD command '${VOUCHER}': rejected`),
				);
			}
			return Promise.resolve(
				`USSD session initiated; new reply from network: '${REPLY}'`,
			);
		};
	}

	beforeEach(() => {
		clearRecentLogLines();
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		resetModemUssdState();
		getConfig().modem_capabilities = { ussd: true };
		setModemCapabilityEvidenceReader(() => ({
			capability: { ussd: "present" },
		}));
	});

	afterEach(() => {
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		resetModemUssdState();
		setModemCapabilityEvidenceReader(null);
		delete getConfig().modem_capabilities;
	});

	it("a SUCCESSFUL dialogue returns the reply to the caller and logs none of it", async () => {
		const deps = { runCli: runner({}), resolveIdentity: identity };
		const initiated = await initiateModemUssd(DEVICE, VOUCHER, deps);
		const responded = await respondModemUssd(DEVICE, MENU_ANSWER, deps);

		// The operator DOES get the carrier's answer — this is redaction at the
		// log boundary, not a blanket drop.
		expect(initiated.ussdReply).toBe(REPLY);
		expect(responded.success).toBe(true);
		expectNoUssdContent(getRecentLogLines().join("\n"), "successful dialogue");
	});

	it("a FAILED dialogue logs the reason only, never the command mmcli quoted back", async () => {
		const result = await initiateModemUssd(DEVICE, VOUCHER, {
			runCli: runner({ fail: true }),
			resolveIdentity: identity,
		});

		expect(result.success).toBe(false);
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("mmcli USSD call failed");
		expectNoUssdContent(emitted, "failed dialogue");
	});

	it("the wire payload carries no key a redactor would have to guess at", async () => {
		const result = await initiateModemUssd(DEVICE, VOUCHER, {
			runCli: runner({}),
			resolveIdentity: identity,
		});
		// Everything sensitive on the reply envelope lives under `ussdReply`, so
		// redacting BY KEY is sufficient — a second, differently-named text field
		// would be a silent hole.
		expectNoUssdContent(
			JSON.stringify(logRedact(result)),
			"redacted wire payload",
		);
		expect(JSON.stringify(logRedact(result))).toContain(REDACTED);
	});
});
