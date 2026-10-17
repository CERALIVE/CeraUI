export type AptClientPaths = { readonly cert: string; readonly key: string };
export type FileProbe = (path: string) => boolean | Promise<boolean>;

const CREDENTIAL_DIRS = [
	"/usr/share/ceralive/apt-credentials",
	"/etc/apt/certs",
] as const;

export async function aptClientPaths(
	fileExists: FileProbe = (path) => Bun.file(path).exists(),
): Promise<AptClientPaths | undefined> {
	for (const dir of CREDENTIAL_DIRS) {
		const cert = `${dir}/client.crt`;
		const key = `${dir}/client.key`;
		if ((await fileExists(cert)) && (await fileExists(key)))
			return { cert, key };
	}
	return undefined;
}

export async function aptClientTlsFor(
	url: string | URL,
	fileExists?: FileProbe,
): Promise<{ tls: { cert: Bun.BunFile; key: Bun.BunFile } } | undefined> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "apt.ceralive.tv")
		return undefined;
	const paths = await aptClientPaths(fileExists);
	return paths
		? { tls: { cert: Bun.file(paths.cert), key: Bun.file(paths.key) } }
		: undefined;
}
