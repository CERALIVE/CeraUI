import {
	ATTEMPT_SCOPED_START_FEATURE,
	type CancelStart,
	type CerastreamClient,
	CerastreamConnectionError,
	CerastreamRpcError,
	compositionLayoutSchema,
	MIC_ROUTE_CHECK_FEATURE,
	RPC_ERROR_NUMERIC,
	type RpcErrorCode,
	rpcErrorCodeSchema,
	type StartParams,
} from "@ceralive/cerastream";

const codes = rpcErrorCodeSchema.enum;

export function hasStartRpcCode(error: unknown, code: RpcErrorCode): boolean {
	return (
		error instanceof CerastreamRpcError &&
		(error.dataCode === undefined
			? error.code === RPC_ERROR_NUMERIC[code]
			: error.dataCode === code)
	);
}

export async function readLaunchCapabilities(client: CerastreamClient) {
	// Known older schemas predate Prepare/Cancel; preserve their launch traffic.
	// A newer or unrecognized version still needs affirmative socket evidence.
	if (Bun.semver.satisfies(client.hello.schema_version, "<0.25.0"))
		return { scoped: false, micRouteCheck: false, audioBackend: undefined };
	try {
		const { features, audio_backends } = await client.getCapabilities();
		return {
			scoped: features?.includes(ATTEMPT_SCOPED_START_FEATURE) === true,
			micRouteCheck: features?.includes(MIC_ROUTE_CHECK_FEATURE) === true,
			audioBackend: audio_backends?.active,
		};
	} catch (error) {
		throw new CerastreamConnectionError(
			"Could not confirm streaming engine capabilities",
			error,
		);
	}
}

export async function cancelScopedStart(
	connect: () => Promise<CerastreamClient>,
	attempt: CancelStart,
): Promise<void> {
	const client = await connect();
	try {
		if ((await readLaunchCapabilities(client)).scoped)
			await client.cancelStart(attempt);
	} catch (error) {
		if (!hasStartRpcCode(error, codes["cerastream.state.not_owner"]))
			throw error;
	} finally {
		await client.close();
	}
}

export function startRefusedBeforeAdmission(
	error: unknown,
	params: StartParams,
	schemaVersion: string,
): boolean {
	if (
		hasStartRpcCode(error, codes["cerastream.state.already_streaming"]) ||
		hasStartRpcCode(error, codes["cerastream.audio.device_not_found"])
	)
		return true;
	if (!hasStartRpcCode(error, codes["cerastream.params.invalid"])) return false;
	// Wire decode and the two audited geometry shapes precede admission.
	if (params.bitrate.max_bitrate > 0xffff_ffff) return true;
	if (
		schemaVersion !== "0.24.0" &&
		schemaVersion !== "0.25.0" &&
		schemaVersion !== "0.26.0" &&
		schemaVersion !== "0.27.0"
	)
		return false;
	const composition = params.composition;
	return (
		composition !== undefined &&
		(composition.layout === compositionLayoutSchema.enum.custom) !==
			(composition.rect !== undefined)
	);
}

export function scopedStartRefused(error: unknown): boolean {
	return (
		hasStartRpcCode(error, codes["cerastream.state.not_owner"]) ||
		hasStartRpcCode(error, codes["cerastream.state.start_cancelled"])
	);
}
