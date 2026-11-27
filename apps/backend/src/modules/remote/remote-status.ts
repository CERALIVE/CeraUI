import { projectConfigWire } from "../../helpers/config-wire.ts";

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

/** The local config projection also applies before filtering the remote-only seed. */
export function projectRemoteConfig(payload: unknown): unknown {
	payload = projectConfigWire(payload);
	if (typeof payload !== "object" || payload === null) return payload;
	if (!("pairing_secret" in payload)) return payload;
	const config = { ...payload };
	Reflect.deleteProperty(config, "pairing_secret");
	return config;
}

function omitLocalWifiStatus(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("leaving" in value)) {
		return omitIncarnation(value);
	}
	const { leaving: _leaving, ...status } = value;
	return omitIncarnation(status);
}

/** Remote status retains credentials and omits local radio presentation witnesses. */
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
		wifi: Array.isArray(payload.wifi)
			? payload.wifi.map(omitLocalWifiStatus)
			: Object.fromEntries(
					Object.entries(payload.wifi).map(([id, iface]) => [
						id,
						omitLocalWifiStatus(iface),
					]),
				),
	};
}
