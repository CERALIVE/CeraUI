import { describe, expect, test } from "bun:test";
import {
	diagnoseRadio,
	metric,
	parseQeng,
	parseQmiSignal,
	type RadioEvidence,
} from "../modules/modems/radio-health.ts";

const sample = (
	at: number,
	changes: Partial<RadioEvidence> = {},
): RadioEvidence => ({
	at,
	registration: "connected",
	homeNetwork: "00101",
	rejectedNetwork: undefined,
	refused: false,
	granted: true,
	failedProbes: 0,
	probeAt: at,
	rsrp: metric(-100, "test", "dBm", "lte", at),
	quality: metric(-8, "test", "dB", "lte", at),
	transmitting: "unknown",
	usb: [],
	...changes,
});
describe("passive radio diagnoses", () => {
	test("own network refusal is distinct from foreign refusal and unknown home network", () => {
		expect(
			diagnoseRadio(
				sample(0, {
					refused: true,
					rejectionCause: "imsi-unknown-in-hlr",
					rejectedNetwork: "00101",
				}),
				undefined,
				{},
			).kind,
		).toBe("sim-account");
		expect(
			diagnoseRadio(
				sample(0, { refused: true, rejectedNetwork: "00102" }),
				undefined,
				{},
			).kind,
		).toBe("unknown");
		expect(
			diagnoseRadio(
				sample(0, {
					refused: true,
					rejectedNetwork: "00102",
					homeNetwork: undefined,
				}),
				undefined,
				{},
			).kind,
		).toBe("unknown");
	});
	test("blackholed path needs registration, packet grant and two fresh failed probes", () => {
		for (const at of [30000, 60000]) {
			const bad = sample(at, { failedProbes: at / 30000 });
			expect(diagnoseRadio(bad, undefined, {}).kind).toBe(
				at === 60000 ? "data-path" : "unknown",
			);
			expect(diagnoseRadio(sample(at), undefined, {}).kind).toBe("unknown");
		}
		expect(
			diagnoseRadio(
				sample(90000, { failedProbes: 2, granted: false }),
				undefined,
				{},
			).kind,
		).toBe("unknown");
		expect(
			diagnoseRadio(
				sample(90000, { failedProbes: 2, probeAt: 0 }),
				undefined,
				{},
			).kind,
		).toBe("unknown");
	});

	test("a USB reset while both links carry traffic is not interference evidence", () => {
		const now = sample(30000, { usb: [{ at: 29000, kind: "reset" }] });
		expect(
			diagnoseRadio(now, sample(0), {
				peer: sample(30000, { transmitting: "yes" }),
			}).kind,
		).toBe("unknown");
	});
	test("independent idle-to-active radio evidence and a healthy baseline allow possible interference", () => {
		const now = sample(30000, { usb: [{ at: 29000, kind: "reset" }] });
		const peer = sample(30000, {
			transmitting: "yes",
			transmitContrast: { idleAt: 1000, activeAt: 20000 },
		});
		expect(diagnoseRadio(now, sample(1000), { peer }).kind).toBe("disturbed");
		expect(
			diagnoseRadio(now, sample(1000), {
				peer: { ...peer, transmitContrast: undefined },
			}).kind,
		).toBe("unknown");
		expect(diagnoseRadio(now, undefined, { peer }).kind).toBe("unknown");
	});
	test("quality drops at steady level only correlate with a fresh sending neighbour and matching units", () => {
		const before = sample(0);
		const now = sample(2000, {
			quality: metric(-16, "test", "dB", "lte", 2000),
		});
		expect(
			diagnoseRadio(now, before, {
				peer: sample(2000, {
					transmitting: "yes",
					transmitContrast: { idleAt: 0, activeAt: 1000 },
				}),
			}).kind,
		).toBe("disturbed");
		expect(diagnoseRadio(now, before, { peer: sample(2000) }).kind).toBe(
			"unknown",
		);
		expect(
			diagnoseRadio(
				{ ...now, rsrp: metric(-115, "test", "dBm", "lte", 2000) },
				before,
				{
					peer: sample(2000, {
						transmitting: "yes",
						transmitContrast: { idleAt: 0, activeAt: 1000 },
					}),
				},
			).kind,
		).toBe("unknown");
		expect(
			diagnoseRadio(
				{ ...now, quality: metric(-16, "QENG", "raw", "lte", 2000) },
				before,
				{
					peer: sample(2000, {
						transmitting: "yes",
						transmitContrast: { idleAt: 0, activeAt: 1000 },
					}),
				},
			).kind,
		).toBe("unknown");
	});
	test("payload activity and large quality changes cannot establish radio interference", () => {
		let previous: RadioEvidence | undefined;
		for (let at = 0; at < 3600000; at += 2000) {
			const current = sample(at, {
				rsrp: metric(-100 + Math.sin(at / 10000), "test", "dBm", "lte", at),
				quality: metric(-8 - ((at / 2000) % 2) * 8, "test", "dB", "lte", at),
			});
			expect(
				diagnoseRadio(current, previous, {
					peer: sample(at, { transmitting: "yes" }),
				}).kind,
			).toBe("unknown");
			previous = current;
		}
	});
	test("QMI SNR remains distinct from QENG raw SINR; NSA retains both bands", () => {
		const qmi = parseQmiSignal(
			"LTE:\n RSRP: '-101 dBm'\n SNR: '-8.6 dB'",
			1000,
		);
		expect(qmi["lte.snr"]?.unit).toBe("dB");
		expect(qmi["lte.sinr"]).toBeUndefined();
		const qeng = parseQeng(
			'+QENG: "servingcell","NOCONN","LTE","FDD",001,01,AAAA,10,100,3,5,5,001,-101,-20,-60,3,0\n+QENG: "NR5G-NSA",001,01,12,-95,1,-18,12345,78,10,30',
			1000,
		);
		expect(qeng?.band.value).toBe("LTE B3 + NR n78");
		expect(qeng?.metrics["lte.sinr"]?.unit).toBe("raw");
		expect(parseQeng("ERROR", 1000)).toBeUndefined();
	});
});

