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

/** Authentication with the remote itself still uses remote_key. */
export function projectRemoteConfig(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	if (
		!("ssh_pass" in payload) &&
		!("pairing_secret" in payload) &&
		!("srt_streamid" in payload) &&
		!("relay_streamid_override" in payload)
	) {
		return payload;
	}
	const config = { ...payload };
	Reflect.deleteProperty(config, "ssh_pass");
	Reflect.deleteProperty(config, "pairing_secret");
	Reflect.deleteProperty(config, "srt_streamid");
	Reflect.deleteProperty(config, "relay_streamid_override");
	return config;
}

/** APN credentials belong to the carrier, not the remote management service. */
export function projectRemoteModems(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const projectModem = (modem: unknown): unknown => {
		if (
			typeof modem !== "object" ||
			modem === null ||
			!("config" in modem) ||
			typeof modem.config !== "object" ||
			modem.config === null ||
			(!("username" in modem.config) && !("password" in modem.config))
		) {
			return modem;
		}
		const config = { ...modem.config };
		Reflect.deleteProperty(config, "username");
		Reflect.deleteProperty(config, "password");
		return { ...modem, config };
	};
	return Array.isArray(payload)
		? payload.map(projectModem)
		: Object.fromEntries(
				Object.entries(payload).map(([id, modem]) => [id, projectModem(modem)]),
			);
}

/** Remote status omits local credentials and radio lifetime tokens. */
export function projectRemoteStatus(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const projected =
		"modems" in payload
			? { ...payload, modems: projectRemoteModems(payload.modems) }
			: payload;
	if (
		!("wifi" in payload) ||
		typeof payload.wifi !== "object" ||
		payload.wifi === null
	) {
		return projected;
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
		...projected,
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
