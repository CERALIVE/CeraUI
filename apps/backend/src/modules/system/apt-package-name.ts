// Debian package-name charset (letters, digits, and `. + : ~ -`); rejects
// whitespace and shell metacharacters in poisoned/malformed apt output.
// Kept in its own side-effect-free module so the add-on descriptor schema in
// @ceraui/rpc can reuse the exact same pattern without importing the
// software-updates module graph (which loads config/network/streaming at
// import time). Single source of truth — never copy this charset (G5).
export const APT_PACKAGE_NAME_RE = /^[A-Za-z0-9.+:~-]+$/;
