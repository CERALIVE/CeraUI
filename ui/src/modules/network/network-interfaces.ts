/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ws } from "../ui/websocket.ts";

type NetworkInterface = {
	error: string;
	enabled: boolean;
	ip: string;
	tp: number;
};

declare global {
	interface Window {
		setNetif: typeof setNetif;
	}
}

window.setNetif = setNetif;

/* Network interfaces list */
function setNetif(name: string, ip: string, enabled: boolean) {
	ws?.send(JSON.stringify({ netif: { name: name, ip: ip, enabled: enabled } }));
}

function genNetifEntry(
	error: string | undefined,
	enabled: boolean | undefined,
	name: string,
	ip: string,
	throughput: string,
	isBold = false,
) {
	let checkbox = "";
	if (enabled !== undefined) {
		const esc_name = name.replaceAll("'", "\\'");
		const esc_ip = ip.replaceAll("'", "\\'");
		checkbox = `<input type="checkbox"
                 onclick="setNetif('${esc_name}', '${esc_ip}', this.checked)"
                 ${enabled ? "checked" : ""}>`;
	}

	const html = `
    <tr>
      <td>${checkbox}</td>
      <td class="netif_name"></td>
      <td class="netif_ip"></td>
      <td class="netif_tp ${isBold ? "font-weight-bold" : ""}"></td>
    </tr>`;

	const entry = $($.parseHTML(html));
	entry.find(".netif_name").text(name);
	entry.find(".netif_ip").text(ip);
	entry.find(".netif_tp").text(throughput);
	if (error) {
		const cb = entry.find("input");
		cb.prop("disabled", true);
		cb.attr("title", `Can't enable: ${error}`);
	}

	return entry;
}

export function updateNetif(netifs: Record<string, NetworkInterface>) {
	const modemList = [];
	let totalKbps = 0;

	for (const i in netifs) {
		const data = netifs[i];
		const tpKbps = Math.round((data.tp * 8) / 1024);
		totalKbps += tpKbps;

		modemList.push(
			genNetifEntry(data.error, data.enabled, i, data.ip, `${tpKbps} Kbps`),
		);
	}

	if (Object.keys(netifs).length > 1) {
		modemList.push(
			genNetifEntry(undefined, undefined, "", "", `${totalKbps} Kbps`, true),
		);
	}

	$("#modems").html(modemList as unknown as string);
}
