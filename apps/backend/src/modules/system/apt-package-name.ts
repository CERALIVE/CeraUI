// Debian package names start with a letter/digit; `. + : ~ -` are allowed only
// after it. Rejects option-shaped names as well as shell metacharacters.
// Kept in its own side-effect-free module so the add-on descriptor schema in
// @ceraui/rpc can reuse the exact same pattern without importing the
// software-updates module graph (which loads config/network/streaming at
// import time). Single source of truth — never copy this charset (G5).
export const APT_PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.+:~-]*$/;
