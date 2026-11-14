import {
	CerastreamRpcError,
	COMPOSITION_FEATURE,
	COMPOSITION_RECT_MIN,
	type GetCapabilitiesResult,
	type ListDevicesResult,
	RPC_ERROR_NUMERIC,
	type StartParams,
} from "@ceralive/cerastream";

export function mockParamsInvalid(message: string): CerastreamRpcError {
	return new CerastreamRpcError(
		-32602,
		`invalid params: ${message}`,
		"cerastream.params.invalid",
		null,
		{ code: "cerastream.params.invalid" },
	);
}

function secondaryUnavailable(id: string): CerastreamRpcError {
	return new CerastreamRpcError(
		-32602,
		`invalid params: secondary-unavailable: capture input '${id}' is not available`,
		"cerastream.params.invalid",
		null,
		{
			code: "cerastream.params.invalid",
			capture_causes: [{ device: id, cause: "secondary-unavailable" }],
		},
	);
}

/** Native composition admission, returning the session's resolved primary identity. */
export function validateMockComposition(
	params: Pick<StartParams, "composition" | "input_id" | "video_passthrough">,
	caps: GetCapabilitiesResult,
	devices: ListDevicesResult["devices"],
): string | null {
	const config = params.composition;
	if (!config) return null;
	if (config.layout === "custom") {
		const rect = config.rect;
		if (rect === undefined)
			throw mockParamsInvalid(
				"composition-rect-missing: custom layout requires rect",
			);
		if (
			Object.values(rect).some(
				(value) => !Number.isFinite(value) || value < 0,
			) ||
			rect.x + rect.width > 1 ||
			rect.y + rect.height > 1 ||
			rect.width < COMPOSITION_RECT_MIN ||
			rect.height < COMPOSITION_RECT_MIN
		) {
			throw mockParamsInvalid(
				"composition-rect-range: rect must fit the frame with sides at least 0.125",
			);
		}
	} else if (config.rect !== undefined) {
		throw mockParamsInvalid(
			"composition-rect-unexpected: preset layouts do not accept rect",
		);
	}
	if (!caps.features?.includes(COMPOSITION_FEATURE)) {
		throw new CerastreamRpcError(
			RPC_ERROR_NUMERIC["cerastream.params.invalid"],
			"invalid params: composition-unsupported: rgacompositor did not pass its READY backend trial",
			"cerastream.params.invalid",
			null,
			{
				code: "cerastream.params.invalid",
				capture_causes: [
					{ device: "composition", cause: "composition-unsupported" },
				],
			},
		);
	}
	// Rust str::trim uses Unicode White_Space, which differs from JavaScript trim.
	if (/^\p{White_Space}*$/u.test(config.secondary_input_id))
		throw secondaryUnavailable(config.secondary_input_id);
	if (
		config.alpha !== undefined &&
		(!Number.isFinite(config.alpha) || config.alpha < 0 || config.alpha > 1)
	) {
		throw mockParamsInvalid(
			"composition alpha must be finite and between 0 and 1",
		);
	}
	const captures = devices.filter((device) => device.media_class === "video");
	if (!captures.some((device) => device.input_id === config.secondary_input_id))
		throw secondaryUnavailable(config.secondary_input_id);
	let primary: string;
	if (params.input_id !== undefined) {
		if (params.input_id === config.secondary_input_id)
			throw secondaryUnavailable(config.secondary_input_id);
		if (!captures.some((device) => device.input_id === params.input_id)) {
			throw new CerastreamRpcError(
				RPC_ERROR_NUMERIC["cerastream.device.not_found"],
				`device not found: ${params.input_id}`,
				"cerastream.device.not_found",
				null,
				{ code: "cerastream.device.not_found" },
			);
		}
		primary = params.input_id;
	} else {
		const selected = captures.find(
			(device) => device.input_id !== config.secondary_input_id,
		);
		if (!selected) throw secondaryUnavailable(config.secondary_input_id);
		primary = selected.input_id;
	}
	if (params.video_passthrough === "force")
		throw mockParamsInvalid(
			"video_passthrough=force cannot be combined with composition",
		);
	return primary;
}
