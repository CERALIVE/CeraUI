const persistenceFields = [
	"bond_group_out",
	"bond_opt_in",
	"bond_port_out",
	"bond_rollback_out",
] as const;

/** Keep bond persistence metadata out of the legacy config payload. */
export function projectConfigWire(config: unknown): unknown {
	if (typeof config !== "object" || config === null || Array.isArray(config))
		return config;
	// Legacy WebSocket sends use reference identity to preserve original bytes.
	if (!persistenceFields.some((key) => Object.hasOwn(config, key)))
		return config;
	const wire = { ...config };
	for (const key of persistenceFields) Reflect.deleteProperty(wire, key);
	return wire;
}
