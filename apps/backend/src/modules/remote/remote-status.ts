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

	return {
		...payload,
		wifi: Object.fromEntries(
			Object.entries(payload.wifi).map(([id, iface]: [string, unknown]) => {
				if (
					typeof iface !== "object" ||
					iface === null ||
					!("hotspot" in iface) ||
					typeof iface.hotspot !== "object" ||
					iface.hotspot === null ||
					!("password" in iface.hotspot)
				) {
					return [id, iface];
				}
				const { password: _password, ...hotspot } = iface.hotspot;
				return [id, { ...iface, hotspot }];
			}),
		),
	};
}
