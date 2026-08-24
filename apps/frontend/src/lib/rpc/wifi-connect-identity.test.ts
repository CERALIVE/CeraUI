/**
 * A connect confirms on PROFILE IDENTITY, never on SSID equality (F-06).
 *
 * The forcing case, and the reason this module exists: two saved profiles can
 * carry the same SSID. Under the retired rule ("is a network with the target
 * SSID active?") the wrong one coming up satisfied the pending connect — so the
 * dialog closed and reported success for a profile the operator never chose.
 */
import { describe, expect, it } from "vitest";

import {
	deriveWifiConnectIdentityOutcome,
	isPendingConnectRow,
	mintWifiConnectCorrelationId,
	type PendingWifiConnect,
} from "./wifi-connect-identity";

/** The profile the operator asked for, and its sibling under the same SSID. */
const CHOSEN = "uuid-chosen";
const SIBLING = "uuid-sibling";
const SHARED_SSID = "CafeWiFi";

function savedIntent(
	overrides: Partial<PendingWifiConnect> = {},
): PendingWifiConnect {
	return { ssid: SHARED_SSID, uuid: CHOSEN, baselineConn: "", ...overrides };
}

function freshIntent(
	overrides: Partial<PendingWifiConnect> = {},
): PendingWifiConnect {
	return {
		ssid: "Guest",
		correlationId: "corr-1",
		baselineConn: "uuid-home",
		...overrides,
	};
}

describe("deriveWifiConnectIdentityOutcome — saved connect", () => {
	it("confirms when the interface's active connection IS the dispatched profile", () => {
		expect(
			deriveWifiConnectIdentityOutcome(savedIntent(), { conn: CHOSEN }),
		).toBe("confirmed");
	});

	it("does NOT confirm when a SIBLING profile sharing the SSID came up instead", () => {
		// The scan list is indistinguishable from a success — the SSID really is
		// active — so nothing but the uuid can tell these two apart.
		expect(
			deriveWifiConnectIdentityOutcome(savedIntent(), {
				conn: SIBLING,
				saved: { [SHARED_SSID]: SIBLING },
			}),
		).toBe("pending");
	});

	it("stays pending while nothing is connected", () => {
		expect(deriveWifiConnectIdentityOutcome(savedIntent(), { conn: "" })).toBe(
			"pending",
		);
		expect(deriveWifiConnectIdentityOutcome(savedIntent(), {})).toBe("pending");
	});

	it("stays pending with no interface snapshot and with no dispatch", () => {
		expect(deriveWifiConnectIdentityOutcome(savedIntent(), undefined)).toBe(
			"pending",
		);
		expect(deriveWifiConnectIdentityOutcome(undefined, { conn: CHOSEN })).toBe(
			"pending",
		);
	});
});

describe("deriveWifiConnectIdentityOutcome — fresh connect", () => {
	it("confirms once the device's minted profile for that SSID is the active one", () => {
		expect(
			deriveWifiConnectIdentityOutcome(freshIntent(), {
				conn: "uuid-guest",
				saved: { Guest: "uuid-guest" },
			}),
		).toBe("confirmed");
	});

	it("does NOT confirm while the active connection is still the one we started from", () => {
		expect(
			deriveWifiConnectIdentityOutcome(freshIntent(), {
				conn: "uuid-home",
				saved: { Guest: "uuid-guest" },
			}),
		).toBe("pending");
	});

	it("does NOT confirm when something else came up under a different SSID", () => {
		expect(
			deriveWifiConnectIdentityOutcome(freshIntent(), {
				conn: "uuid-other",
				saved: { Guest: "uuid-guest", Other: "uuid-other" },
			}),
		).toBe("pending");
	});

	it("does NOT confirm before the device has recorded the new profile", () => {
		expect(
			deriveWifiConnectIdentityOutcome(freshIntent(), { conn: "uuid-guest" }),
		).toBe("pending");
	});

	it("claims nothing for an intent carrying neither a uuid nor a correlation id", () => {
		// Not reachable from the dialog, but the rule must never fall through to a
		// bare-SSID confirm — that is the shape of the defect it replaced.
		expect(
			deriveWifiConnectIdentityOutcome(
				{ ssid: "Guest" },
				{ conn: "uuid-guest", saved: { Guest: "uuid-guest" } },
			),
		).toBe("pending");
	});
});

describe("mintWifiConnectCorrelationId", () => {
	it("mints a fresh id every time, so one dispatch cannot answer for the next", () => {
		const ids = new Set(
			Array.from({ length: 50 }, () => mintWifiConnectCorrelationId()),
		);
		expect(ids.size).toBe(50);
	});
});

describe("isPendingConnectRow", () => {
	it("marks the dispatched saved row and NOT its SSID sibling", () => {
		const pending = savedIntent();
		expect(
			isPendingConnectRow(pending, { ssid: SHARED_SSID, uuid: CHOSEN }),
		).toBe(true);
		expect(
			isPendingConnectRow(pending, { ssid: SHARED_SSID, uuid: SIBLING }),
		).toBe(false);
	});

	it("marks the unsaved row a fresh connect targets, and no saved row of that SSID", () => {
		const pending = freshIntent();
		expect(isPendingConnectRow(pending, { ssid: "Guest" })).toBe(true);
		expect(
			isPendingConnectRow(pending, { ssid: "Guest", uuid: "uuid-guest" }),
		).toBe(false);
		expect(isPendingConnectRow(pending, { ssid: "Other" })).toBe(false);
	});

	it("marks nothing when no connect is in flight", () => {
		expect(isPendingConnectRow(undefined, { ssid: SHARED_SSID })).toBe(false);
	});
});
