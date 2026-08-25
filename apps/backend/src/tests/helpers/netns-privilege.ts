export interface NetnsProbeResult {
	readonly ok: boolean;
	readonly error: string;
}

export type NetnsProbe = (argv: readonly string[]) => Promise<NetnsProbeResult>;

class NetnsUnavailableError extends Error {
	constructor(
		probePath: string,
		direct: NetnsProbeResult,
		elevated: NetnsProbeResult,
	) {
		super(
			`network namespaces unavailable for checkout fixture ${probePath}: direct=${direct.error}; sudo=${elevated.error}. Enable unprivileged user namespaces with checkout access or configure passwordless sudo for unshare.`,
		);
		this.name = "NetnsUnavailableError";
	}
}

async function runNetnsProbe(
	argv: readonly string[],
): Promise<NetnsProbeResult> {
	try {
		const process = Bun.spawn([...argv], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const error = new Response(process.stderr).text();
		return {
			ok: (await process.exited) === 0,
			error: (await error).trim(),
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function netnsPrivilegePrefix(
	probePath: string,
	probe: NetnsProbe = runNetnsProbe,
): Promise<readonly string[]> {
	const direct = await probe(["unshare", "-rn", "cat", probePath]);
	if (direct.ok) return [];

	const elevated = await probe([
		"sudo",
		"-n",
		"unshare",
		"-rn",
		"cat",
		probePath,
	]);
	if (elevated.ok) return ["sudo", "-n"];

	throw new NetnsUnavailableError(probePath, direct, elevated);
}
