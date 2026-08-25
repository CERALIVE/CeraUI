/**
 * Network interface Zod schemas
 */
import { z } from 'zod';

// Accepts dotted-quad IPv4 or a colon-delimited IPv6 hextet string.
export const IP_ADDRESS_REGEX = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;

// A claimed router-mode USB dongle's runtime state, as reported by the device
// image's netns manager (image-building-pipeline `docs/dongle-netns-contract.md`
// §6.1). `slot` is the manager's durable 0..7 slot; `state` is the claim's
// lifecycle. Only the two fields an operator surface needs cross the wire — the
// full metadata record (usb_path, MAC, lease addresses) stays device-side.
export const dongleStateSchema = z.enum(['acquiring', 'up', 'down']);
export type DongleState = z.infer<typeof dongleStateSchema>;

export const dongleMarkerSchema = z.object({
	slot: z.number().int().min(0),
	state: dongleStateSchema,
});
export type DongleMarker = z.infer<typeof dongleMarkerSchema>;

// A USB network interface the device has PROVEN, from its USB descriptors, to be
// a router-mode cellular dongle (Huawei HiLink, ZTE MF79U and relatives): an
// Ethernet tether with no modem control port, carried by hardware with positive
// cellular evidence. It is deliberately independent of the `dongle` marker
// above: that one reports the device image's netns claim, which does not exist
// on every image, while this one only needs the descriptors the kernel already
// publishes — so a dongle is labelled honestly whether or not netns isolation is
// deployed.
//
// The interface NAME is never an input to this classification. Two physically
// distinct HiLink units on this bench ship one factory MAC, so one is named
// `enx0c5b8f279a64` and its twin falls back to `eth1`; a prefix rule would badge
// one and miss the other.
export const routerCellularMarkerSchema = z.object({
	/** The device's own `manufacturer` string descriptor, verbatim. */
	vendor: z.string().min(1),
	/** The device's own `product` string descriptor, verbatim. */
	model: z.string().min(1),
	/** Lowercase `xxxx:xxxx` USB vendor:product — the SKU discriminator. */
	vid_pid: z.string().min(1),
	kind: z.literal('router-cellular'),
	/**
	 * Another router-cellular device present on this host reports the SAME
	 * `vid_pid`. Same model ⇒ same factory LAN subnet and same factory DHCP
	 * offer, so both lease the host colliding addresses. MEASURED from the
	 * devices actually attached, never assumed from the model.
	 */
	duplicate_model: z.boolean(),
	/**
	 * The device's own serial, published ONLY alongside `duplicate_model: true`.
	 *
	 * Two units of one SKU are indistinguishable by vendor, model and `vid_pid`
	 * alike, so this is the only fact that separates them on screen. Absent for a
	 * lone device (nothing to separate it from) and for a device that publishes
	 * no serial of its own — never fabricated. Additive-optional.
	 */
	serial: z.string().min(1).optional(),
});
export type RouterCellularMarker = z.infer<typeof routerCellularMarkerSchema>;

// The interface is an MM-managed modem's OWN data function, classified from the
// same USB descriptors. A modem whose data path is RNDIS gets a MAC-derived
// `enx…` name, so no ifname prefix can recognise it and it otherwise renders as
// a second, unexplained adapter for a device the Cellular section already owns.
export const usbModemNetMarkerSchema = z.object({
	/** Operator-facing vendor, resolved exactly as a router dongle's is. */
	vendor: z.string().min(1),
	/** Operator-facing model, resolved exactly as a router dongle's is. */
	model: z.string().min(1),
	/** Lowercase `xxxx:xxxx` USB vendor:product — the SKU discriminator. */
	vid_pid: z.string().min(1),
	kind: z.literal('modem-net'),
});
export type UsbModemNetMarker = z.infer<typeof usbModemNetMarkerSchema>;

// The operator's declared ROLE for an ETHERNET port.
//
// `uplink` is the DEFAULT and is today's behaviour verbatim: the port is an
// ordinary bonding candidate. `shared-lan` hands the port to NetworkManager's
// `ipv4.method shared`, so the device serves DHCP/DNS to LAN clients on it —
// which makes it structurally unusable as an uplink, so the device excludes it
// from the bond and from the connectivity election.
//
// It is an OPERATOR DECLARATION about a wired socket, never a classification of
// what the device IS. That is the reason it may be keyed on the interface name
// (see the `eth_roles` config key), unlike every marker above it.
export const ethernetRoleSchema = z.enum(['uplink', 'shared-lan']);
export type EthernetRole = z.infer<typeof ethernetRoleSchema>;

