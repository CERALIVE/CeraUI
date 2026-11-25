import type {
	RadioFinding,
	RadioHealth,
	RadioMetric,
} from "@ceraui/rpc/schemas";

export function metric(
	value: number | string | null,
	source: string,
	unit: string,
	technology: string,
	capturedAt: number,
): RadioMetric {
	return {
		value,
		source,
		unit,
		technology,
		capturedAt,
		...(value === null
			? {
					reason:
						source === "not-observed"
							? ("not-observed" as const)
							: ("not-reported" as const),
				}
			: {}),
	};
}
export interface RadioEvidence {
	at: number;
	intervalStart?: number;
	registration: string;
	homeNetwork: string | undefined;
	rejectedNetwork: string | undefined;
	refused: boolean;
	rejectionCause?: string | undefined;
	granted: boolean;
	failedProbes: number;
	probeAt: number | undefined;
	rsrp: RadioMetric;
	quality: RadioMetric;
	transmitting: "yes" | "unknown";
	/** Independently observed radio silence followed by transmission; never inferred from payload bytes. */
	transmitContrast?: { idleAt: number; activeAt: number } | undefined;
	usb: { at: number; kind: "reset" | "disconnect" }[];
}
const unknown = (): RadioFinding => ({
	kind: "unknown",
	confidence: "unknown",
	evidence: [],
});
/** Passive correlation only. Thresholds are provisional; never a causal verdict. */
export function diagnoseRadio(
	current: RadioEvidence,
	previous: RadioEvidence | undefined,
	neighbours: Record<string, RadioEvidence>,
): RadioFinding {
	for (const [id, other] of Object.entries(neighbours)) {
		if (
			other.transmitting !== "yes" ||
			Math.abs(other.at - current.at) > 5000 ||
			!other.transmitContrast ||
			!previous ||
			other.transmitContrast.idleAt > previous.at ||
			previous.at >= other.transmitContrast.activeAt ||
			other.transmitContrast.activeAt > current.at ||
			current.at - other.transmitContrast.idleAt > 65000 ||
			previous.usb.length > 0
		)
			continue;
		const reset = current.usb.filter(
			(e) => e.at >= other.transmitContrast!.activeAt && e.at <= other.at,
		);
		const fresh =
			previous && current.at > previous.at && current.at - previous.at <= 65000;
		const comparable =
			fresh &&
			previous.rsrp.source === current.rsrp.source &&
			previous.rsrp.technology === current.rsrp.technology &&
			previous.rsrp.unit === current.rsrp.unit &&
			previous.quality.source === current.quality.source &&
			previous.quality.unit === current.quality.unit &&
			previous.quality.technology === current.quality.technology;
		const drop =
			comparable &&
			typeof current.rsrp.value === "number" &&
			typeof previous.rsrp.value === "number" &&
			typeof current.quality.value === "number" &&
			typeof previous.quality.value === "number" &&
			Math.abs(current.rsrp.value - previous.rsrp.value) <= 3 &&
			current.quality.value <= previous.quality.value - 5;
		if (reset.length || drop)
			return {
				kind: "disturbed",
				confidence: "possible",
				neighbour: id,
				evidence: [
					reset.length
						? `usb-coincidences:${reset.length}`
						: "steady-level-quality-drop",
					`transmit-window-ms:${other.at - (other.intervalStart ?? other.at - 5000)}`,
				],
			};
	}
	if (
		current.refused &&
		[
			"imsi-unknown-in-hlr",
			"illegal-ms",
			"gprs-not-allowed",
			"gprs-and-non-gprs-not-allowed",
			"imsi-unknown-in-vlr",
		].includes(current.rejectionCause ?? "") &&
		current.homeNetwork &&
		current.homeNetwork === current.rejectedNetwork
	)
		return {
			kind: "sim-account",
			confidence: "likely",
			evidence: ["home-network-refused-registration"],
		};
	if (
		["home", "roaming", "registered", "connected"].includes(
			current.registration,
		) &&
		current.granted &&
		current.failedProbes >= 2 &&
		current.probeAt !== undefined &&
		current.at >= current.probeAt &&
		current.at - current.probeAt <= 65000
	)
		return {
			kind: "data-path",
			confidence: "likely",
			evidence: [
				"registered",
				"packet-service-attached",
				"two-failed-path-probes",
			],
		};
	return unknown();
}
export function parseQmiSignal(
	text: string,
	at: number,
): Record<string, RadioMetric> {
	const result: Record<string, RadioMetric> = {};
	let tech = "unknown";
	for (const line of text.split("\n")) {
		const header = line.match(/^\s*(LTE|5G NR|NR5G|5G):/);
		if (header) tech = header[1] === "LTE" ? "lte" : "nr";
		const m = line.match(
			/(RSRP|RSRQ|SNR|SINR):\s*'?(-?\d+(?:\.\d+)?)\s*(dBm|dB)/,
		);
		if (m && m[1] && m[2] && m[3])
			result[`${tech}.${m[1].toLowerCase()}`] = metric(
				Number(m[2]),
				`QMI NAS signal-info ${m[1]}`,
				m[3],
				tech,
				at,
			);
	}
	return result;
}
export function emptyRadio(at: number): RadioHealth {
	const absent = (unit = "") =>
		metric(null, "not-observed", unit, "unknown", at);
	return {
		capturedAt: at,
		registration: absent(),
		layer: absent(),
		band: absent(),
		metrics: {
			rsrp: absent("dBm"),
			rsrq: absent("dB"),
			sinr: absent("dB"),
			snr: absent("dB"),
			lteTxPower: absent("dBm"),
		},
		neighbours: [],
		usb: { available: false, events: [] },
		finding: unknown(),
		timeline: [],
	};
}

