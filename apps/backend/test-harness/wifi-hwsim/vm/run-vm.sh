#!/usr/bin/env bash
# Local-only hwsim runner. All module and network changes happen in the guest.
set -euo pipefail
umask 077

die() { echo "run-vm.sh: $*" >&2; exit 1; }
usage() {
	echo "Usage: $0 [--radios N] [--repo PATH] [--no-install] [--keep] -- COMMAND [ARG...]"
	echo "Requires TMPDIR outside /tmp and Git work trees. --keep holds SSH inspection for at most 1 hour."
}

radios=2
repo=
keep=0
install_deps=1
while (($#)); do
	case "$1" in
	--radios)
		(($# >= 2)) || die "--radios needs a number"
		[[ "$2" =~ ^[0-9]+$ && ${#2} -le 3 ]] || die "--radios must be an integer from 2 to 100"
		radios=$((10#$2))
		((radios >= 2 && radios <= 100)) || die "--radios must be from 2 to 100"
		shift 2 ;;
	--repo)
		(($# >= 2)) || die "--repo needs a path"
		repo=$(realpath -e "$2")
		shift 2 ;;
	--keep) keep=1; shift ;;
	--no-install) install_deps=0; shift ;;
	-h | --help) usage; exit 0 ;;
	--) shift; break ;;
	*) die "unknown flag: $1" ;;
	esac
done
(($#)) || { usage >&2; exit 2; }
[[ -n "${TMPDIR:-}" ]] || die "set TMPDIR to a disk-backed directory outside /tmp"
tmp=$(realpath -e "$TMPDIR")
root=$(realpath -m "$tmp/hwsim-vm")
parent=$root
while [[ ! -d "$parent" ]]; do parent=$(dirname "$parent"); done
if [[ "$root" == /tmp || "$root" == /tmp/* ]] ||
	[[ "$(GIT_MASTER=1 git -C "$parent" rev-parse --is-inside-work-tree --is-inside-git-dir 2>/dev/null)" == *true* ]]; then
	die "state directory must be outside /tmp and every Git work tree"
fi
[[ "$root" != *,* ]] || die "state directory cannot contain a comma (QEMU drive syntax)"
for tool in qemu-system-x86_64 qemu-img xorriso ssh ssh-keygen scp curl sha512sum python3 timeout flock tar git; do
	command -v "$tool" >/dev/null || die "required executable missing: $tool"
done
[[ -r /dev/kvm && -w /dev/kvm ]] || die "/dev/kvm must be readable and writable"
if [[ -n "$repo" ]]; then
	repo=$(GIT_MASTER=1 git -C "$repo" rev-parse --show-toplevel)
	repo_sha=$(GIT_MASTER=1 git -C "$repo" rev-parse HEAD)
	bun_path=$(readlink -f "$(command -v bun)")
	[[ "$("$bun_path" --version)" == 1.4.4 ]] || die "--repo requires workstation Bun 1.4.4"
fi
python3 -c 'import os, signal; assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "Python with Linux pidfd support required"'

harness=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
run_dir=
vm_pid=
vm_start=
step_pid=
step_start=
ssh_opts=()
registering=0
cancel=0
cancel_rc=0

process_start() {
	local stat fields
	[[ -r /proc/$1/stat ]] || return 1
	read -r stat <"/proc/$1/stat" || return 1
	read -r -a fields <<<"${stat##*) }"
	printf '%s\n' "${fields[19]}"
}
owned_alive() {
	local stat fields
	[[ -n "$1" && -n "$2" && -r /proc/$1/stat ]] || return 1
	read -r stat <"/proc/$1/stat" || return 1
	read -r -a fields <<<"${stat##*) }"
	[[ "${fields[19]}" == "$2" && "${fields[0]}" != Z && "${fields[0]}" != X ]]
}
# Pin the process before checking starttime, so check-to-signal PID reuse is safe.
signal_owned() {
	python3 - "$1" "$2" "$3" <<'SIGNAL'
import os
import signal
import sys

pid, expected, name = int(sys.argv[1]), sys.argv[2], sys.argv[3]
try:
    fd = os.pidfd_open(pid)
except ProcessLookupError:
    sys.exit(0)
try:
    try:
        with open(f"/proc/{pid}/stat") as stat:
            fields = stat.read().rsplit(") ", 1)[1].split()
        if fields[19] == expected and fields[0] not in ("Z", "X"):
            signal.pidfd_send_signal(fd, getattr(signal, f"SIG{name}"))
    except (FileNotFoundError, ProcessLookupError):
        pass
finally:
    os.close(fd)
SIGNAL
}
wait_owned() {
	local deadline=$((SECONDS + $3))
	while owned_alive "$1" "$2"; do
		((SECONDS < deadline)) || return 1
		sleep 0.1
	done
}
stop_owned() {
	if owned_alive "$1" "$2"; then
		signal_owned "$1" "$2" TERM
		if ! wait_owned "$1" "$2" 6; then
			signal_owned "$1" "$2" KILL
			wait_owned "$1" "$2" 5 || return 1
		fi
	fi
	[[ -z "$1" ]] || wait "$1" 2>/dev/null || true
}
honor_cancel() {
	registering=0
	if ((cancel)); then exit "$cancel_rc"; fi
}

# Run foreground work as a bounded, interruptible child; timeout owns its group.
run() {
	local budget=$1 rc=0
	shift
	registering=1
	timeout --kill-after=5 "$budget" "$@" <&0 &
	step_pid=$!
	step_start=$(process_start "$step_pid") || step_start=
	honor_cancel
	wait "$step_pid" || rc=$?
	step_pid=
	step_start=
	((rc != 124 && rc != 137)) || echo "run-vm.sh: timed out after $budget: $1" >&2
	return "$rc"
}

cleanup() {
	local rc=${1:-$?}
	trap - EXIT
	trap '' INT TERM
	set +e
	cancel=0
	registering=0
	stop_owned "$step_pid" "$step_start"
	if owned_alive "$step_pid" "$step_start"; then
		echo "run-vm.sh: owned command could not be stopped; preserving $run_dir" >&2
		exit 1
	fi
	step_pid=
	step_start=
	if owned_alive "$vm_pid" "$vm_start"; then
		run 10 ssh "${ssh_opts[@]}" root@127.0.0.1 poweroff >/dev/null 2>&1
		wait_owned "$vm_pid" "$vm_start" 20
	fi
	stop_owned "$vm_pid" "$vm_start"
	if owned_alive "$vm_pid" "$vm_start"; then
		echo "run-vm.sh: owned VM could not be stopped; preserving $run_dir" >&2
		exit 1
	fi
	if ((rc != 0)) && [[ -n "$run_dir" && -f "$run_dir/serial.log" ]]; then
		echo "run-vm.sh: guest console tail:" >&2
		tail -n 30 "$run_dir/serial.log" >&2
	fi
	[[ -z "$run_dir" ]] || rm -rf -- "$run_dir"
	echo "run-vm.sh: cleanup pid=${vm_pid:-none} removed=$run_dir exit=$rc"
	exit "$rc"
}
trap 'cleanup' EXIT
trap 'cancel=1 cancel_rc=130; if [[ $registering == 0 ]]; then exit "$cancel_rc"; fi' INT
trap 'cancel=1 cancel_rc=143; if [[ $registering == 0 ]]; then exit "$cancel_rc"; fi' TERM
mkdir -p "$root" "$root/images" "$root/runs"
chmod 700 "$root" "$root/images" "$root/runs"
registering=1
run_dir=$(mktemp -d "$root/runs/run.XXXXXXXX")
honor_cancel
echo "run-vm.sh: run_dir=$run_dir"

url=https://cloud.debian.org/images/cloud/bookworm/latest
image_name=debian-12-generic-amd64.qcow2
run 60 curl -q --fail --location --proto '=https' --proto-redir '=https' \
	--connect-timeout 15 --max-time 55 "$url/SHA512SUMS" -o "$run_dir/SHA512SUMS"
digest=$(awk -v name="$image_name" '$2 == name {print $1}' "$run_dir/SHA512SUMS")
[[ "$digest" =~ ^[a-f0-9]{128}$ ]] || die "invalid or missing image SHA512 in Debian's HTTPS SHA512SUMS"
image="$root/images/$digest/$image_name"
mkdir -p "$(dirname "$image")"
exec {image_lock}>"$root/images/download.lock"
run 960 flock -x -w 950 "$image_lock"
# Reject corrupt cached bytes before creating an overlay, then replace them once.
if [[ -f "$image" ]] && ! printf '%s  %s\n' "$digest" "$image" | sha512sum --check --status; then
	echo "run-vm.sh: cached image checksum mismatch; refusing cached bytes and downloading replacement" >&2
	rm -- "$image"
fi
if [[ ! -f "$image" ]]; then
	run 910 curl -q --fail --location --proto '=https' --proto-redir '=https' \
		--connect-timeout 15 --max-time 900 "$url/$image_name" -o "$run_dir/image.partial"
	printf '%s  %s\n' "$digest" "$run_dir/image.partial" | sha512sum --check --status ||
		die "download checksum mismatch; refusing to boot"
	mv "$run_dir/image.partial" "$image"
fi
# Revalidate cached bytes on every invocation, before QEMU reads the image.
printf '%s  %s\n' "$digest" "$image" | sha512sum --check ||
	die "image checksum mismatch; refusing to boot"
chmod 0444 "$image"
echo "run-vm.sh: image_sha512=$digest"
[[ -z "$repo" ]] || echo "run-vm.sh: application_sha=$repo_sha"
flock -u "$image_lock"
exec {image_lock}>&-
run 30 qemu-img create -f qcow2 -F qcow2 -b "$image" "$run_dir/overlay.qcow2" 8G
run 10 ssh-keygen -q -t ed25519 -N '' -f "$run_dir/id_ed25519"
cat >"$run_dir/user-data" <<EOF
#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - name: root
    ssh_authorized_keys:
      - $(<"$run_dir/id_ed25519.pub")
package_update: true
packages: [network-manager, wpasupplicant, hostapd, iw, iproute2, rfkill, git]
EOF
printf 'instance-id: %s\nlocal-hostname: hwsim\n' "$(basename "$run_dir")" >"$run_dir/meta-data"
run 30 xorriso -as mkisofs -quiet -V cidata -o "$run_dir/seed.iso" \
	-J -r "$run_dir/user-data" "$run_dir/meta-data"
deadline=$((SECONDS + 300))
for attempt in 1 2 3; do
	port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
	ssh_opts=(-p "$port" -F /dev/null -i "$run_dir/id_ed25519" -o IdentitiesOnly=yes -o IdentityAgent=none
		-o BatchMode=yes -o StrictHostKeyChecking=accept-new
		-o "UserKnownHostsFile=$run_dir/known_hosts" -o ConnectTimeout=5
		-o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o LogLevel=ERROR)
	registering=1
	qemu-system-x86_64 -enable-kvm -cpu host -m 2048 -smp 2 -nographic \
		-drive "file=$run_dir/overlay.qcow2,format=qcow2,if=virtio" \
		-drive "file=$run_dir/seed.iso,format=raw,media=cdrom,readonly=on" \
		-nic "user,hostfwd=tcp:127.0.0.1:$port-:22" >"$run_dir/serial.log" 2>&1 &
	vm_pid=$!
	vm_start=$(process_start "$vm_pid") || vm_start=
	honor_cancel
	echo "run-vm.sh: VM pid=$vm_pid port=$port overlay=$run_dir/overlay.qcow2 starttime=$vm_start"
	ready=0
	while owned_alive "$vm_pid" "$vm_start" && ((SECONDS < deadline)); do
		if run 10 ssh "${ssh_opts[@]}" root@127.0.0.1 true 2>"$run_dir/ssh.log" &&
			owned_alive "$vm_pid" "$vm_start"; then
			ready=1
			break
		fi
		run 3 sleep 2
	done
	((ready == 0)) || break
	if ! owned_alive "$vm_pid" "$vm_start" &&
		grep -Eq 'Could not set up host forwarding rule|Address already in use' "$run_dir/serial.log"; then
		wait "$vm_pid" 2>/dev/null || true
		vm_pid=
		vm_start=
		echo "run-vm.sh: infrastructure failure: SSH port collision attempt=$attempt" >&2
		((attempt < 3)) || die "infrastructure failure: SSH port collisions exhausted 3 attempts"
		continue
	fi
	die "SSH boot failed within its 300-second deadline: $(tail -n 5 "$run_dir/serial.log")"
done
run 610 ssh "${ssh_opts[@]}" root@127.0.0.1 \
	'timeout -k 5 600 cloud-init status --wait --long' ||
	die "cloud-init did not finish successfully within 600 seconds"

run 60 tar -C "$harness" -cf "$run_dir/harness.tar" .
if [[ -n "$repo" ]]; then
	run 60 env GIT_MASTER=1 git -C "$repo" archive --format=tar -o "$run_dir/repo.tar" "$repo_sha"
	run 60 cp "$bun_path" "$run_dir/bun"
fi
cat >"$run_dir/command.sh" <<'COMMAND'
#!/usr/bin/env bash
set -euo pipefail
if [[ -d /repo ]]; then cd /repo; else cd /harness; fi
export CERATEST_CLIENT_IF="$(cat /run/hwsim-client)"
export HWSIM_REPO=/repo
COMMAND
printf '%q ' "$@" >>"$run_dir/command.sh"
printf '\n' >>"$run_dir/command.sh"
files=("$run_dir/harness.tar" "$run_dir/command.sh")
[[ -z "$repo" ]] || files+=("$run_dir/repo.tar" "$run_dir/bun")
run 180 scp -P "$port" "${ssh_opts[@]:2}" "${files[@]}" root@127.0.0.1:/root/
run 180 ssh "${ssh_opts[@]}" root@127.0.0.1 "bash -s -- $radios" <<'GUEST'
set -euo pipefail
mkdir /harness
tar -xf /root/harness.tar -C /harness
if [[ -f /root/repo.tar ]]; then
	mkdir /repo
	tar -xf /root/repo.tar -C /repo
	git init -q /repo
	install -m 755 /root/bun /usr/local/bin/bun
	bun --version
fi
printf 'run-vm.sh: guest_kernel=%s\n' "$(uname -r)"
printf 'run-vm.sh: NetworkManager=%s\n' "$(NetworkManager --version)"
printf 'run-vm.sh: iw=%s\n' "$(iw --version)"
printf 'run-vm.sh: wpa_supplicant=%s\n' "$(wpa_supplicant -v | head -n 1)"
modinfo mac80211_hwsim
modprobe mac80211_hwsim radios="$1"
udevadm settle --timeout=20
mapfile -t interfaces < <(find /sys/class/net -mindepth 1 -maxdepth 1 -name 'wlan*' -printf '%f\n' | sort -V)
((${#interfaces[@]} >= $1)) || { echo "Not enough hwsim interfaces" >&2; exit 1; }
ap=${interfaces[0]}
client=${interfaces[1]}
rfkill unblock wifi
mkdir -p /etc/NetworkManager/conf.d
printf '[keyfile]\nunmanaged-devices=interface-name:%s\n' "$ap" >/etc/NetworkManager/conf.d/00-hwsim.conf
systemctl restart NetworkManager
nmcli device set "$ap" managed no
nmcli device set "$client" managed yes
ip link set "$ap" up
ip addr add 192.0.2.1/24 dev "$ap"
cat >/run/hwsim-hostapd.conf <<EOF
interface=$ap
driver=nl80211
ssid=CeraTest
hw_mode=g
channel=6
wpa=2
wpa_passphrase=ceratest1234
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
ignore_broadcast_ssid=0
EOF
hostapd -B -P /run/hwsim-hostapd.pid -f /run/hwsim-hostapd.log /run/hwsim-hostapd.conf
for ((attempt=0; attempt<20; attempt++)); do
	if grep -q AP-ENABLED /run/hwsim-hostapd.log; then break; fi
	sleep 0.5
done
grep -q AP-ENABLED /run/hwsim-hostapd.log || { cat /run/hwsim-hostapd.log >&2; exit 1; }
# The AP supplies association only; static test addresses avoid needing DHCP.
nmcli connection add type wifi ifname "$client" con-name CeraTest ssid CeraTest \
	wifi-sec.key-mgmt wpa-psk wifi-sec.psk ceratest1234 \
	ipv4.method manual ipv4.addresses 192.0.2.2/24 ipv6.method disabled
printf '%s\n' "$client" >/run/hwsim-client
echo "run-vm.sh: AP CeraTest ready; client=$client"
GUEST

if [[ -n "$repo" ]] && ((install_deps)); then
	run 920 ssh "${ssh_opts[@]}" root@127.0.0.1 \
		'cd /repo && timeout -k 5 900 bun install --frozen-lockfile --linker=hoisted' ||
		die "infrastructure failure: guest frozen dependency installation failed"
fi
rc=0
run 920 ssh "${ssh_opts[@]}" root@127.0.0.1 \
	'timeout -k 5 900 bash /root/command.sh' || rc=$?
echo "run-vm.sh: command exit=$rc"
if ((keep && rc == 0)); then
	echo "run-vm.sh: --keep: SSH available for up to 3600 seconds; interrupt this runner to clean up."
	printf 'ssh '
	printf '%q ' "${ssh_opts[@]}" root@127.0.0.1
	printf '\n'
	wait_owned "$vm_pid" "$vm_start" 3600 || true
fi
cleanup "$rc"