// Network interface entry schema
export const netifEntrySchema = z.object({
	ip: z.string().optional(),
	tp: z.number(),
	enabled: z.boolean(),
	error: z.string().optional(),
	mac: z.string().optional(),
	// Informational CIDR shared with other enabled interfaces; not an error (the
	// AP/hotspot and lone interfaces are absent). Additive-optional.
	same_subnet_group: z.string().optional(),
	// Real-device diagnostic for a bonded (modem/wifi) interface, additive-optional
	// and TRISTATE. `true` = missing its SRTLA source-routing policy rule or its
	// table's default route; `false` = the check ran and found neither missing;
	// ABSENT = the check could not run (dev host, spawn failure) and carries no
	// verdict — absence is "no news", never an all-clear.
	policy_route_missing: z.boolean().optional(),
	// Measured interface throughput in BITS PER SECOND over the last sample
	// window. Distinct from `tp`, which is a raw TX byte delta over an unstated
	// interval and therefore cannot be rendered as a rate. Additive-optional.
	tx_bps: z.number().optional(),
	rx_bps: z.number().optional(),
	// RETRACTABLE, not latch-prone: an object marks this row as a claimed
	// dongle's host veth, an explicit `null` RETRACTS that claim for one frame,
	// and plain absence means "not a dongle" only for a row never marked.
	// Publishing it true-only would repeat the `policy_route_missing` latch —
	// the ingestion merge preserves an omitted optional field, so a marker could
	// be raised and never lowered.
	dongle: dongleMarkerSchema.nullable().optional(),
	// RETRACTABLE on the same terms as `dongle`, and for the same reason: the
	// ingestion merge preserves an omitted optional field, so a true-only marker
	// could be raised and never lowered. An explicit `null` clears the claim for
	// one frame WITHOUT dropping the row — unlike `dongle`, whose retraction is
	// the row's final frame, this device stays present and merely stops being
	// classified.
	router_cellular: routerCellularMarkerSchema.nullable().optional(),
	// RETRACTABLE on exactly the terms `router_cellular` is, and for the same
	// latch reason. An explicit `null` clears the claim for one frame and KEEPS
	// the row — the interface is still there, it merely stopped classifying.
	usb_modem_net: usbModemNetMarkerSchema.nullable().optional(),
	// Published EXPLICITLY on every ethernet row, including `uplink` — never
	// present-only-when-shared. The ingestion merge preserves an omitted optional
	// field, so a role published only in one direction could be raised and never
	// lowered (the `policy_route_missing` latch, exactly), and a flip back to
	// `uplink` would leave the operator's own row claiming `shared-lan` forever.
	// ABSENT therefore means "not an ethernet port, or an older backend", and is
	// never read as `uplink`.
	ethRole: ethernetRoleSchema.optional(),
});
export type NetifEntry = z.infer<typeof netifEntrySchema>;

// Network interfaces message schema
export const netifMessageSchema = z.record(z.string(), netifEntrySchema);
export type NetifMessage = z.infer<typeof netifMessageSchema>;

export const uplinkKindSchema = z.enum(['ethernet', 'wifi', 'cellular', 'other']);
export const uplinkHealthStateSchema = z.enum(['up', 'degraded', 'down']);
export const uplinkHealthReasonSchema = z.enum([
	'probe_failed',
	'captive_portal',
	'passive_congestion',
	'definitive_loss',
]);
export const uplinkHealthRecordSchema = z.object({
	iface: z.string().min(1),
	kind: uplinkKindSchema,
	state: uplinkHealthStateSchema,
	reason: uplinkHealthReasonSchema.optional(),
	weight: z.number().min(0).max(100),
	lastTransition: z.number().nonnegative(),
	staleAt: z.number().nonnegative(),
	probes: z.object({
		successes: z.number().int().nonnegative(),
		failures: z.number().int().nonnegative(),
	}),
	signals: z.object({
		activeAt: z.number().nonnegative().optional(),
		passiveAt: z.number().nonnegative().optional(),
	}),
});
export const uplinksMessageSchema = z.array(uplinkHealthRecordSchema);
export type UplinkHealthRecord = z.infer<typeof uplinkHealthRecordSchema>;
export type UplinksMessage = z.infer<typeof uplinksMessageSchema>;

