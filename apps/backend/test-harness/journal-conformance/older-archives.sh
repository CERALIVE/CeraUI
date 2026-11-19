#!/usr/bin/env bash
set -euo pipefail
[[ "${CONFORMANCE_CONTAINER:-}" == 1 && -f /run/systemd/container ]]
machine="$1"
boot="$2"
prior=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
earlier=cccccccccccccccccccccccccccccccc
local_dir="/var/log/journal/$machine"
foreign_dir=/var/log/journal/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
namespace_dir="$local_dir.other"
now="$(date +%s%6N)"
old=1000000000000000
new_archive() {
	printf '%s/system@%032x-%016x-%016x.journal' "$1" 42 "$2" "$3"
}
entry() {
	printf '__REALTIME_TIMESTAMP=%s\n__MONOTONIC_TIMESTAMP=%s\n_BOOT_ID=%s\n_MACHINE_ID=%s\nMESSAGE=%s\n\n' \
		"$1" "$2" "$3" "$machine" "$4"
}
archive() {
	/usr/lib/systemd/systemd-journal-remote -o "$1" -
	# The importer closes OFFLINE. Set ARCHIVED as journald does after rotation.
	printf '\002' | dd of="$1" bs=1 seek=16 conv=notrunc status=none
}
assert_file() {
	if [[ "$2" == removed && ! -e "$3" ]] || [[ "$2" == kept && -f "$3" ]]; then
		echo "PASS live: Older cleanup $1"
	else
		echo "FAIL live: Older cleanup $1, expected $2" >&2
		exit 1
	fi
}

# An unclean archive is named for the time of disposal after a backward step.
printf -v backward '%s/system@%016x-%016x.journal~' "$local_dir" "$old" 7
entry "$now" 1000000 "$boot" backward-step | archive "$backward.journal"
mv "$backward.journal" "$backward"
xattr="$(new_archive "$local_dir" 2 "$now")"
entry "$now" 1000000 "$boot" older-crtime | archive "$xattr"
setfattr -n user.crtime_usec -v 0x40420f0000000000 "$xattr"
clock="$(new_archive "$local_dir" 3 "$now")"
entry "$now" 1000000 "$boot" clock-at-launch | archive "$clock"
mixed="$(new_archive "$local_dir" 4 "$old")"
{
	entry "$old" 1000000 "$boot" running-inside-mixed
	entry "$((old + 1))" 2000000 "$prior" previous-tail
} | archive "$mixed"
unknown="$(new_archive "$local_dir" 5 "$old")"
entry "$old" 1000000 "$prior" unknown-header | archive "$unknown"
printf '\377' | dd of="$unknown" bs=1 seek=16 conv=notrunc status=none
previous="$(new_archive "$local_dir" 6 "$old")"
entry "$old" 1000000 "$prior" previous-only | archive "$previous"
full="$(new_archive "$local_dir" 11 "$old")"
awk -v start="$old" -v boot="$prior" -v machine="$machine" 'BEGIN {
	for (i = 1; i <= 60000; i++)
		printf "__REALTIME_TIMESTAMP=%.0f\n__MONOTONIC_TIMESTAMP=%d\n_BOOT_ID=%s\n_MACHINE_ID=%s\nMESSAGE=%0256d\n\n",
			start + i, i, boot, machine, i
}' | archive "$full"
full_size="$(stat -c %s "$full")"
full_entries="$(journalctl --file="$full" --header | awk '/^Entry objects:/ { print $3 }')"
full_dump_bytes="$(journalctl --file="$full" -o json --all --lines=all --output-fields=_BOOT_ID | wc -c)"
if (( full_size < 30 * 1024 * 1024 || full_size > 34 * 1024 * 1024 ||
	full_entries != 60000 || full_dump_bytes <= 10 * 1024 * 1024 )); then
	echo "FAIL live: full archive precondition: $full_size bytes, $full_entries entries, $full_dump_bytes JSON bytes" >&2
	exit 1
fi
echo "PASS live: full archive has $full_entries entries, $full_size bytes, $full_dump_bytes JSON bytes"
two_earlier="$(new_archive "$local_dir" 12 "$old")"
{
	entry "$old" 1000000 "$earlier" first-earlier-boot
	entry "$((old + 1))" 2000000 "$prior" second-earlier-boot
} | archive "$two_earlier"
interleaved="$(new_archive "$local_dir" 13 "$old")"
{
	entry "$old" 1000000 "$prior" old-before
	entry "$((old + 1))" 2000000 "$boot" current-between
	entry "$((old + 2))" 3000000 "$prior" old-after
} | archive "$interleaved"
printf -v unclean_old '%s/system@%016x-%016x.journal~' "$local_dir" "$old" 14
entry "$old" 1000000 "$prior" usable-unclean | archive "$unclean_old.journal"
# A power loss leaves an ONLINE header even after journald disposes of the file.
printf '\001' | dd of="$unclean_old.journal" bs=1 seek=16 conv=notrunc status=none
mv "$unclean_old.journal" "$unclean_old"
printf -v unreadable '%s/system@%016x-%016x.journal~' "$local_dir" "$old" 15
entry "$old" 1000000 "$prior" unreadable-unclean | archive "$unreadable.journal"
# Rotation vacuums short or empty archives. Damage the signature but keep the entry count.
printf '\0' | dd of="$unreadable.journal" bs=1 conv=notrunc status=none
mv "$unreadable.journal" "$unreadable"
if journalctl --file="$unreadable" --list-boots -o json >/dev/null 2>&1; then
	echo 'FAIL live: unreadable unclean archive is readable' >&2
	exit 1
