function sourceOrigin(
	source: string,
	release: string,
	origin: string,
): string | null {
	const url = /^https:\/\/\S+/.exec(source)?.[0];
	if (!url || !URL.canParse(url)) return null;
	const host = new URL(url).hostname;
	if (host !== origin) return null;
	if (
		host === "apt.ceralive.tv" &&
		/(?:^|,)o=CeraLive(?:,|$)/.test(release) &&
		/(?:^|,)l=CeraLive(?:,|$)/.test(release) &&
		/(?:^|,)n=(?:stable|beta)(?:,|$)/.test(release)
	)
		return host;
	const suite = /(?:^|,)n=(trixie(?:-updates|-security)?)(?:,|$)/.exec(
		release,
	)?.[1];
	if (
		(host === "deb.debian.org" || host === "security.debian.org") &&
		/(?:^|,)o=Debian(?:,|$)/.test(release) &&
		/(?:^|,)l=Debian(?:-Security)?(?:,|$)/.test(release) &&
		suite
	)
		return `Debian ${suite}`;
	return null;
}

export function policySources(inventory: string): Map<string, string | null> {
	const sources = new Map<string, string | null>();
	const lines = inventory.split("\n");
	if (lines[0] !== "Package files:") return sources;
	for (let i = 1; i < lines.length && lines[i] !== "Pinned packages:"; i++) {
		const source = /^\s*\d+\s+(https?:\/\/\S+\s+.+\s+Packages)\s*$/.exec(
			lines[i] ?? "",
		)?.[1];
		if (!source) continue;
		const release = /^\s+release\s+(.+)$/.exec(lines[i + 1] ?? "")?.[1];
		const origin = /^\s+origin\s+(\S+)\s*$/.exec(lines[i + 2] ?? "")?.[1];
		const allowed =
			release && origin ? sourceOrigin(source, release, origin) : null;
		if (sources.has(source) && sources.get(source) !== allowed) {
			sources.set(source, null);
		} else if (!sources.has(source)) {
			sources.set(source, allowed);
		}
	}
	return sources;
}
