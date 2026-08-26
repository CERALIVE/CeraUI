import { describe, expect, it } from "bun:test";

import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

const MODEM_VOCABULARY_KEYS = [
	"network.modem.detail.operatorCode",
	"network.modem.detail.operatorName",
	"network.modem.detail.reason.authExpired",
	"network.modem.detail.reason.malformed",
	"network.modem.detail.reason.notObserved",
	"network.modem.detail.reason.notReported",
	"network.modem.detail.reason.refused",
	"network.modem.detail.reason.unreachable",
	"network.modem.detail.reason.unsupported",
	"network.modem.detail.recencyCached",
	"network.modem.detail.recencyLabel",
	"network.modem.detail.recencyLive",
	"network.modem.detail.registrationTitle",
	"network.modem.detail.signalTitle",
	"network.modem.detail.tac",
	"network.modem.operation.completion.applied",
	"network.modem.operation.completion.dropped",
	"network.modem.operation.completion.failed",
	"network.modem.operation.completion.refused",
	"network.modem.operation.completion.timedOut",
	"network.modem.operation.result.applied",
	"network.modem.operation.result.failed",
	"network.modem.operation.result.refused",
	"network.modem.operation.result.unknownOutcome",
	"network.modem.operation.retrySuggested",
	"network.modem.operation.unknown.staleGeneration",
	"network.modem.operation.unknown.writeReplyDropped",
	"network.modem.operation.unknown.writeReplyTimedOut",
	"network.modem.refusal.blockedByState",
	"network.modem.refusal.deviceBusy",
	"network.modem.refusal.hardwareGone",
	"network.modem.refusal.readFailed",
	"network.modem.refusal.timedOutUnknownOutcome",
	"network.modem.refusal.unreachable",
	"network.modem.refusal.unsupported",
	"network.routerCellular.lock.cause.authFailed",
	"network.modem.simEvidence.noEvidence",
	"network.modem.simEvidence.simObjectPath",
	"network.modem.simEvidence.simSlotObjectPath",
	"network.modem.simEvidence.stateFailedReason",
	"network.modem.simEvidence.vendorCodeUnclaimed",
] as const;

describe("modem operation vocabulary catalog gate", () => {
	it("has every new reason and outcome key in every locale", () => {
		for (const locale of ALL_LOCALES) {
			const catalog = readCatalog(locale);
			const missing = MODEM_VOCABULARY_KEYS.filter(
				(key) => typeof catalog[key] !== "string" || catalog[key].trim() === "",
			);
			expect(missing, locale).toEqual([]);
		}
	});

	it("uses translated copy rather than English in every non-base locale", () => {
		const english = readCatalog("en");
		for (const locale of ALL_LOCALES.filter((code) => code !== "en")) {
			const catalog = readCatalog(locale);
			const untranslated = MODEM_VOCABULARY_KEYS.filter(
				(key) => catalog[key] === english[key],
			);
			expect(untranslated, locale).toEqual([]);
		}
	});
});
