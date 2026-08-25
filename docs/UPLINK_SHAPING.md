# Streaming-first uplink shaping

Status: **[PARTIAL]** — backend controller and kernel-netns proof exist; the image-owned
`ceralive-share.service` teardown backstop and physical saturation drill remain separate
deployment/hardware work.

## Contract

`apps/backend/src/modules/network/uplink-shaper/` consumes the uplink set produced by
`uplink-steering`; it never discovers or expands that set independently. It has two
edge-driven states:

- **idle** — a reserved root `fq_codel` supplies fair queuing and no rate ceiling;
- **streaming** — a two-band `prio` root maps ordinary locally-originated traffic to
  the first tc band (the design's zero-indexed band 0) and a `fw` filter maps only
  `CLIENT_FLOW`-marked traffic to the second tc band. The first band has an
  `fq_codel` child and no rate, ceil, police, or bandwidth token. The client child is
  CAKE with a bandwidth cap when `sch_cake` accepts the generated child qdisc, else
  HTB `rate == ceil` with an `fq_codel` leaf.

The runtime publishes `uplink-shaper`. An available state states `mode` and the
realized `algorithm` (`cake` or `htb-fq_codel`). A failed inventory/apply publishes
`shaper_unavailable` with `priorityDegraded: true`; hotspot/shared-LAN forwarding
continues, honestly unshaped. This failure path never disables todo 9's steering/NAT.

## Adaptive cap

All policy constants live in `SHAPER_CONFIG`. A stream edge starts every shared
uplink at the conservative bootstrap cap before considering a sample. At each 5 s
tick, fresh clean telemetry raises the cap additively; RTT inflation, NAK growth, or
sustained client-qdisc backlog reduces it by 0.7. The result is clamped between the
floor and ceiling. Stale telemetry holds the last cap. The stream-stop edge applies
idle/no-ceiling state even though link telemetry disappears at that same boundary.

`bitrate_bps` remains an observation of current throughput and is deliberately not
treated as a capacity estimate.

## Ownership and recovery

Before the first mutation, every target root is inventoried. The controller may take
over only kernel defaults (`mq`, `fq_codel`, `noqueue`, `pfifo_fast`) or its own
reserved `ca00:` handle. A foreign custom qdisc yields `foreign_qdisc` with zero tc
mutations. The prior default is recorded per interface; removing an interface from
the steering-owned set or stopping the module restores it. Backend restart recovery
recognizes `ca00:` as already owned and uses `replace`. The recorded default is
persisted at `/run/ceralive/uplink-shaper-roots.json`, so backend restart and the
future systemd ExecStop backstop share one restoration input rather than relying
on process memory.

The image's `ceralive-share.service` ExecStop script is the systemd-owned crash/power
backstop and is intentionally not authored in this repository.

## Verification

- Pure golden snapshots cover CAKE, HTB fallback, streaming, and idle command plans.
- Table tests cover AIMD clamps, congestion inputs, starvation resistance, and stale hold.
- Ownership tests cover all recognized defaults, module-owned restart recovery,
  foreign-root refusal, fallback, and restoration order.
- `uplink-shaper-netns.test.ts` issues the generated nft/tc commands under
  `unshare -rn`; forwarded marked traffic increments the capped client leaf while
  unmarked local traffic increments the uncapped local leaf.

The outstanding hardware gate is a shaped-vs-unshaped live-stream saturation run on
a real shared uplink. Automated netns evidence is not hardware evidence.