test("synthetic replay separates payload activity from independent radio evidence", async () => {
	const { replayRadio } = await import(
		"../modules/modems/radio-health-replay.ts"
	);
	const fixture = await Bun.file(
		new URL("./fixtures/radio-health/usb-correlation.json", import.meta.url),
	).json();
	expect(replayRadio(fixture)).toEqual({
		resets: 3,
		coincidentResets: 1,
		quietResets: 1,
		controlOnlyResets: 1,
	});
	expect(
		replayRadio({
			...fixture,
			transmitWindows: fixture.transmitWindows.filter(
				(w: { source: string }) => w.source === "payload-counter",
			),
		}),
	).toMatchObject({ coincidentResets: 0 });
});

test("5G signal headers and absent NR readings retain honest technology and availability", () => {
	expect(
		parseQmiSignal("LTE:\n RSRP: '-100 dBm'\n5G:\n RSRP: '-90 dBm'", 1000)[
			"nr.rsrp"
		]?.value,
	).toBe(-90);
	const q = parseQeng(
		'+QENG: "servingcell","NOCONN","LTE","FDD",001,01,AAAA,10,100,3,5,5,001,-101,-20,-60,3,0\n+QENG: "NR5G-NSA",001,01,12,-32768,-32768,-32768,12345,78,10,30',
		1000,
	);
	expect(q?.metrics["nr.rsrp"]).toBeUndefined();
});

test("congestion and network failures never imply an account problem", () => {
	for (const rejectionCause of ["congestion", "network-failure", undefined])
		expect(
			diagnoseRadio(
				sample(1000, {
					refused: true,
					rejectedNetwork: "00101",
					rejectionCause,
				}),
				undefined,
				{},
			).kind,
		).toBe("unknown");
});

test("a refused device (illegal-me) is never reported as a SIM or account problem", () => {
	expect(
		diagnoseRadio(
			sample(1000, {
				refused: true,
				rejectedNetwork: "00101",
				rejectionCause: "illegal-me",
			}),
			undefined,
			{},
		).kind,
	).toBe("unknown");
});
