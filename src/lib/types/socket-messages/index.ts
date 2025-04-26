import type { WifiBandNames } from '$lib/helpers/NetworkHelper';
import type { AudioCodecs } from '$lib/helpers/SystemHelper';

type WifiPhysicalNames = `${'wl' | 'wlan'}${string}`;
type EthernetPhysicalNames = `${'eth'}${string}`;
type PyshicalNetworkNames = `${WifiPhysicalNames | EthernetPhysicalNames}${string}`;

export type NotificationType = 'success' | 'warning' | 'error' | 'info';

export type ModemNetworkType = '3g' | '4g' | '4g3g' | '5g' | '5g4g' | '5g3g' | '5g4g3g';
type ConnectionStatus = 'connected' | 'failed' | 'registered' | 'connecting' | 'scanning';
type ModemNetwork = '4G' | '3G' | '5G' | 'Unknown';

export interface ModemConfig {
  apn: string;
  username: string;
  password: string;
  roaming: boolean;
  network: string;
}

interface ModemStatus {
  connection: ConnectionStatus;
  ModemNetwork: string;
  network_type: ModemNetwork;
  signal: number;
  roaming: boolean;
  network?: string;
}

export type ModemList = { [key: string]: Modem };

export interface Modem {
  ifname: string;
  name: string;
  network_type: {
    supported: ModemNetworkType[];
    active: ModemNetworkType;
  };
  config?: ModemConfig; // Optional since a modem with no SIM won't have config
  available_networks: Record<
    number,
    {
      name: string;
      availability: 'available' | 'unavailable';
    }
  >;
  status: ModemStatus;
  no_sim?: boolean; // Optional for modems without a SIM card
}

type Nullable<T> = T | null;
// Message Specific Types
export type AuthMessage = {
  success: boolean;
  auth_token: string;
};

export type AudioCodecsMessage = {
  [key in AudioCodecs]: string;
};

export type ConfigMessage = {
  asrc?: string;
  ssh_pass: string;
  max_br?: number;
  acodec: AudioCodecs;
  delay?: number;
  pipeline?: string;
  srt_latency?: number;
  bitrate_overlay?: boolean;
  srtla_addr?: string;
  srtla_port?: number;
  srt_streamid?: string;
  remote_key?: string;
  relay_account?: string;
  relay_server?: string;
};

export type NetifMessage = {
  [key: PyshicalNetworkNames]: {
    ip?: string;
    tp: number;
    enabled: boolean;
    error?: string;
  };
};
// TODO improve notifications type
export type NotificationsMessage = {
  show: Array<{
    name: string;
    type: NotificationType;
    msg: string;
    is_dismissable: boolean;
    is_persistent: boolean;
    duration: number;
  }>;
};

export type PipelinesMessage = {
  [key: string]: {
    name: string;
    asrc: boolean;
    acodec: boolean;
  };
};

export type RelayMessage = {
  accounts: { [key: string]: { name: string } };
  servers: { [key: string]: { name: string } };
};
export type RevisionsMessage = {
  belaUI: string;
  belacoder: string;
  srtla: string;
  'BELABOX image': string;
};
type StreamBandwidth = `${number} Kbps`;
type StreamName = `RTMP ingest - ${string}`;

export type SensorsStatusMessage = {
  'SoC temperature': `${number} °C`;
  'SoC current'?: `${number} A`;
  'SoC voltage'?: `${number} V`;
  'SRT ingest'?: `${number} Kbps, ${number} ms RTT` | '' | null;
  rtmpIngestStats?: Record<StreamName, StreamBandwidth>;
};

export type WifiSecurity = 'WEP' | 'WPA' | 'WPA2' | 'WPA3';

export type StatusMessage = {
  set_password?: boolean;
  is_streaming: boolean;
  available_updates: {
    package_count: number;
    download_size?: string;
  };
  updating:
    | Nullable<boolean>
    | { downloading: number; unpacking: number; setting_up: number; total: number; result?: number };
  ssh: {
    user: string;
    user_pass: boolean;
    active: boolean;
  };
  wifi: {
    [key: `${number}`]: {
      ifname: PyshicalNetworkNames;
      conn: string;
      hw: string;
      hotspot?: {
        name: string;
        password: string;
        available_channels: {
          [key in WifiBandNames]: { name: string };
        };
        channel: WifiBandNames;
      };
      available: Array<{
        active: boolean;
        ssid: string;
        signal: number;
        security: WifiSecurity;
        freq: number;
      }>;
      saved: {
        [key: string]: string;
      };
      supports_hotspot: boolean;
    };
  };
  asrcs: ['Analog in', 'No audio', 'Pipeline default'];
  modems: ModemList;
};

export type WifiMessage = {
  connect: Array<string>;
  device: number;
  disconnect: string;
  new: { error: 'auth' | 'generic'; device: number | string; success: true };
};
