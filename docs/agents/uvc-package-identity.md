<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## UVC package identity

`gstreamer1.0-libuvcsrc` from `gstlibuvcsrc` is classified as an app-layer package.
It provides/replaces `gstreamer1.0-libuvch264src`; package metadata and element
factory names are separate contracts. Canonical `libuvcsrc` and both aliases
(`libuvch264src`, `libuvch26xsrc`) share one implementation. CeraUI still consumes
engine-owned source IDs and does not instantiate capture factories itself.
