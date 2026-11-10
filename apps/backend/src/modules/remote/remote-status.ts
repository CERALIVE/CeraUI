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
