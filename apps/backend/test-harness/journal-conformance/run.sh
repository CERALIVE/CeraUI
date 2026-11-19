#!/usr/bin/env bash
set -euo pipefail
if [[ "${CONFORMANCE_BOUNDED:-}" != 1 ]]; then
	exec timeout --signal=TERM --kill-after=90s 12m env CONFORMANCE_BOUNDED=1 bash "$0"
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
docker image inspect debian:trixie --format 'BASE IMAGE {{.Id}}' ||
	{ echo 'FAIL: debian:trixie must already exist; no image will be pulled' >&2; exit 1; }
mkdir -p "$repo/dist"
state="$(mktemp -d "$repo/dist/journal-conformance.XXXXXXXX")"
name="journal-conformance-${state##*.}"
volume="$name-journal"
fixture="$name-fixture"
created_volume=0
cleanup() {
	local result=$? owned ids
	trap - EXIT
	if (( result != 0 )); then timeout 10s docker logs --tail 80 "$name" 2>/dev/null || true; fi
	for owned in "$name" "$fixture"; do
		if ids="$(timeout 10s docker ps -aq --filter "name=^/$owned$")"; then
			if [[ -n "$ids" ]]; then
				timeout 10s docker rm -f -v "$owned" || result=1
			fi
		else
			echo "FAIL cleanup: could not list owned container $owned" >&2
			result=1
		fi
	done
	if (( created_volume )); then
		timeout 10s docker volume rm "$volume" || { echo "FAIL cleanup volume $volume" >&2; result=1; }
	fi
	rm -rf -- "$state"
	echo "CLEANUP containers=$name,$fixture volume=$volume images=untouched result=$result"
	return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun build --compile "$here/reader-probe.ts" --outfile "$state/reader-probe"
bun build --compile "$here/retention-probe.ts" --outfile "$state/retention-probe"
docker run --pull=never --rm -i --name "$fixture" \
	-v "$here:/conformance:ro" \
	-v "$state/reader-probe:/reader-probe:ro" \
	-e CONFORMANCE_SELFTEST="${CONFORMANCE_SELFTEST:-0}" debian:trixie bash -s <"$here/fixture.sh"
docker volume create "$volume"
created_volume=1
mkfifo "$state/ready"
printf '11111111-1111-1111-1111-111111111111\n' >"$state/boot-id"
# Install in this container's writable layer, preserving every Docker image.
docker run --pull=never -d --name "$name" --privileged --cgroupns=host \
	--tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
	-v "$volume:/var/log/journal" -v "$state:/state" -v "$here:/conformance:ro" \
	-e container=docker -e CONFORMANCE_CONTAINER=1 debian:trixie bash -euc '
		export DEBIAN_FRONTEND=noninteractive
		if [[ ! -x /usr/bin/jq ]]; then
			apt-get update -qq
			apt-get install -y -qq --no-install-recommends systemd systemd-sysv systemd-journal-remote dbus jq strace libfaketime
			printf "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" >/etc/machine-id
			mkdir -p /var/log/journal /etc/systemd/system/multi-user.target.wants
			mkdir -p /etc/systemd/journald.conf.d
			printf "[Journal]\nReadKMsg=no\n" >/etc/systemd/journald.conf.d/container.conf
			printf "[Unit]\nAfter=systemd-journald.service dbus.service\n[Service]\nType=oneshot\nExecStart=/bin/sh -c \"echo ready > /state/ready\"\n" >/etc/systemd/system/conformance-ready.service
			ln -s ../conformance-ready.service /etc/systemd/system/multi-user.target.wants/conformance-ready.service
			machine=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
			mkdir -p "/var/log/journal/$machine"
			uptime="$(cut -d. -f1 /proc/uptime)"
			old="$((($(date +%s) - uptime - 180) * 1000000))"
			printf "__REALTIME_TIMESTAMP=%s\n__MONOTONIC_TIMESTAMP=1000000\n_BOOT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n_MACHINE_ID=%s\nMESSAGE=cleanup previous boot seed\n\n" "$old" "$machine" |
				/usr/lib/systemd/systemd-journal-remote -o "/var/log/journal/$machine/system.journal" -
		fi
		mount --bind /state/boot-id /proc/sys/kernel/random/boot_id
		exec /lib/systemd/systemd
	'
ready() {
	local line
	line="$(timeout 180s docker exec "$name" head -n 1 /state/ready)" || { echo 'FAIL: systemd readiness timed out' >&2; exit 1; }
	[[ "$line" == ready ]] || { echo "FAIL: readiness returned $line" >&2; exit 1; }
}
ready
timeout --kill-after=5s 240s docker exec "$name" bash /conformance/live.sh
docker exec "$name" systemctl poweroff
equal_exit="$(timeout 40s docker wait "$name")"
echo "POWEROFF EXIT $equal_exit (cleanliness is asserted from journal lifecycle records)"
printf '44444444-4444-4444-4444-444444444444\n' >"$state/boot-id"
docker start "$name"
ready
docker exec "$name" bash -euc 'systemd-cat -t crash echo before-kill; journalctl --sync'
docker kill -s KILL "$name"
[[ "$(timeout 40s docker wait "$name")" == 137 ]]
printf '55555555-5555-5555-5555-555555555555\n' >"$state/boot-id"
docker start "$name"
ready
docker exec "$name" bash -euc 'systemctl restart systemd-journald; systemd-cat -t crash echo after-restart; journalctl --sync'
docker kill -s KILL "$name"
[[ "$(timeout 40s docker wait "$name")" == 137 ]]
printf '66666666-6666-6666-6666-666666666666\n' >"$state/boot-id"
docker start "$name"
ready
timeout --kill-after=5s 60s docker exec "$name" bash /conformance/live.sh verify-shutdown
cleanup
echo 'CONFORMANCE OK systemd 257'