/** Only recognized serving records; LTE raw SINR never acquires a dB unit. */
export function parseQeng(
	text: string,
	at: number,
):
	| {
			layer: RadioMetric;
			band: RadioMetric;
			metrics: Record<string, RadioMetric>;
	  }
	| undefined {
	const rows = text
		.split("\n")
		.filter((line) => line.trim().startsWith("+QENG:"))
		.map((line) =>
			line
				.slice(line.indexOf(":") + 1)
				.split(",")
				.map((v) => v.trim().replaceAll('"', "")),
		);
	const lte = rows.find(
		(row) =>
			(row[0] === "LTE" && row.length >= 16) ||
			(row[0] === "servingcell" && row[2] === "LTE" && row.length >= 18),
	);
	const nr = rows.find(
		(row) =>
			(row[0] === "NR5G-NSA" && row.length >= 10) ||
			(row[0] === "servingcell" && row[2] === "NR5G-SA" && row.length >= 16),
	);
	if (!lte && !nr) return undefined;
	const metrics: Record<string, RadioMetric> = {};
	const bands: string[] = [];
	const read = (row: string[], offset: number, tech: string) => {
		const add = (key: string, index: number, unit: string) => {
			const raw = row[index];
			if (raw && /^-?\d+(?:\.\d+)?$/.test(raw) && Number(raw) !== -32768)
				metrics[`${tech}.${key}`] = metric(
					Number(raw),
					"QENG servingcell",
					unit,
					tech,
					at,
				);
		};
		if (tech === "lte") {
			if (row[offset + 7]) bands.push(`LTE B${row[offset + 7]}`);
			add("rsrp", offset + 11, "dBm");
			add("rsrq", offset + 12, "dB");
			add("sinr", offset + 14, "raw");
		}
	};
	if (lte) read(lte, lte[0] === "LTE" ? 0 : 2, "lte");
	// An NSA record identifies NR separately; do not fold its level into LTE.
	if (nr?.[0] === "NR5G-NSA" && nr.length >= 10) {
		if (nr[8]) bands.push(`NR n${nr[8]}`);
		for (const [name, index, unit] of [
			["rsrp", 4, "dBm"],
			["sinr", 5, "dB"],
			["rsrq", 6, "dB"],
		] as const) {
			const raw = nr[index];
			if (raw && /^-?\d+(?:\.\d+)?$/.test(raw) && Number(raw) !== -32768)
				metrics[`nr.${name}`] = metric(
					Number(raw),
					"QENG servingcell",
					unit,
					"nr",
					at,
				);
		}
	}
	return {
		layer: metric(
			lte && nr?.[0] === "NR5G-NSA"
				? "LTE + NR (NSA)"
				: nr?.[2] === "NR5G-SA"
					? "NR (SA)"
					: lte
						? "LTE"
						: "NR (NSA; anchor unavailable)",
			"QENG servingcell",
			"",
			"serving",
			at,
		),
		band: metric(
			bands.length ? bands.join(" + ") : null,
			"QENG servingcell",
			"band",
			"serving",
			at,
		),
		metrics,
	};
}