export const steeringUnavailableReasonSchema = z.enum([
	'bond_candidate_client_zone',
	'mark_collision',
	'overlapping_subnet',
	'policy_route_missing',
	'ruleset_publish_failed',
	'ruleset_reload_failed',
]);
export type SteeringUnavailableReason = z.infer<typeof steeringUnavailableReasonSchema>;

export const uplinkSteeringStatusSchema = z.discriminatedUnion('state', [
	z.object({ state: z.literal('available') }),
	z.object({
		state: z.literal('steering_unavailable'),
		reason: steeringUnavailableReasonSchema,
		detail: z.string().min(1).optional(),
	}),
]);
export type UplinkSteeringStatus = z.infer<typeof uplinkSteeringStatusSchema>;

export const uplinkShaperStatusSchema = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('available'),
		mode: z.enum(['idle', 'streaming']),
		algorithm: z.enum(['cake', 'htb-fq_codel']),
	}),
	z.object({
		state: z.literal('shaper_unavailable'),
		reason: z.enum(['foreign_qdisc', 'qdisc_inventory_failed', 'tc_apply_failed']),
		priorityDegraded: z.literal(true),
		detail: z.string().min(1).optional(),
	}),
]);
export type UplinkShaperStatus = z.infer<typeof uplinkShaperStatusSchema>;

/*
  SHARING-COEXISTENCE DIAGNOSTICS — read-only, and TRI-STATE on purpose.

  The device shares its uplinks with hotspot / shared-LAN clients through TWO
  independent NAT layers that are designed to coexist: NetworkManager's own
  shared-mode masquerade (the working floor, kept alive by the image's
  `firewall-backend=nftables` pin) and CeraUI's per-uplink, `CLIENT_FLOW`-scoped
  masquerade inside `inet ceralive_share`. Four things can be checked from the
  outside without touching either, and every one of them has an answer the
  device genuinely cannot establish — a pre-pin image, an unreadable ruleset, a
  shared profile whose interface has not leased its address yet.

  So each check is `ok` | `degraded` | `unknown`, and `unknown` is EXPLICIT
  rather than an omitted field: a consumer merge preserves an omitted optional,
  so a check that could be raised and never lowered is the `policy_route_missing`
  latch all over again. `degraded` is never a failure — nothing here gates a
  stream, an interface, or a mutation; it is an honest amber verdict about a
  coexistence contract.
*/
export const sharingDiagStateSchema = z.enum(['ok', 'degraded', 'unknown']);
export type SharingDiagState = z.infer<typeof sharingDiagStateSchema>;

// Each member names a different thing an operator (or a maintainer) does about
// it, so none is collapsible. `firewall_backend_unpinned` in particular is the
// PRE-PIN image — a normal, non-error state — and must never read as a mismatch.
export const sharingDiagReasonSchema = z.enum([
	'firewall_backend_unpinned',
	'firewall_backend_mismatch',
	'steering_rule_shadows_source_route',
	'steering_rule_priority_drift',
	'shared_nat_missing',
	'shared_nat_duplicated',
	'foreign_table_modified',
]);
export type SharingDiagReason = z.infer<typeof sharingDiagReasonSchema>;

export const sharingDiagCheckSchema = z.object({
	state: sharingDiagStateSchema,
	reason: sharingDiagReasonSchema.optional(),
	detail: z.string().min(1).optional(),
});
export type SharingDiagCheck = z.infer<typeof sharingDiagCheckSchema>;

// All four checks are ALWAYS present. The rollup can never claim `ok` while a
// check is withheld: `degraded` outranks `unknown` outranks `ok`.
export const sharingDiagSchema = z.object({
	state: sharingDiagStateSchema,
	checkedAt: z.number().nonnegative(),
	firewallBackend: sharingDiagCheckSchema,
	steeringRules: sharingDiagCheckSchema,
	sharedNat: sharingDiagCheckSchema,
	foreignTables: sharingDiagCheckSchema,
});
export type SharingDiag = z.infer<typeof sharingDiagSchema>;

