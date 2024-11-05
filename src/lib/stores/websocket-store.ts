import { ENV_VARIABLES } from '../env';
import { get, readonly, writable } from 'svelte/store';
import { toast } from 'svelte-sonner';
import type {
  AudioCodecsMessage,
  AuthMessage,
  ConfigMessage,
  NetifMessage,
  NotificationsMessage,
  PipelinesMessage,
  RevisionsMessage,
  SensorsStatusMessage,
  StatusMessage,
  WifiMessage,
} from '../types/socket-messages';

const AuthStore = writable<AuthMessage>();
const AudioCodecsStore = writable<AudioCodecsMessage>();
const ConfigStore = writable<ConfigMessage>();
const NetifStore = writable<NetifMessage>();
const NotificationsStore = writable<NotificationsMessage>();
const PipelinesStore = writable<PipelinesMessage>();
const RevisionsStore = writable<RevisionsMessage>();
const SensorsStatusStore = writable<SensorsStatusMessage>();
const StatusStore = writable<StatusMessage>();
const WifiStore = writable<WifiMessage>();

const connectionUrl = `${ENV_VARIABLES.SOCKET_ENDPOINT}:${ENV_VARIABLES.SOCKET_PORT}`;
const socket = new WebSocket(connectionUrl);

// Connection opened
socket.addEventListener('open', function () {
  toast.info('Connection', { duration: 5000, description: 'The connection with the device has been stablished.' });
  setInterval(function () {
    if (socket) {
      socket.send(JSON.stringify({ keepalive: null }));
    }
  }, 10000);
});

socket.addEventListener('error', function () {
  toast.error('Connection', {
    duration: 5000,
    description: 'It has not been able to communicate with the devices, trying to reconnect as soon as possible',
  });
});

function sendAuthMessage(password: string, isPersistent: boolean, onError: (() => unknown) | undefined = undefined) {
  const auth_req = { auth: { password, persistent_token: isPersistent } };
  sendMessage(JSON.stringify(auth_req), () => {
    toast.error('Authentication failed', {
      duration: 5000,
      description: 'The connection with the server could not be stablished',
    });
    onError?.();
  });
}

//   Listen for messages
socket.addEventListener('message', function (event: MessageEvent<string>) {
  assignMessage(event.data);
});

const assignMessage = (message: string) => {
  const parsedMessage = JSON.parse(message);
  switch (Object.keys(parsedMessage)[0]) {
    case 'auth':
      AuthStore.set(parsedMessage.auth);
      break;
    case 'acodecs':
      AudioCodecsStore.set(parsedMessage.acodecs);
      break;
    case 'config':
      ConfigStore.set(parsedMessage.config);
      break;
    case 'netif':
      NetifStore.set(parsedMessage.netif);
      break;
    case 'notification':
      NotificationsStore.set(parsedMessage.notification);
      break;
    case 'pipelines':
      PipelinesStore.set(parsedMessage.pipelines);
      break;
    case 'revisions':
      RevisionsStore.set(parsedMessage.revisions);
      break;
    case 'sensors':
      SensorsStatusStore.set(parsedMessage.sensors);
      break;
    case 'status':
      StatusStore.set({ ...get(StatusStore), ...parsedMessage.status });
      break;
    case 'wifi':
      WifiStore.set(parsedMessage.wifi);
  }
};

const sendMessage = (message: string, onTimeout: (() => unknown) | undefined = undefined) => {
  waitForSocketConnection(
    socket,
    50,
    () => {
      socket.send(message);
    },
    10000,
    onTimeout,
  );
};

// Make the function wait until the connection is made...
function waitForSocketConnection(
  socket: WebSocket,
  checkTime: number,
  callback: () => unknown,
  maxWaitingTime: number = 10000,
  onTimeout: undefined | (() => unknown) = undefined,
  executionTime = 0,
) {
  setTimeout(() => {
    if (socket.readyState === 1) {
      if (callback != null) {
        callback();
      }
    } else {
      executionTime += checkTime;
      if (executionTime >= maxWaitingTime) {
        console.warn('Timeout Reached awaiting for socket connection.');
        onTimeout?.();
      } else {
        console.log('wait for connection...');
        waitForSocketConnection(socket, checkTime, callback, maxWaitingTime, onTimeout, executionTime);
      }
    }
  }, checkTime);
}

const AuthMessages = readonly(AuthStore);
const AudioCodesMessage = readonly(AudioCodecsStore);
const NetifMessages = readonly(NetifStore);
const NotificationsMessages = readonly(NotificationsStore);
const ConfigMessages = readonly(ConfigStore);
const PipelinesMessages = readonly(PipelinesStore);
const RevisionsMessages = readonly(RevisionsStore);
const SensorsStatusMessages = readonly(SensorsStatusStore);
const StatusMessages = readonly(StatusStore);
const WifiMessages = readonly(WifiStore);

export {
  AudioCodesMessage,
  AuthMessages,
  ConfigMessages,
  NetifMessages,
  NotificationsMessages,
  PipelinesMessages,
  RevisionsMessages,
  SensorsStatusMessages,
  StatusMessages,
  WifiMessages,
  sendAuthMessage,
  sendMessage,
  socket,
};
