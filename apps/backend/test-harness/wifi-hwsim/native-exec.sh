#!/usr/bin/env bash
# Each case owns a private launcher mount; even SIGKILL cannot leak it to the next case.
set -euo pipefail
[[ "$(id -u)" == 0 && "${HWSIM_REPO:-}" == /repo ]] ||
	{ echo "native-exec: requires the disposable root guest" >&2; exit 1; }
if [[ "${1:-}" != --inside ]]; then
	(($#)) || { echo "Usage: bash native-exec.sh COMMAND [ARG...]" >&2; exit 2; }
	exec unshare --mount --propagation private --fork --kill-child \
		bash "$0" --inside "$@"
fi
shift
# Open against this namespace's mount tree, before covering the original bin.
exec 9<"$(readlink -f "$(command -v bun)")"
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /usr/local/bin
touch /usr/local/bin/bun
# Canonicalizing the magic link would select the new, covered pathname.
mount --no-canonicalize --bind /proc/self/fd/9 /usr/local/bin/bun
exec 9<&-
exec "$@"
