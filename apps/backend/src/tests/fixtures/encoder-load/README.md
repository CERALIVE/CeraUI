# Encoder-load source-derived fixtures

These are synthetic readings in the real driver's format, not new board captures.
Grammar was read locally from CERALIVE/rk3588-media-island commit
`e0faa4a24e614c42f75ab28c78ee808baeeaa213`:

- `drivers/video/rockchip/mpp/mpp_telemetry.h`, `mpp_telemetry_format_load`:
  `%-25s load: %3d.%02d%% utilization: %3d.%02d%%\n`.
- `mpp_service.c`, `mpp_show_device_load`: one row for each populated queue core;
  `mpp_dump_session`: IOVA preamble/ranges, then `session: pid=%d index=%d`,
  ` device: %s`, ` memory: %lu MiB`. `mpp_rkvenc2.c` additionally appends a
  pipe-delimited codec table. Neither IOVAs nor codec strings belong on this wire.
- `mpp_common.c`, `mpp_dev_load_calc`: load uses run-to-reap busy time;
  utilization uses hardware time. Both may exceed 100 for multicore queues.
  Session `pid` is `current->pid` at session creation, not a proven process TGID.
- `mpp_rkvdec2.c`: `rockchip,rkv-decoder-v2` identifies the decoder even when
  the node is named `video-codec`. Tests supply this NUL-separated compatible
  via the same file-read seam as procfs, without an address-to-block table.
- `rga3/rga_debugger.c`, `rga_load_show`: scheduler index/driver string and
  integer load, then a global session table. There is no utilization value or
  session-to-scheduler association in that table.

MPP node spellings follow the driver's `docs/TELEMETRY.md` examples. Values,
session identifiers and order are chosen to distinguish parsing, grouping,
ownership, and the two metrics. Tests read only these repo-local fixtures and
in-memory files; no board, live procfs, or sibling checkout is required.
