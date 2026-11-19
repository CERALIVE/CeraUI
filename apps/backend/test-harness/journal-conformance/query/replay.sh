#!/usr/bin/env bash
# Sourced by fixture.sh, inside its disposable systemd 257 container only.
{
	gen 1700000000000000 1000000 ceralive.service stdout 6 'm1 app info'
	gen 1700000001000000 2000000 cerastream.service stdout 3 'm2 engine error'
	gen 1700000002000000 3000000 '' kernel 4 'm3 kernel warning'
	gen 1700000003000000 4000000 ceralive.service stdout 7 'm4 app debug'
	gen 1700000003000000 4000001 NetworkManager.service stdout 6 'm5 network info'
	gen 1700000004000000 5000000 ceralive.service stdout 3 'm6 app error'
	gen 1700000005000000 6000000 cerastream.service stdout 6 'm7 engine info'
} | /usr/lib/systemd/systemd-journal-remote -o /fx/paging.journal -
J=(journalctl --no-pager --file=/fx/paging.journal -o json)
c3="$(cursor m3)"
while IFS= read -r row; do
	name="$(jq -r .name <<<"$row")"
	expected="$(jq -r .ids <<<"$row")"
	mapfile -t options < <(jq -r '.options[]' <<<"$row")
	mapfile -t matches < <(jq -r '.matches[]' <<<"$row")
	for index in "${!options[@]}"; do
		options[index]="${options[index]//\$m3/$c3}"
	done
	check "query golden: $name" "$expected" "${options[@]}" -- "${matches[@]}"
done </conformance/query/golden-argv.txt
