export type UplinkKind = "ethernet" | "wifi" | "dongle" | "cellular" | "other";
export type UplinkCandidate = {
	readonly ifname: string;
	readonly kind: UplinkKind;
	readonly metered: boolean;
};
export type Family = 4 | 6;
export type ProbeState =
	| "clear"
	| "captive-http"
	| "captive-tls"
	| "tls-error"
	| "tampered"
	| "blocked"
	| "no-route"
	| "dns-failed"
	| "credentials-invalid"
	| "probe-unavailable";
export type HostProbe = {
	readonly host: string;
	readonly state: ProbeState;
	readonly latencyMs: number;
};
export type TransportSample = {
	readonly candidate: UplinkCandidate;
	readonly family: Family;
	readonly hosts: readonly HostProbe[];
};
export type RankedTransport = TransportSample & {
	readonly healthy: boolean;
	readonly reason: string;
	readonly latencyMs: number;
};
export type TransportSelection =
	| {
			readonly status: "selected";
			readonly selected: RankedTransport;
			readonly ranked: readonly RankedTransport[];
	  }
	| {
			readonly status: "none";
			readonly reason: "no-healthy-transport";
			readonly ranked: readonly RankedTransport[];
	  };
export type DebianSource = { readonly url: string; readonly keyring: string };

const kindRank: Record<UplinkKind, number> = {
	ethernet: 0,
	wifi: 1,
	dongle: 2,
	cellular: 3,
	other: 4,
};

export function classifyHttp(
	code: number,
	body: string,
): "clear" | "captive-http" {
	return code === 204 && body === "" ? "clear" : "captive-http";
}

export function classifyTransfer(
	failure:
		| "tls"
		| "timeout"
		| "refused"
		| "dns"
		| "gpgv"
		| "credentials"
		| "unavailable",
	portalSeen: boolean,
): ProbeState {
	switch (failure) {
		case "tls":
			return portalSeen ? "captive-tls" : "tls-error";
		case "timeout":
			return "blocked";
		case "refused":
			return "no-route";
		case "dns":
			return "dns-failed";
		case "gpgv":
			return "tampered";
		case "credentials":
			return "credentials-invalid";
		case "unavailable":
			return "probe-unavailable";
	}
}

export function rankTransports(
	samples: readonly TransportSample[],
): TransportSelection {
	const ranked = samples
		.map((sample): RankedTransport => {
			const healthy =
				sample.hosts.length > 0 &&
				sample.hosts.every(({ state }) => state === "clear");
			const latencyMs = sample.hosts.reduce(
				(total, host) => total + host.latencyMs,
				0,
			);
			return {
				...sample,
				healthy,
				latencyMs,
				reason: `${sample.candidate.metered ? "metered" : "unmetered"} ${sample.candidate.kind} ${sample.family === 4 ? "IPv4" : "IPv6"}: ${healthy ? "all hosts clear" : sample.hosts.map(({ host, state }) => `${host} ${state}`).join(", ")}`,
			};
		})
		.sort(
			(a, b) =>
				Number(b.healthy) - Number(a.healthy) ||
				Number(a.candidate.metered) - Number(b.candidate.metered) ||
				kindRank[a.candidate.kind] - kindRank[b.candidate.kind] ||
				a.latencyMs - b.latencyMs ||
				a.candidate.ifname.localeCompare(b.candidate.ifname) ||
				a.family - b.family,
		);
	const selected = ranked.find(({ healthy }) => healthy);
	return selected
		? { status: "selected", selected, ranked }
		: { status: "none", reason: "no-healthy-transport", ranked };
}