fi
corrupt="$(new_archive "$local_dir" 16 "$old")"
entry "$old" 1000000 "$prior" damaged-payload | archive "$corrupt"
offset="$(LC_ALL=C grep -abo 'MESSAGE=damaged-payload' "$corrupt" | cut -d: -f1)"
printf 'X' | dd of="$corrupt" bs=1 seek="$((offset + 8))" conv=notrunc status=none
corrupt_boots="$(journalctl --file="$corrupt" --list-boots -o json)"
jq -e --arg prior "$prior" 'map(.boot_id) == [$prior]' <<<"$corrupt_boots" >/dev/null ||
	{ echo "FAIL live: corrupt archive boot list: $corrupt_boots" >&2; exit 1; }
legacy_old="$(new_archive "$local_dir" 9 "$old")"
entry "$old" 1000000 "$prior" previous-legacy | archive "$legacy_old"
legacy_late="$(new_archive "$local_dir" 10 "$now")"
entry "$now" 1000000 "$prior" late-legacy | archive "$legacy_late"
for file in "$legacy_old" "$legacy_late"; do
	# Model earlier systemd headers without the tail-boot flag.
	printf '\0' | dd of="$file" bs=1 seek=8 conv=notrunc status=none
done
mkdir -p "$foreign_dir" "$namespace_dir"
foreign="$(new_archive "$foreign_dir" 7 "$old")"
namespace="$(new_archive "$namespace_dir" 8 "$old")"
cp "$previous" "$foreign"
cp "$previous" "$namespace"
scope_hashes="$(sha256sum "$foreign" "$namespace")"

# Arm a synchronous boundary after the first header read. The snapshot already
# exists, and the active file rotates with this boot's markers still in it.
mkdir /state/older-argv
printf '%s\n' "$(find /usr/lib -name libfaketime.so.1 -print -quit)" >/state/older-faketime
[[ -s /state/older-faketime ]]
cp /conformance/older-journalctl.sh /state/older-argv/journalctl
chmod +x /state/older-argv/journalctl
stat -c '%d:%i' "$local_dir/system.journal" >/state/older-active
start_ms="$((now / 1000))"
receipt="$(PATH="/state/older-argv:$PATH" /state/retention-probe "$start_ms")"
echo "Older cleanup receipt: $receipt"
jq -e '.legacyArchivesKept == true and .unverifiedArchivesKept == true' <<<"$receipt" >/dev/null
[[ -s /state/older-rotated ]] || { echo 'FAIL live: inventory did not rotate the active file' >&2; exit 1; }
mapfile -t matching < <(find "$local_dir" -name 'system@*.journal' -exec stat -c '%d:%i %n' {} +)
rotated=
for item in "${matching[@]}"; do
	if [[ "${item%% *}" == "$(</state/older-active)" ]]; then rotated="${item#* }"; fi
done
assert_file 'preserves the active file that rotated after inventory' kept "$rotated"
assert_file 'preserves a backward-step unclean archive' kept "$backward"
assert_file 'preserves a current archive with an older creation-time xattr' kept "$xattr"
assert_file 'preserves a current archive when the old vacuum client clock would jump' kept "$clock"
assert_file 'preserves a mixed archive with a previous-boot tail' kept "$mixed"
assert_file 'preserves an unrecognized archive header' kept "$unknown"
assert_file 'removes a verified previous-boot archive' removed "$previous"
assert_file 'removes a full-size earlier-boot archive' removed "$full"
assert_file 'removes an archive spanning two earlier boots' removed "$two_earlier"
assert_file 'preserves an interleaved current boot' kept "$interleaved"
assert_file 'removes an inspectable earlier-boot unclean archive' removed "$unclean_old"
assert_file 'preserves an unreadable unclean archive' kept "$unreadable"
assert_file 'preserves a corrupt archive even when its boot list is readable' kept "$corrupt"
assert_file 'removes a legacy archive with an older tail and verified entries' removed "$legacy_old"
assert_file 'reports and keeps a legacy archive without earlier tail evidence' kept "$legacy_late"
jq -e '.unverifiedArchivesKeptCount == 3' <<<"$receipt" >/dev/null ||
	{ echo 'FAIL live: expected exactly three unchecked archives' >&2; exit 1; }
[[ "$scope_hashes" == "$(sha256sum "$foreign" "$namespace")" ]]
echo 'PASS live: Older cleanup preserves foreign machine and namespace bytes'
[[ "$(journalctl --file="$rotated" --no-pager -o json "_BOOT_ID=$boot" SYSLOG_IDENTIFIER=older-cleanup | jq -s length)" == 3 ]]
echo 'PASS live: Older cleanup preserves all three rotated fixture records'
