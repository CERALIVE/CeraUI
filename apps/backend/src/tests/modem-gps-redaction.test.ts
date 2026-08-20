/*
 * GPS/location — redaction proof.
 *
 * A GNSS fix says where the operator physically IS, which is the one thing the
 * module's privacy fence exists to keep off disk and out of a log. This drives
 * the REAL logger (via its capture ring, which sits downstream of `redact()`)
 * rather than asserting on a mock, and it drives the REAL mmcli reader with a
 * fix-bearing record so a leak through a parse or a warn path is caught too.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
	clearRecentLogLines,
	getRecentLogLines,
	isGpsSensitiveKey,
	logger,
	logRedact,
	REDACTED,
} from "../helpers/logger.ts";
import {
	parseLocationFix,
	readLocationFix,
	readLocationStatus,
} from "../modules/modems/mmcli-location.ts";

const LATITUDE = "4.6097100";
const LONGITUDE = "-74.0817500";
const ALTITUDE = "2640.000000";

const LEAKY_RECORD = [
	`modem.location.gps.utc       : 181908.00`,
	`modem.location.gps.latitude  : ${LATITUDE}`,
	`modem.location.gps.longitude : ${LONGITUDE}`,
	`modem.location.gps.altitude  : ${ALTITUDE}`,
].join("\n");

const NMEA =
	"$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47";

const STATUS_OK = [
	"modem.location.capabilities.length : 3",
	"modem.location.capabilities.value[1] : 3gpp-lac-ci",
	"modem.location.capabilities.value[2] : gps-raw",
	"modem.location.capabilities.value[3] : gps-nmea",
	"modem.location.enabled.length : 1",
	"modem.location.enabled.value[1] : gps-raw",
].join("\n");

/** Every substring that would identify the position, in any rendering. */
const POSITION_TOKENS = [
	LATITUDE,
	LONGITUDE,
	ALTITUDE,
	"4.60971",
	"-74.08175",
	"4807.038",
	"01131.000",
];

function expectNoPosition(haystack: string, where: string): void {
	for (const token of POSITION_TOKENS) {
		if (haystack.includes(token)) {
			throw new Error(`${where} leaked a coordinate: ${token}`);
		}
	}
}

describe("isGpsSensitiveKey — anchored, not substring", () => {
	it("matches every key that genuinely names a coordinate", () => {
		for (const key of [
			"latitude",
			"longitude",
			"altitude",
			"lat",
			"lon",
			"lng",
			"nmea",
			"NMEA",
			"nmea_sentences",
			"coordinates",
			"gps-raw",
			"modem.location.gps.raw.latitude",
			"modem.location.gps.nmea",
		]) {
			expect(isGpsSensitiveKey(key)).toBe(true);
		}
	});

	it("does NOT over-redact ordinary keys a substring rule would eat", () => {
		for (const key of [
			"latency",
			"latencyMs",
			"translation",
			"longPress",
			"altitudeUnavailable",
			"gnssCapable",
			"gnssEnabled",
			"capabilities",
			"enabledSources",
			"observedAt",
			"reason",
			"kind",
		]) {
			expect(isGpsSensitiveKey(key)).toBe(false);
		}
	});

	it("leaves coarse cell location alone — it is the cell-info surface", () => {
		for (const key of ["lac", "cid", "tac", "mcc", "mnc"]) {
			expect(isGpsSensitiveKey(key)).toBe(false);
		}
	});
});

describe("logRedact — a fix never survives", () => {
	it("scrubs every coordinate key while keeping the honest state around it", () => {
		const redacted = logRedact({
			modem: "14",
			gnssCapable: true,
			state: {
				kind: "fix",
				fix: { latitude: 4.60971, longitude: -74.08175, altitude: 2640 },
			},
		}) as Record<string, unknown>;

		expect(redacted.modem).toBe("14");
		expect(redacted.gnssCapable).toBe(true);
		expectNoPosition(JSON.stringify(redacted), "logRedact");
	});

	it("scrubs a raw mmcli location record that arrives as a bare string value", () => {
		const redacted = logRedact({ output: LEAKY_RECORD }) as Record<
			string,
			unknown
		>;
		expect(redacted.output).toBe(REDACTED);
		expectNoPosition(JSON.stringify(redacted), "logRedact value-shape");
	});

	it("scrubs a raw NMEA sentence, which carries the position in its payload", () => {
		const redacted = logRedact({ output: NMEA }) as Record<string, unknown>;
		expect(redacted.output).toBe(REDACTED);
		expectNoPosition(JSON.stringify(redacted), "logRedact nmea value-shape");
	});
});

describe("the REAL logger emits no coordinate", () => {
	beforeEach(() => {
		clearRecentLogLines();
	});

	it("scrubs a location record logged as a free-text message", () => {
		logger.warn(LEAKY_RECORD);
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain(REDACTED);
		expectNoPosition(emitted, "logger message");
	});

	it("scrubs a fix attached to an ordinary log line", () => {
		logger.info("gnss fix acquired", {
			modem: "14",
			latitude: 4.60971,
			longitude: -74.08175,
			nmea: NMEA,
		});
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("gnss fix acquired");
		expectNoPosition(emitted, "logger metadata");
	});
});

describe("the REAL mmcli reader never logs a position", () => {
	beforeEach(() => {
		clearRecentLogLines();
	});

	it("a successful fix read logs nothing about where the device is", async () => {
		const result = await readLocationFix("14", 1_000, async () => LEAKY_RECORD);
		expect(result.ok && result.fix?.latitude).toBeCloseTo(4.60971, 5);
		expectNoPosition(getRecentLogLines().join("\n"), "successful fix read");
	});

	it("a FAILING fix read logs a reason, never the record it was given", async () => {
		const result = await readLocationFix("14", 1_000, async () => {
			throw new Error(`mmcli died holding ${LEAKY_RECORD}`);
		});
		expect(result.ok).toBe(false);
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("location get failed");
		expectNoPosition(emitted, "failed fix read");
	});

	it("the STATUS read is unaffected — source names are not a position", async () => {
		const result = await readLocationStatus("14", async () => STATUS_OK);
		expect(result.ok && result.status.gnssCapable).toBe(true);
		expect(result.ok && result.status.enabledSources).toEqual(["gps-raw"]);
	});

	it("the fix parser reports drift without echoing the record", () => {
		// A record whose coordinate keys drifted must decode to NOTHING rather
		// than to a partial position, and must not name the line it read.
		const drifted = LEAKY_RECORD.replace(/latitude/g, "lattitude");
		expect(parseLocationFix(drifted, 1_000)).toBeUndefined();
		expectNoPosition(getRecentLogLines().join("\n"), "drifted parse");
	});
});
