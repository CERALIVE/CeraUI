export type AptOrigin = {
	readonly url: string;
	readonly host: string;
	readonly scheme: "http" | "https";
	readonly probeUrl: string;
};

const FIRST_PARTY_APT_HOST = "apt.ceralive.tv";

function fieldValue(stanza: string, field: string): string | undefined {
	const lines = stanza.split(/\r?\n/);
	const prefix = `${field.toLowerCase()}:`;
	let value: string | undefined;
	for (const line of lines) {
		if (/^\s/.test(line) && value !== undefined) {
			value += ` ${line.trim()}`;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon < 0 || line.slice(0, colon + 1).toLowerCase() !== prefix)
			continue;
		value = line.slice(colon + 1).trim();
	}
	return value;
}

function aptProbeUrl(uri: URL, suite: string): string {
	if (uri.host.toLowerCase() === FIRST_PARTY_APT_HOST) return `${uri.origin}/`;
	const base = uri.href.replace(/\/+$/, "");
	return `${base}/dists/${suite.replace(/^\/+|\/+$/g, "")}/InRelease`;
}

export function parseAptSourceOrigins(text: string): AptOrigin[] {
	const origins: AptOrigin[] = [];
	for (const stanza of text.split(/\r?\n\s*\r?\n/)) {
		if (fieldValue(stanza, "Enabled")?.toLowerCase() === "no") continue;
		const uris = fieldValue(stanza, "URIs")?.split(/\s+/).filter(Boolean) ?? [];
		const suites =
			fieldValue(stanza, "Suites")?.split(/\s+/).filter(Boolean) ?? [];
		for (const rawUri of uris) {
			let uri: URL;
			try {
				uri = new URL(rawUri);
			} catch {
				continue;
			}
			if (uri.protocol !== "http:" && uri.protocol !== "https:") continue;
			const scheme = uri.protocol === "http:" ? "http" : "https";
			const url = uri.href.replace(/\/+$/, "");
			for (const suite of suites) {
				origins.push({
					url,
					host: uri.host,
					scheme,
					probeUrl: aptProbeUrl(uri, suite),
				});
			}
		}
	}
	return origins;
}
