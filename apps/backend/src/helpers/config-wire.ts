/** Keep bond persistence metadata out of the legacy config payload. */
export function projectConfigWire(config: unknown): unknown {
	if (typeof config !== "object" || config === null || Array.isArray(config))
		return config;
	const wire = { ...config };
	for (const key of [
		"bond_group_out",
		"bond_opt_in",
		"bond_port_out",
		"bond_rollback_out",
	])
		Reflect.deleteProperty(wire, key);
	return wire;
}
