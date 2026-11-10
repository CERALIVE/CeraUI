function omitIncarnation(value: unknown): unknown {
	if (
		typeof value !== "object" ||
		value === null ||
		!("incarnation" in value)
	) {
		return value;
	}
	const { incarnation: _incarnation, ...legacy } = value;
	return legacy;
}

/** Keep unmodified frames by reference so their serialized bytes stay intact. */
export function projectRemoteWifiFrame(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	let projected = payload;
	if ("adapter_mode" in payload) {
		const mode = omitIncarnation(payload.adapter_mode);
		if (mode !== payload.adapter_mode) {
			projected = { ...projected, adapter_mode: mode };
		}
	}
	if (
		"hotspot" in payload &&
		typeof payload.hotspot === "object" &&
		payload.hotspot !== null &&
		"config" in payload.hotspot
	) {
		const config = omitIncarnation(payload.hotspot.config);
		if (config !== payload.hotspot.config) {
			projected = {
				...projected,
				hotspot: { ...payload.hotspot, config },
			};
		}
	}
	return projected;
}

/** Remote status omits local hotspot credentials and radio lifetime tokens. */
export function projectRemoteStatus(payload: unknown): unknown {
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("wifi" in payload) ||
		typeof payload.wifi !== "object" ||
		payload.wifi === null
	) {
		return payload;
	}

	const projectInterface = (iface: unknown): unknown => {
		if (typeof iface !== "object" || iface === null) return iface;
		let projected = iface;
		if ("incarnation" in iface) {
			const { incarnation: _incarnation, ...rest } = iface;
			projected = rest;
		}
		if (
			!("hotspot" in projected) ||
			typeof projected.hotspot !== "object" ||
			projected.hotspot === null ||
			!("password" in projected.hotspot)
		) {
			return projected;
		}
		const { password: _password, ...hotspot } = projected.hotspot;
		return { ...projected, hotspot };
	};

	return {
		...payload,
		wifi: Array.isArray(payload.wifi)
			? payload.wifi.map(projectInterface)
			: Object.fromEntries(
					Object.entries(payload.wifi).map(([id, iface]) => [
						id,
						projectInterface(iface),
					]),
				),
	};
}
