import { mkdtemp, readdir, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../../helpers/spawn-policy.ts";
import {
	type AptClientPaths,
	aptClientPaths,
} from "../../addons/apt-client-tls.ts";
import { getModems } from "../../modems/modems-state.ts";
import { deviceBindingArgs } from "../../network/device-bound-probe.ts";
import {
	getNetifErrorMsg,
	getNetworkInterfaces,
	NETIF_ERR_DUPIPV4,
} from "../../network/network-interfaces.ts";
import {
	getModemNetMarker,
	getRouterCellularMarker,
} from "../../network/router-cellular-scan.ts";
import {
	classifyHttp,
	classifyTransfer,
	type DebianSource,
	discoverCandidates,
	type Family,
	type HostProbe,
	type ProbeState,
	parseDebianSources,
	rankTransports,
	type TransportSample,
	type TransportSelection,
} from "./core.ts";

const SOURCE_DIR = "/etc/apt/sources.list.d";
const MARKER = "\n<<<update-probe>>>";
const TIMEOUT_MS = 4_500;

export type UpdateProfile = {
	readonly profile: "apt" | "os";
	readonly board: string;
	readonly channel: "stable" | "beta" | "drill";
};
export type UpdateTransportDeps = {
	listIfnames: () => string[];
	readSources: () => Promise<string>;
	credentials: () => Promise<AptClientPaths | undefined>;
	run: (argv: string[]) => Promise<SpawnWithTimeoutResult>;
	mmIfnames: () => string[];
	routerIfnames: () => string[];
	dongleIfnames: () => string[];
};

async function readSources(): Promise<string> {
	const names = (await readdir(SOURCE_DIR))
		.filter((name) => /\.(?:sources|list)$/.test(name))
		.sort();
	return (
		await Promise.all(
			names.map((name) => Bun.file(join(SOURCE_DIR, name)).text()),
		)
	).join("\n\n");
}

export const defaultUpdateTransportDeps: UpdateTransportDeps = {
	listIfnames: () =>
		Object.entries(getNetworkInterfaces())
			.filter(
				([, entry]) =>
					getNetifErrorMsg({
						...entry,
						error: entry.error & ~NETIF_ERR_DUPIPV4,
					}) === undefined,
			)
			.map(([ifname]) => ifname),
	readSources,
	credentials: aptClientPaths,
	run: (argv) => spawnWithTimeout(argv, { timeoutMs: TIMEOUT_MS }),
	mmIfnames: () =>
		Object.values(getModems())
			.map(({ ifname }) => ifname)
			.filter(Boolean),
	routerIfnames: () =>
		Object.keys(getNetworkInterfaces()).filter(
			(ifname) =>
				getRouterCellularMarker(ifname) !== undefined ||
				getModemNetMarker(ifname) !== undefined,
		),
	dongleIfnames: () =>
		Object.keys(getNetworkInterfaces()).filter(
			(ifname) => getRouterCellularMarker(ifname) !== undefined,
		),
};

function failure(result: SpawnWithTimeoutResult): ProbeState {
	switch (result.exitCode) {
		case 6:
			return "dns-failed";
		case 7:
			return "no-route";
		case 28:
			return "blocked";
		case 35:
		case 51:
		case 60:
			return "tls-error";
		case 58:
			return "credentials-invalid";
		default:
			return "probe-unavailable";
	}
}

function parseResponse(result: SpawnWithTimeoutResult): {
	code: number;
	body: string;
	latencyMs: number;
} {
	const at = result.stdout.lastIndexOf(MARKER);
	if (at < 0) return { code: 0, body: result.stdout, latencyMs: TIMEOUT_MS };
	const [code, seconds] = result.stdout
		.slice(at + MARKER.length)
		.trim()
		.split(/\s+/);
	return {
		code: Number(code),
		body: result.stdout.slice(0, at),
		latencyMs: Math.round(Number(seconds) * 1000) || 0,
	};
}

function failureFromError(error: unknown): ProbeState {
	if (
		error instanceof Error &&
		/not found|ENOENT|Executable|invalid argument/i.test(error.message)
	)
		return "probe-unavailable";
	return "blocked";
}

async function resolvedAddress(
	host: string,
	ifname: string,
	family: Family,
	deps: UpdateTransportDeps,
): Promise<string | ProbeState> {
	argMatch(/^[a-zA-Z0-9.-]+$/, host);
	try {
		const result = await deps.run([
			"resolvectl",
			family === 4 ? "-4" : "-6",
			"-i",
			argMatch(ID_RE, ifname),
			"query",
			host,
		]);
		if (result.exitCode !== 0)
			return result.exitCode === 1 ? "dns-failed" : failure(result);
		for (const line of result.stdout.split(/\r?\n/)) {
			const address = line.startsWith(`${host}:`)
				? line
						.slice(host.length + 1)
						.trim()
						.split(/\s+/)[0]
				: undefined;
			if (address && isIP(address) === family) return address;
		}
		return "dns-failed";
	} catch (error) {
		return failureFromError(error);
	}
}

async function curl(
	url: string,
	ifname: string,
	family: Family,
	method: "GET" | "HEAD",
	deps: UpdateTransportDeps,
	cert?: AptClientPaths,
): Promise<{
	state: ProbeState;
	code: number;
	body: string;
	latencyMs: number;
}> {
	const parsed = new URL(url);
	const address = await resolvedAddress(parsed.hostname, ifname, family, deps);
	if (isIP(address) !== family)
		return {
			state: address as ProbeState,
			code: 0,
			body: "",
			latencyMs: TIMEOUT_MS,
		};
	const target = family === 6 ? `[${address}]` : address;
	const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
	const argv = [
		"curl",
		"-q",
		family === 4 ? "-4" : "-6",
		...deviceBindingArgs(ifname),
		"--noproxy",
		"*",
		"--resolve",
		`${parsed.hostname}:${port}:${target}`,
		"--connect-timeout",
		"2",
		"--max-time",
		"3",
		"--max-filesize",
		"2097152",
		"-sS",
		...(method === "HEAD" ? ["-I"] : []),
		...(cert ? ["--cert", cert.cert, "--key", cert.key] : []),
		"-w",
		`${MARKER}%{http_code} %{time_total}`,
		url,
	];
	try {
		const result = await deps.run(argv);
		if (result.exitCode !== 0)
			return {
				state: failure(result),
				code: 0,
				body: "",
				latencyMs: TIMEOUT_MS,
			};
		const response = parseResponse(result);
		return {
			state:
				response.code >= 200 && response.code < 300 ? "clear" : "captive-http",
			...response,
		};
	} catch (error) {
		return {
			state: failureFromError(error),
			code: 0,
			body: "",
			latencyMs: TIMEOUT_MS,
		};
	}
}

async function endpoint(
	host: "apt.ceralive.tv" | "images.ceralive.tv",
	ifname: string,
	family: Family,
	profile: UpdateProfile,
	deps: UpdateTransportDeps,
	credentials?: AptClientPaths,
): Promise<HostProbe> {
	const httpProbe = await curl(
		`http://${host}/generate_204`,
		ifname,
		family,
		"GET",
		deps,
	);
	const captive =
		httpProbe.state === "captive-http" ||
		(httpProbe.state === "clear" &&
			classifyHttp(httpProbe.code, httpProbe.body) === "captive-http");
	if (httpProbe.state !== "clear" && !captive)
		return { host, state: httpProbe.state, latencyMs: httpProbe.latencyMs };
	if (host === "apt.ceralive.tv" && credentials) {
		try {
			const certificate = await deps.run([
				"openssl",
				"x509",
				"-checkend",
				"0",
				"-noout",
				"-in",
				argMatch(/^\/[\w./-]+$/, credentials.cert),
			]);
			if (certificate.exitCode !== 0)
				return {
					host,
					state: "credentials-invalid",
					latencyMs: httpProbe.latencyMs,
				};
		} catch (error) {
			return {
				host,
				state: failureFromError(error),
				latencyMs: httpProbe.latencyMs,
			};
		}
	}
	const secureUrl =
		host === "apt.ceralive.tv"
			? `https://${host}/__tls-probe`
			: `https://${host}/channels/${encodeURIComponent(profile.channel)}/${encodeURIComponent(profile.board)}.json.sig`;
	const secure = await curl(
		secureUrl,
		ifname,
		family,
		host === "apt.ceralive.tv" ? "GET" : "HEAD",
		deps,
		host === "apt.ceralive.tv" ? credentials : undefined,
	);
	let state: ProbeState = secure.state;
	if (secure.state === "tls-error") state = classifyTransfer("tls", captive);
	else if (secure.state === "clear" && host === "apt.ceralive.tv") {
		try {
			const body: unknown = JSON.parse(secure.body);
			state =
				typeof body === "object" &&
				body !== null &&
				"certVerified" in body &&
				body.certVerified === true
					? "clear"
					: "credentials-invalid";
		} catch {
			state = "probe-unavailable";
		}
	} else if (secure.state === "clear" && secure.code !== 200)
		state = "no-route";
	if (captive && state === "clear") state = "captive-http";
	return { host, state, latencyMs: httpProbe.latencyMs + secure.latencyMs };
}

async function debian(
	source: DebianSource,
	ifname: string,
	family: Family,
	deps: UpdateTransportDeps,
): Promise<HostProbe> {
	if (!source.keyring)
		return { host: source.url, state: "tampered", latencyMs: 0 };
	const response = await curl(source.url, ifname, family, "GET", deps);
	if (response.state !== "clear" || response.code !== 200)
		return {
			host: source.url,
			state: response.state === "clear" ? "no-route" : response.state,
			latencyMs: response.latencyMs,
		};
	const dir = await mkdtemp(join(tmpdir(), "ceraui-update-index-"));
	try {
		const inRelease = join(dir, "InRelease");
		await Bun.write(inRelease, response.body);
		const verified = await deps.run([
			"gpgv",
			"--keyring",
			argMatch(/^\/[\w./-]+$/, source.keyring),
			inRelease,
		]);
		return {
			host: source.url,
			state: verified.exitCode === 0 ? "clear" : "tampered",
			latencyMs: response.latencyMs,
		};
	} catch (error) {
		return {
			host: source.url,
			state: failureFromError(error),
			latencyMs: response.latencyMs,
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function selectUpdateTransport(
	profile: UpdateProfile,
	deps: UpdateTransportDeps = defaultUpdateTransportDeps,
): Promise<TransportSelection> {
	argMatch(ID_RE, profile.board);
	let nmcli: SpawnWithTimeoutResult;
	try {
		nmcli = await deps.run([
			"nmcli",
			"-t",
			"-f",
			"GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.METERED",
			"device",
			"show",
		]);
	} catch {
		return rankTransports([]);
	}
	if (nmcli.exitCode !== 0) return rankTransports([]);
	const candidates = discoverCandidates(
		deps.listIfnames(),
		nmcli.stdout,
		deps.mmIfnames(),
		deps.routerIfnames(),
		deps.dongleIfnames(),
	);
	const sources =
		profile.profile === "apt"
			? parseDebianSources(await deps.readSources())
			: [];
	if (profile.profile === "apt" && sources.length === 0)
		return rankTransports([]);
	const credentials =
		profile.profile === "apt" ? await deps.credentials() : undefined;
	// Live verification against the Todo-12-deployed apt.ceralive.tv is deferred; fixture contracts are the current evidence.
	const samples: TransportSample[] = await Promise.all(
		candidates.flatMap((candidate) =>
			([4, 6] as const).map(async (family) => ({
				candidate,
				family,
				hosts:
					profile.profile === "apt"
						? [
								await endpoint(
									"apt.ceralive.tv",
									candidate.ifname,
									family,
									profile,
									deps,
									credentials,
								),
								...(await Promise.all(
									sources.map((source) =>
										debian(source, candidate.ifname, family, deps),
									),
								)),
							]
						: [
								await endpoint(
									"images.ceralive.tv",
									candidate.ifname,
									family,
									profile,
									deps,
								),
							],
			})),
		),
	);
	return rankTransports(samples);
}
