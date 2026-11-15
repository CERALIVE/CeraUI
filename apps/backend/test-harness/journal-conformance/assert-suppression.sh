#!/usr/bin/env bash
set -euo pipefail
jq -e --arg unit "$1" --argjson dropped "$(($2 - $3))" '
	if type == "object" then
		.MESSAGE_ID == "a596d6fe7bfa4994828e72309e95d61e" and
		.N_DROPPED == ($dropped | tostring) and
		.MESSAGE == ("Suppressed " + ($dropped | tostring) + " messages from " + $unit) and
		$dropped > 0
	else false end
' >/dev/null