export const uplinkFlowsResetEventSchema = z.object({
	iface: z.string().min(1),
	linkId: z.string().min(1),
});
export type UplinkFlowsResetEvent = z.infer<typeof uplinkFlowsResetEventSchema>;

// Network interface config input schema
export const netifConfigInputSchema = z.object({
	name: z.string(),
	ip: z.string().regex(IP_ADDRESS_REGEX, 'Invalid IP address format').optional(),
	enabled: z.boolean(),
});
export type NetifConfigInput = z.infer<typeof netifConfigInputSchema>;

// Why `network.configure` applied NOTHING.
//
// `stale_address` is the concurrency guard: the echoed address no longer matches
// the one the device observes, so the request describes an interface state that
// has already moved and applying it would act on the operator's stale view. It
// used to be answered with `{success:true}`, which reported a discarded save —
// including a discarded bond toggle — as a successful one.
export const netifConfigErrorSchema = z.enum([
	'unknown_interface',
	'stale_address',
	'enable_refused',
	'disable_all_refused',
]);
export type NetifConfigError = z.infer<typeof netifConfigErrorSchema>;

// Network interface config output schema
export const netifConfigOutputSchema = z.object({
	success: z.boolean(),
	applied: netifConfigInputSchema.partial().optional(),
	error: netifConfigErrorSchema.optional(),
});
export type NetifConfigOutput = z.infer<typeof netifConfigOutputSchema>;

export const setEthernetRoleInputSchema = z
	.object({
		name: z.string().min(1),
		role: ethernetRoleSchema,
	})
	.strict();
export type SetEthernetRoleInput = z.infer<typeof setEthernetRoleInputSchema>;

// Each member names a different thing the operator can do about it, so none is
// collapsible: `not_ethernet` is a permanent property of the interface,
// `unknown_interface` clears when the link comes back, `apply_failed` is worth
// retrying, and `unavailable_in_emulated_mode` is a property of the host.
export const ethernetRoleErrorSchema = z.enum([
	'unknown_interface',
	'not_ethernet',
	'no_connection',
	'apply_failed',
	'unavailable_in_emulated_mode',
]);
export type EthernetRoleError = z.infer<typeof ethernetRoleErrorSchema>;

export const setEthernetRoleOutputSchema = z.object({
	success: z.boolean(),
	applied: ethernetRoleSchema.optional(),
	error: ethernetRoleErrorSchema.optional(),
});
export type SetEthernetRoleOutput = z.infer<typeof setEthernetRoleOutputSchema>;

// The pending/terminal frame for a role transition, broadcast under the
// `eth_role` message type. `pending` promises a later terminal frame; it never
// claims the port has reached the role.
export const ethernetRoleOutcomeSchema = z.object({
	name: z.string().min(1),
	role: ethernetRoleSchema.optional(),
	pending: z.literal(true).optional(),
	success: z.literal(true).optional(),
	error: ethernetRoleErrorSchema.optional(),
});
export type EthernetRoleOutcome = z.infer<typeof ethernetRoleOutcomeSchema>;

export const ethernetRoleMessageSchema = z.object({
	eth_role: ethernetRoleOutcomeSchema,
});
export type EthernetRoleMessage = z.infer<typeof ethernetRoleMessageSchema>;

// Returned by network.setIngestEnabled on a dev/emulated (non-mock) host, where
// the systemd gateway units do not exist so the toggle is a no-op.
export const NETWORK_INGEST_UNAVAILABLE_ERROR = 'network_ingest_unavailable_in_emulated_mode';

export const networkIngestProtocolInputSchema = z.enum(['rtmp', 'srt']);
export type NetworkIngestProtocolInput = z.infer<typeof networkIngestProtocolInputSchema>;

// Operator enable/disable of a LAN RTMP/SRT ingest gateway (desired state).
export const setIngestEnabledInputSchema = z.object({
	protocol: networkIngestProtocolInputSchema,
	enabled: z.boolean(),
});
export type SetIngestEnabledInput = z.infer<typeof setIngestEnabledInputSchema>;

export const setIngestEnabledOutputSchema = z.object({
	success: z.boolean(),
	applied: setIngestEnabledInputSchema.optional(),
	error: z.string().optional(),
});
export type SetIngestEnabledOutput = z.infer<typeof setIngestEnabledOutputSchema>;
