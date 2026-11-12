#!/usr/bin/env bash
# Local-only hwsim runner. All module and network changes happen in the guest.
set -euo pipefail
umask 077

die() { echo "run-vm.sh: $*" >&2; exit 1; }
usage() {
	echo "Usage: $0 [--radios N] [--repo PATH] [--keep] -- COMMAND [ARG...]"
	echo "Requires TMPDIR outside /tmp. --keep holds the guest for SSH until interrupted (max 1 hour)."
}

radios=2
repo=
keep=0
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
	-h | --help) usage; exit 0 ;;
	--) shift; break ;;
	*) die "unknown flag: $1" ;;
	esac
done
(($#)) || { usage >&2; exit 2; }
[[ -n "${TMPDIR:-}" ]] || die "set TMPDIR to a disk-backed directory outside /tmp"
tmp=$(realpath -e "$TMPDIR")
[[ "$tmp" != /tmp && "$tmp" != /tmp/* ]] || die "TMPDIR must be outside /tmp"
for tool in qemu-system-x86_64 qemu-img xorriso ssh ssh-keygen scp curl sha512sum python3 timeout flock tar; do
	command -v "$tool" >/dev/null || die "required executable missing: $tool"
done
[[ -r /dev/kvm && -w /dev/kvm ]] || die "/dev/kvm must be readable and writable"
if [[ -n "$repo" ]]; then
	GIT_MASTER=1 git -C "$repo" rev-parse --show-toplevel >/dev/null
	bun_path=$(readlink -f "$(command -v bun)")
	[[ "$("$bun_path" --version)" == 1.4.4 ]] || die "--repo requires workstation Bun 1.4.4"
fi

harness=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root="$tmp/hwsim-vm"
mkdir -p "$root/images" "$root/runs"
run_dir=$(mktemp -d "$root/runs/run.XXXXXXXX")
vm_pid=
step_pid=
ssh_opts=()

# Run foreground work as a bounded, interruptible child; timeout owns its group.
run() {
	local budget=$1 rc=0
	shift
	timeout --kill-after=5 "$budget" "$@" <&0 &
	step_pid=$!
	wait "$step_pid" || rc=$?
	step_pid=
	((rc != 124 && rc != 137)) || echo "run-vm.sh: timed out after $budget: $1" >&2
	return "$rc"
}

cleanup() {
	local rc=${1:-$?}
	trap - EXIT INT TERM
	set +e
	if [[ -n "$step_pid" ]]; then
		kill -TERM "$step_pid" 2>/dev/null
		timeout 6 tail --pid="$step_pid" -f /dev/null
		kill -KILL "$step_pid" 2>/dev/null
		wait "$step_pid" 2>/dev/null
	fi
	if [[ -n "$vm_pid" ]]; then
		if kill -0 "$vm_pid" 2>/dev/null; then
			timeout 10 ssh "${ssh_opts[@]}" root@127.0.0.1 poweroff >/dev/null 2>&1
			timeout 20 tail --pid="$vm_pid" -f /dev/null
			kill -TERM "$vm_pid" 2>/dev/null
			timeout 5 tail --pid="$vm_pid" -f /dev/null
			kill -KILL "$vm_pid" 2>/dev/null
		fi
		wait "$vm_pid" 2>/dev/null
	fi
	if ((rc != 0)) && [[ -f "$run_dir/serial.log" ]]; then
		echo "run-vm.sh: guest console tail:" >&2
		tail -n 30 "$run_dir/serial.log" >&2
	fi
	rm -rf -- "$run_dir"
	echo "run-vm.sh: cleanup pid=${vm_pid:-none} removed=$run_dir exit=$rc"
	exit "$rc"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo "run-vm.sh: run_dir=$run_dir"

url=https://cloud.debian.org/images/cloud/bookworm/latest
image_name=debian-12-generic-amd64.qcow2
run 60 curl --fail --location --proto '=https' --proto-redir '=https' \
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
	run 910 curl --fail --location --proto '=https' --proto-redir '=https' \
		--connect-timeout 15 --max-time 900 "$url/$image_name" -o "$run_dir/image.partial"
	printf '%s  %s\n' "$digest" "$run_dir/image.partial" | sha512sum --check --status ||
		die "download checksum mismatch; refusing to boot"
	mv "$run_dir/image.partial" "$image"
fi
# Revalidate cached bytes on every invocation, before QEMU reads the image.
printf '%s  %s\n' "$digest" "$image" | sha512sum --check ||
	die "image checksum mismatch; refusing to boot"
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
packages: [network-manager, wpasupplicant, hostapd, iw, iproute2, rfkill]
EOF
printf 'instance-id: %s\nlocal-hostname: hwsim\n' "$(basename "$run_dir")" >"$run_dir/meta-data"
run 30 xorriso -as mkisofs -quiet -V cidata -o "$run_dir/seed.iso" \
	-J -r "$run_dir/user-data" "$run_dir/meta-data"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
ssh_opts=(-p "$port" -i "$run_dir/id_ed25519" -o IdentitiesOnly=yes
	-o BatchMode=yes -o StrictHostKeyChecking=accept-new
	-o "UserKnownHostsFile=$run_dir/known_hosts" -o ConnectTimeout=5
	-o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o LogLevel=ERROR)
qemu-system-x86_64 -enable-kvm -cpu host -m 2048 -smp 2 -nographic \
	-drive "file=$run_dir/overlay.qcow2,format=qcow2,if=virtio" \
	-drive "file=$run_dir/seed.iso,format=raw,media=cdrom,readonly=on" \
	-nic "user,hostfwd=tcp:127.0.0.1:$port-:22" >"$run_dir/serial.log" 2>&1 &
vm_pid=$!
echo "run-vm.sh: VM pid=$vm_pid port=$port overlay=$run_dir/overlay.qcow2"
deadline=$((SECONDS + 300))
until run 10 ssh "${ssh_opts[@]}" root@127.0.0.1 true 2>"$run_dir/ssh.log"; do
	kill -0 "$vm_pid" 2>/dev/null || die "QEMU exited during boot: $(tail -n 5 "$run_dir/serial.log")"
	((SECONDS < deadline)) || die "SSH did not become ready within 300 seconds: $(<"$run_dir/ssh.log")"
	run 3 sleep 2
done
run 610 ssh "${ssh_opts[@]}" root@127.0.0.1 \
	'timeout -k 5 600 cloud-init status --wait --long' ||
	die "cloud-init did not finish successfully within 600 seconds"

run 60 tar -C "$harness" -cf "$run_dir/harness.tar" .
if [[ -n "$repo" ]]; then
	run 60 env GIT_MASTER=1 git -C "$repo" archive --format=tar -o "$run_dir/repo.tar" HEAD
	run 60 cp "$bun_path" "$run_dir/bun"
fi
cat >"$run_dir/command.sh" <<'COMMAND'
#!/usr/bin/env bash
set -euo pipefail
cd /harness
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
	install -m 755 /root/bun /usr/local/bin/bun
	bun --version
fi
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

rc=0
run 920 ssh "${ssh_opts[@]}" root@127.0.0.1 \
	'timeout -k 5 900 bash /root/command.sh' || rc=$?
echo "run-vm.sh: command exit=$rc"
if ((keep && rc == 0)); then
	echo "run-vm.sh: --keep: SSH available for up to 3600 seconds; interrupt this runner to clean up."
	printf 'ssh '
	printf '%q ' "${ssh_opts[@]}" root@127.0.0.1
	printf '\n'
	run 3610 timeout 3600 tail --pid="$vm_pid" -f /dev/null || true
fi
cleanup "$rc"
