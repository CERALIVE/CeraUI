#!/usr/bin/env bash
set -euo pipefail
case " $* " in
	*" --header "*)
		if [[ ! -e /state/older-rotated ]]; then
			output="$(/usr/bin/journalctl "$@")"
			/usr/bin/journalctl --rotate
			printf 'rotated\n' >/state/older-rotated
			printf '%s\n' "$output"
			exit 0
		fi
		;;
	*" --vacuum-time="*)
		LD_PRELOAD="$(</state/older-faketime)" FAKETIME=+365d exec /usr/bin/journalctl "$@"
		;;
esac
exec /usr/bin/journalctl "$@"
