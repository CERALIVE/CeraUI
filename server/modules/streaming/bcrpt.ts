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


import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import {writeTextFile} from "../../helpers/text-files.ts";
import {dnsCacheResolve, dnsCacheValidate} from "../network/dns.ts";
import {bcrptExec} from "./streamloop.ts";
import {buildRelaysMsg, getRelays} from "../remote/remote-relays.ts";
import {broadcastMsg} from "../ui/websocket-server.ts";
import {getIsStreaming} from "./streaming.ts";
import {getNetworkInterfaces} from "../network/network-interfaces.ts";


let bcrpt: ChildProcess | undefined;
let bcrptLowMtuDetected = false;

const bcrptDir = '/var/run/bcrpt';
const bcrptSourceIpsFile = `${bcrptDir}/source_ips`;
const bcrptServerIpsFile = `${bcrptDir}/server_ips`;
const bcrptKeyFile = `${bcrptDir}/key`;

let bcrptIpsToRelays: Record<string, string> = {};
let bcrptRelaysRtt: Record<string, number> = {};

// Getter functions for safe external access
export function hasLowMtu(): boolean {
    return bcrptLowMtuDetected;
}

export function getRelayRtt(relayId: string): number | undefined {
    return bcrptRelaysRtt[relayId];
}

export function getAllRelaysRtt(): Record<string, number> {
    // generate a copy to prevent external code modification
    return { ...bcrptRelaysRtt };
}

export async function updateBcrptSourceIps() {
    await generateBcrptSourceIps();
    reloadBcrpt();
}

async function generateBcrptSourceIps() {
    let contents = '';
    const netif = getNetworkInterfaces()
    for (const i in netif) {
        // Skip hotspots and unusable interfaces with duplicate IPs
        if (netif[i]=== undefined || netif[i].error) continue;
        contents += `${netif[i].ip}\n`;
    }
    await writeTextFile(bcrptSourceIpsFile, contents);
}

export async function updateBcrptServerConfig() {
    await generateBcrptServerIpsFile();
    await generateBcrptKeyFile();
    reloadBcrpt();
}

export async function updateBcrptServerIps() {
    await generateBcrptServerIpsFile();
    reloadBcrpt();
}

async function generateBcrptServerIpsFile() {
    let contents = '';
    const relaysCache = getRelays()
    if (!getIsStreaming() && relaysCache) {
        for (const s in relaysCache.servers) {
            const port = relaysCache.servers[s]?.bcrp_port;
            if (!port) continue;

            const { addrs, fromCache } = await dnsCacheResolve(relaysCache.servers[s]!.addr);
            for (const ip of addrs) {
                const addr = `${ip}:${port}`;
                bcrptIpsToRelays[addr] = s;
                contents += `${addr}\n`;
            }
            if (!fromCache) {
                dnsCacheValidate(relaysCache.servers[s]!.addr);
            }
        }
    }

    await writeTextFile(bcrptServerIpsFile, contents);
}

async function generateBcrptKeyFile() {
    let key = '';
    const relaysCache = getRelays()
    if (relaysCache && relaysCache.bcrp_key) {
        key = relaysCache.bcrp_key;
    }
    await writeTextFile(bcrptKeyFile, key);
}

function reloadBcrpt() {
    if (bcrpt) {
        bcrpt.kill('SIGHUP');
    }
}

export async function startBcrpt() {
    if (!fs.existsSync(bcrptDir)) {
        fs.mkdirSync(bcrptDir);
    }

    try {
        await generateBcrptSourceIps();
        await generateBcrptServerIpsFile();
        await generateBcrptKeyFile();
    } catch(err) {
        setTimeout(startBcrpt, 1000);
        return;
    }

    const args = [bcrptSourceIpsFile, bcrptServerIpsFile, bcrptKeyFile];
    bcrpt = spawn(bcrptExec, args);

    bcrpt.stdout!.on('data', function (data) {
        try {
            const stats = JSON.parse(data.toString('utf8'));

            const rtts: Record<string, number> = {};
            for (const addr in stats.rtt) {
                const relayId = bcrptIpsToRelays[addr]!;
                const rtt = stats.rtt[addr].max_min;
                if (rtts[relayId] === undefined) {
                    rtts[relayId] = rtt;
                } else {
                    rtts[relayId] = Math.max(rtt, rtts[relayId]);
                }
            }
            bcrptRelaysRtt = rtts;

            for (const conn in stats.mtu) {
                if (!bcrptLowMtuDetected && stats.mtu[conn] < 1336) {
                    bcrptLowMtuDetected = true;
                    console.log('Detected low MTU network. Using reduced SRT packet size');
                }
            }

            broadcastMsg('relays', buildRelaysMsg());
        } catch (err) {
            console.log(err);
            console.log(data.toString('utf8'));
        }
    });

    bcrpt.stderr!.on('data', function (data) {
        console.log(`bcrpt: ${data}`);
    });

    bcrpt.on('error', function () {});

    bcrpt.on('close', function (code, signal) {
        let reason;
        if (code != null) {
            reason = `with code ${code}`;
        } else {
            reason = `because of signal ${signal}`;
        }
        console.log(`bcrpt exited unexpectedly ${reason}. Restarting it.`);
        setTimeout(startBcrpt, 1000);
    });
}