export function discoverCandidates(
	ifnames: readonly string[],
	nmcli: string,
	mmIfnames: readonly string[],
	routerIfnames: readonly string[],
	dongleIfnames: readonly string[] = [],
): UplinkCandidate[] {
	const lines = new Map<
		string,
		{ type: string; state: string; metered: string }
	>();
	for (const block of nmcli.split(/\r?\n\s*\r?\n/)) {
		const fields = new Map(
			block.split(/\r?\n/).map((line) => {
				const at = line.indexOf(":");
				return [line.slice(0, at), line.slice(at + 1)] as const;
			}),
		);
		const ifname = fields.get("GENERAL.DEVICE");
		if (ifname)
			lines.set(ifname, {
				type: fields.get("GENERAL.TYPE") ?? "",
				state: fields.get("GENERAL.STATE") ?? "",
				metered: fields.get("GENERAL.METERED") ?? "unknown",
			});
	}
	for (const line of nmcli.split(/\r?\n/)) {
		const [ifname, type, state, ...rest] = line.split(":");
		if (ifname && type && state && !ifname.startsWith("GENERAL."))
			lines.set(ifname, { type, state, metered: rest.at(-1) ?? "unknown" });
	}
	return ifnames
		.filter((ifname) =>
			/^(?:100\s*\(connected|connected)/.test(lines.get(ifname)?.state ?? ""),
		)
		.map((ifname) => {
			const row = lines.get(ifname);
			const metered =
				/^(?:yes|guess-yes|yes \(guessed\))$/i.test(row?.metered ?? "") ||
				mmIfnames.includes(ifname) ||
				routerIfnames.includes(ifname);
			const kind: UplinkKind =
				mmIfnames.includes(ifname) || routerIfnames.includes(ifname) || metered
					? "cellular"
					: dongleIfnames.includes(ifname)
						? "dongle"
						: row?.type === "wifi"
							? "wifi"
							: row?.type === "ethernet"
								? "ethernet"
								: "other";
			return { ifname, kind, metered };
		});
}

function sourceUrl(uri: string, suite: string): string | undefined {
	try {
		const parsed = new URL(uri);
		if (
			!["http:", "https:"].includes(parsed.protocol) ||
			!/^[a-zA-Z0-9.+_-]+$/.test(suite)
		)
			return undefined;
		return `${parsed.href.replace(/\/+$/, "")}/dists/${suite}/InRelease`;
	} catch {
		return undefined;
	}
}

export function parseDebianSources(text: string): DebianSource[] {
	const sources: DebianSource[] = [];
	for (const stanza of text.split(/\r?\n\s*\r?\n/)) {
		const fields = new Map<string, string>();
		let current = "";
		for (const line of stanza.split(/\r?\n/)) {
			if (/^\s/.test(line) && current)
				fields.set(current, `${fields.get(current)} ${line.trim()}`);
			else {
				const match = line.match(/^([\w-]+):\s*(.*)$/);
				if (match) {
					current = match[1]?.toLowerCase() ?? "";
					fields.set(current, match[2] ?? "");
				}
			}
		}
		if (
			fields.size &&
			fields.get("enabled") !== "no" &&
			(fields.get("types") ?? "deb").split(/\s+/).includes("deb")
		) {
			const keyring = fields.get("signed-by");
			if (fields.has("uris") && fields.has("suites")) {
				for (const uri of (fields.get("uris") ?? "").split(/\s+/))
					for (const suite of (fields.get("suites") ?? "").split(/\s+/)) {
						const url = sourceUrl(uri, suite);
						if (url && new URL(url).hostname !== "apt.ceralive.tv")
							sources.push({
								url,
								keyring: keyring && /^\/[\w./-]+$/.test(keyring) ? keyring : "",
							});
					}
			}
		}
		for (const line of stanza.split(/\r?\n/)) {
			const match = line
				.trim()
				.match(/^deb\s+(?:\[([^\]]+)\]\s+)?(\S+)\s+(\S+)\s+/);
			if (!match) continue;
			const keyring = match[1]?.match(/(?:^|\s)signed-by=(\/[^\s]+)/i)?.[1];
			const url = sourceUrl(match[2] ?? "", match[3] ?? "");
			if (url && new URL(url).hostname !== "apt.ceralive.tv")
				sources.push({
					url,
					keyring: keyring && /^\/[\w./-]+$/.test(keyring) ? keyring : "",
				});
		}
	}
	return [
		...new Map(
			sources.map((source) => [`${source.url}\0${source.keyring}`, source]),
		).values(),
	];
}
