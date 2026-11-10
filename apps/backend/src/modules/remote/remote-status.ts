/** Remote status keeps Wi-Fi diagnostics but never the local hotspot credential. */
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
		if (
			typeof iface !== "object" ||
			iface === null ||
			!("hotspot" in iface) ||
			typeof iface.hotspot !== "object" ||
			iface.hotspot === null ||
			!("password" in iface.hotspot)
		) {
			return iface;
		}
		const { password: _password, ...hotspot } = iface.hotspot;
		return { ...iface, hotspot };
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
