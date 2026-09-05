#!/usr/bin/env bash
#
# ui-path-capture-drill.sh — end-to-end capture→encode drill through the REAL
# UI/RPC path.
#
# WHAT IT PROVES
#
#   A stream started the way an operator starts one — an authenticated
#   `auth.login`, a `streaming.setConfig` naming the egress video codec, and a
#   `streaming.start` over the device's own WebSocket RPC socket — produces a
#   bitstream a decoder accepts, in the codec that was asked for.
#
#   Nothing here talks to cerastream directly. Driving the engine's own control
#   socket would prove the ENGINE encodes; it would not prove the operator's
#   path reaches it. The whole point of this drill is the seam between them:
#   config persistence, the source/routing resolution, the launch transaction,
#   and the bounded start retry all run exactly as they do for a human.
#
# WHY H.265 IS THE PRIMARY CODEC
#
#   H.265 is the RK3588 platform default and the codec the VEPU580 encoder path
#   is most likely to refuse (see cerastream's HARDWARE-ENCODER PREFLIGHT). It
#   is therefore the default here; `--codec h264` is the control run, not the
#   normal one.
#
# WHAT IT DOES NOT PROVE
#
#   Nothing about bonding, about a real relay, or about sustained thermals. It
#   captures a short window from ONE receiver on the loopback path.
#
# USAGE
#
#   tests/board/ui-path-capture-drill.sh [--codec h265|h264] [options]
#
#   Run `--help` for the full option list, or `--dry-run` to validate the
#   arguments and print the plan without touching the device.
#
# EXIT CODES
#
#   0  PASS  — the drill ran and the captured bitstream verified
#   1  FAIL  — a step failed; the reason is printed
#   2  USAGE — bad arguments
#
set -uo pipefail

readonly SCRIPT_NAME="${0##*/}"

# --- Defaults ---------------------------------------------------------------
# H.265 first: it is the RK3588 platform default and the codec most likely to
# be refused by the hardware encoder, so it is the run worth gating on.
CODEC="h265"
DURATION_S=20
HOST="127.0.0.1"
PORT=80
PASSWORD="${CERAUI_PASSWORD:-}"
RELAY_HOST="127.0.0.1"
RELAY_PORT=5000
SRT_PORT=5001
RECEIVER="auto"
CAPTURE_FILE=""
OUT_DIR="test-results/ui-path-capture-drill"
START_TIMEOUT_S=90
DRY_RUN=0

usage() {
	cat <<'USAGE'
ui-path-capture-drill.sh — UI-path capture→encode drill (board gate)

Drives a real stream through CeraUI's WebSocket RPC surface, records the
resulting bitstream from a local SRTLA receiver, and verifies it with ffprobe.

OPTIONS
  --codec h265|h264      Egress video codec to request (default: h265)
  --duration SECONDS     Capture window (default: 20)
  --host HOST            CeraUI backend host (default: 127.0.0.1)
  --port PORT            CeraUI backend port (default: 80)
  --password PASSWORD    CeraUI password (default: $CERAUI_PASSWORD)
  --relay-host HOST      Address the device sends SRTLA to (default: 127.0.0.1)
  --relay-port PORT      SRTLA listen port for the receiver (default: 5000)
  --srt-port PORT        Loopback SRT port srtla_rec re-serves on (default: 5001)
  --receiver auto|external
                         auto     start srtla_rec + an ffmpeg SRT recorder here
                         external you already run a receiver writing to
                                  --capture-file; the drill only drives the RPC
  --capture-file PATH    Recording path (required with --receiver external)
  --out-dir DIR          Artifact directory (default: test-results/ui-path-capture-drill)
  --start-timeout SECS   How long to wait for the stream to go live (default: 90)
  --dry-run              Validate arguments, probe tooling, print the plan, exit 0
  -h, --help             This text

ENVIRONMENT
  CERAUI_PASSWORD        Default for --password

EXAMPLES
  # Primary gate run (H.265) on the board itself:
  sudo tests/board/ui-path-capture-drill.sh --password hunter2

  # H.264 control run against a remote board:
  tests/board/ui-path-capture-drill.sh --codec h264 --host 192.168.1.50 --password hunter2

  # Receiver already running elsewhere, recording to /tmp/cap.ts:
  tests/board/ui-path-capture-drill.sh --receiver external --capture-file /tmp/cap.ts \
      --relay-host 192.168.1.10 --password hunter2
USAGE
}

die_usage() {
	printf 'error: %s\n\n' "$1" >&2
	usage >&2
	exit 2
}

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
	printf '\nRESULT: FAIL — %s\n' "$*"
	exit 1
}

# --- Argument parsing -------------------------------------------------------
require_value() {
	# $1 = flag name, $2 = count of remaining argv entries
	[ "$2" -ge 2 ] || die_usage "$1 requires a value"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--codec)
		require_value "$1" "$#"
		CODEC="$2"
		shift 2
		;;
	--duration)
		require_value "$1" "$#"
		DURATION_S="$2"
		shift 2
		;;
	--host)
		require_value "$1" "$#"
		HOST="$2"
		shift 2
		;;
	--port)
		require_value "$1" "$#"
		PORT="$2"
		shift 2
		;;
	--password)
		require_value "$1" "$#"
		PASSWORD="$2"
		shift 2
		;;
	--relay-host)
		require_value "$1" "$#"
		RELAY_HOST="$2"
		shift 2
		;;
	--relay-port)
		require_value "$1" "$#"
		RELAY_PORT="$2"
		shift 2
		;;
	--srt-port)
		require_value "$1" "$#"
		SRT_PORT="$2"
		shift 2
		;;
	--receiver)
		require_value "$1" "$#"
		RECEIVER="$2"
		shift 2
		;;
	--capture-file)
		require_value "$1" "$#"
		CAPTURE_FILE="$2"
		shift 2
		;;
	--out-dir)
		require_value "$1" "$#"
		OUT_DIR="$2"
		shift 2
		;;
	--start-timeout)
		require_value "$1" "$#"
		START_TIMEOUT_S="$2"
		shift 2
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die_usage "unknown argument '$1'"
		;;
	esac
done

case "$CODEC" in
h264 | h265) ;;
*) die_usage "--codec must be 'h265' or 'h264' (got '$CODEC')" ;;
esac

case "$RECEIVER" in
auto | external) ;;
*) die_usage "--receiver must be 'auto' or 'external' (got '$RECEIVER')" ;;
esac

is_uint() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

is_uint "$DURATION_S" || die_usage "--duration must be a positive integer"
[ "$DURATION_S" -gt 0 ] || die_usage "--duration must be a positive integer"
is_uint "$PORT" || die_usage "--port must be a port number"
is_uint "$RELAY_PORT" || die_usage "--relay-port must be a port number"
is_uint "$SRT_PORT" || die_usage "--srt-port must be a port number"
is_uint "$START_TIMEOUT_S" || die_usage "--start-timeout must be a positive integer"

if [ "$RECEIVER" = "external" ] && [ -z "$CAPTURE_FILE" ]; then
	die_usage "--receiver external requires --capture-file"
fi

if [ "$RELAY_PORT" = "$SRT_PORT" ]; then
	die_usage "--relay-port and --srt-port must differ"
fi

if [ -z "$CAPTURE_FILE" ]; then
	CAPTURE_FILE="$OUT_DIR/capture-$CODEC.ts"
fi

# ffprobe names the codecs differently from the wire enum; keep the mapping in
# ONE place so a future codec cannot drift between what we ask for and what we
# assert on.
case "$CODEC" in
h264) EXPECT_CODEC_NAME="h264" ;;
h265) EXPECT_CODEC_NAME="hevc" ;;
esac

# --- Environment probe ------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

probe_line() {
	if have "$1"; then
		printf '  %-16s present  (%s)\n' "$1" "$(command -v "$1")"
	else
		printf '  %-16s ABSENT\n' "$1"
	fi
}

echo "=================================================================="
echo " CeraUI UI-path capture drill"
echo "   codec        : $CODEC (ffprobe expects '$EXPECT_CODEC_NAME')"
echo "   backend      : ws://$HOST:$PORT/ws"
echo "   duration     : ${DURATION_S}s"
echo "   receiver     : $RECEIVER"
echo "   relay        : srtla://$RELAY_HOST:$RELAY_PORT"
echo "   capture file : $CAPTURE_FILE"
echo "=================================================================="
echo
echo "Tooling:"
probe_line bun
probe_line ffprobe
[ "$RECEIVER" = "auto" ] && probe_line ffmpeg
[ "$RECEIVER" = "auto" ] && probe_line srtla_rec

if [ "$DRY_RUN" -eq 1 ]; then
	echo
	echo "Plan (dry run — nothing was started):"
	echo "  1. auth.login on ws://$HOST:$PORT/ws"
	echo "  2. streaming.setConfig { video_codec: $CODEC, srtla_addr: $RELAY_HOST, srtla_port: $RELAY_PORT }"
	if [ "$RECEIVER" = "auto" ]; then
		echo "  3. srtla_rec $RELAY_PORT 127.0.0.1 $SRT_PORT  +  ffmpeg SRT listener on $SRT_PORT"
	else
		echo "  3. (external receiver — already recording to $CAPTURE_FILE)"
	fi
	echo "  4. streaming.start {} and wait up to ${START_TIMEOUT_S}s for a live stream"
	echo "  5. capture ${DURATION_S}s, then streaming.stop"
	echo "  6. ffprobe $CAPTURE_FILE and assert the video codec is '$EXPECT_CODEC_NAME'"
	echo
	echo "RESULT: DRY RUN OK"
	exit 0
fi

MISSING=""
have bun || MISSING="$MISSING bun"
have ffprobe || MISSING="$MISSING ffprobe"
if [ "$RECEIVER" = "auto" ]; then
	have ffmpeg || MISSING="$MISSING ffmpeg"
	have srtla_rec || MISSING="$MISSING srtla_rec"
fi
if [ -n "$MISSING" ]; then
	fail "missing required tooling:$MISSING (run with --dry-run to see the probe, or use --receiver external)"
fi

if [ -z "$PASSWORD" ]; then
	fail "no password: pass --password or set CERAUI_PASSWORD"
fi

mkdir -p "$OUT_DIR" || fail "cannot create $OUT_DIR"
RPC_LOG="$OUT_DIR/rpc-$CODEC.log"
RECEIVER_LOG="$OUT_DIR/receiver-$CODEC.log"
PROBE_JSON="$OUT_DIR/ffprobe-$CODEC.json"

SRTLA_PID=""
FFMPEG_PID=""
STOP_SENT=0

# --- The RPC driver ---------------------------------------------------------
# Embedded rather than a sibling .ts file on purpose: this script gets copied
# onto a board on its own, and a two-file drill silently half-works when only
# one file makes the trip. It speaks the backend's own Bun-WebSocket framing
# ({id, path, input} -> {id, result|error}) — the same frames the browser sends.
rpc_driver() {
	local action="$1"
	bun -e '
const [action, host, port, password, codec, relayHost, relayPort, startTimeoutS] = process.argv.slice(1);
const url = `ws://${host}:${port}/ws`;
const deadlineMs = Number(startTimeoutS) * 1000;

const out = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
const fatal = (message) => {
  process.stdout.write(`DRIVER_ERROR ${message}\n`);
  process.exit(1);
};

const socket = new WebSocket(url);
const pending = new Map();
let nextId = 0;
let streaming = false;

socket.addEventListener("message", (event) => {
  let frame;
  try {
    frame = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (frame && typeof frame.id === "string" && pending.has(frame.id)) {
    const entry = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(frame.error.message ?? "rpc error"));
    else entry.resolve(frame.result);
    return;
  }
  // Broadcast frames carry the lifecycle we wait on. `is_streaming` is the
  // legacy flag; `stream_lifecycle` is the typed one. Trust either, because a
  // board may be running an older backend than this drill.
  if (frame && typeof frame === "object" && frame.status) {
    const status = frame.status;
    if (status.is_streaming === true || status.stream_lifecycle === "streaming") streaming = true;
    if (status.is_streaming === false && status.stream_lifecycle !== "streaming") streaming = false;
  }
  if (frame && typeof frame === "object" && frame.ping) {
    socket.send(JSON.stringify({ pong: frame.ping }));
  }
});

const call = (path, input) =>
  new Promise((resolve, reject) => {
    const id = `drill-${nextId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${path.join(".")}`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, path, input }));
  });

const opened = new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await Promise.race([
    opened,
    sleep(15000).then(() => { throw new Error(`connect timeout: ${url}`); }),
  ]);

  const login = await call(["auth", "login"], { password, persistent_token: false });
  if (!login || login.success !== true) fatal("auth.login refused the password");
  out("LOGIN_OK");

  if (action === "stop") {
    const stopped = await call(["streaming", "stop"], {});
    out(`STOP ${JSON.stringify(stopped)}`);
    socket.close();
    process.exit(0);
  }

  const applied = await call(["streaming", "setConfig"], {
    video_codec: codec,
    srtla_addr: relayHost,
    srtla_port: Number(relayPort),
  });
  if (!applied || applied.success !== true) {
    fatal(`streaming.setConfig refused: ${JSON.stringify(applied)}`);
  }
  out(`SETCONFIG_OK ${JSON.stringify(applied.applied ?? {})}`);

  const started = await call(["streaming", "start"], {});
  out(`START ${JSON.stringify(started)}`);
  if (started && started.success === false) {
    fatal(`streaming.start failed: ${JSON.stringify(started)}`);
  }

  const until = Date.now() + deadlineMs;
  while (!streaming && Date.now() < until) await sleep(500);
  if (!streaming) fatal(`stream never reported live within ${startTimeoutS}s`);
  out("STREAMING_LIVE");
  socket.close();
  process.exit(0);
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}
' "$action" "$HOST" "$PORT" "$PASSWORD" "$CODEC" "$RELAY_HOST" "$RELAY_PORT" "$START_TIMEOUT_S"
}

cleanup() {
	local status=$?
	if [ "$STOP_SENT" -eq 0 ]; then
		STOP_SENT=1
		log "cleanup: stopping the stream"
		rpc_driver stop >>"$RPC_LOG" 2>&1 || true
	fi
	[ -n "$FFMPEG_PID" ] && kill "$FFMPEG_PID" 2>/dev/null
	[ -n "$SRTLA_PID" ] && kill "$SRTLA_PID" 2>/dev/null
	wait 2>/dev/null
	return "$status"
}
trap cleanup EXIT INT TERM

# --- Step 1: receiver -------------------------------------------------------
if [ "$RECEIVER" = "auto" ]; then
	log "[1/5] starting srtla_rec on :$RELAY_PORT -> srt 127.0.0.1:$SRT_PORT"
	srtla_rec "$RELAY_PORT" 127.0.0.1 "$SRT_PORT" >>"$RECEIVER_LOG" 2>&1 &
	SRTLA_PID=$!
	sleep 1
	kill -0 "$SRTLA_PID" 2>/dev/null || fail "srtla_rec exited immediately (see $RECEIVER_LOG)"

	# The recorder listens; srtla_rec dials it. `-c copy` keeps the bitstream
	# byte-identical, so ffprobe judges what the encoder produced rather than
	# what a transcode produced.
	rm -f "$CAPTURE_FILE"
	log "[1/5] starting ffmpeg SRT recorder on :$SRT_PORT -> $CAPTURE_FILE"
	ffmpeg -hide_banner -loglevel warning -y \
		-i "srt://0.0.0.0:$SRT_PORT?mode=listener&latency=200000" \
		-t "$DURATION_S" -c copy -f mpegts "$CAPTURE_FILE" \
		>>"$RECEIVER_LOG" 2>&1 &
	FFMPEG_PID=$!
	sleep 1
	kill -0 "$FFMPEG_PID" 2>/dev/null || fail "ffmpeg recorder exited immediately (see $RECEIVER_LOG)"
else
	log "[1/5] using external receiver; expecting a recording at $CAPTURE_FILE"
fi

# --- Step 2: drive the UI path ---------------------------------------------
log "[2/5] auth.login + streaming.setConfig(video_codec=$CODEC) + streaming.start"
if ! rpc_driver start | tee "$RPC_LOG"; then
	fail "the RPC path did not reach a live stream (see $RPC_LOG)"
fi

# --- Step 3: capture --------------------------------------------------------
log "[3/5] capturing ${DURATION_S}s"
if [ "$RECEIVER" = "auto" ]; then
	# The recorder's own -t bounds the window; add slack for connect latency.
	CAPTURE_DEADLINE=$((DURATION_S + 15))
	ELAPSED=0
	while kill -0 "$FFMPEG_PID" 2>/dev/null && [ "$ELAPSED" -lt "$CAPTURE_DEADLINE" ]; do
		sleep 1
		ELAPSED=$((ELAPSED + 1))
	done
	if kill -0 "$FFMPEG_PID" 2>/dev/null; then
		kill "$FFMPEG_PID" 2>/dev/null
		wait "$FFMPEG_PID" 2>/dev/null
	fi
	FFMPEG_PID=""
else
	sleep "$DURATION_S"
fi

# --- Step 4: stop -----------------------------------------------------------
log "[4/5] streaming.stop"
STOP_SENT=1
rpc_driver stop >>"$RPC_LOG" 2>&1 || log "warning: stop RPC reported an error (see $RPC_LOG)"

# --- Step 5: verify ---------------------------------------------------------
log "[5/5] verifying $CAPTURE_FILE"
[ -s "$CAPTURE_FILE" ] || fail "no bytes captured — the device produced nothing (see $RECEIVER_LOG)"

if ! ffprobe -hide_banner -loglevel error -show_streams -show_format \
	-print_format json "$CAPTURE_FILE" >"$PROBE_JSON" 2>>"$RECEIVER_LOG"; then
	fail "ffprobe could not parse the capture (see $PROBE_JSON / $RECEIVER_LOG)"
fi

ACTUAL_CODEC="$(
	ffprobe -hide_banner -loglevel error -select_streams v:0 \
		-show_entries stream=codec_name -of default=nw=1:nk=1 "$CAPTURE_FILE" 2>/dev/null | head -n 1
)"
[ -n "$ACTUAL_CODEC" ] || fail "no video stream in the capture"

if [ "$ACTUAL_CODEC" != "$EXPECT_CODEC_NAME" ]; then
	fail "codec mismatch: asked for '$CODEC' (ffprobe '$EXPECT_CODEC_NAME'), captured '$ACTUAL_CODEC'"
fi

FRAMES="$(
	ffprobe -hide_banner -loglevel error -select_streams v:0 \
		-count_frames -show_entries stream=nb_read_frames \
		-of default=nw=1:nk=1 "$CAPTURE_FILE" 2>/dev/null | head -n 1
)"
case "$FRAMES" in
'' | 'N/A' | 0) fail "the capture decodes to zero frames" ;;
esac

CAPTURE_BYTES="$(wc -c <"$CAPTURE_FILE" | tr -d ' ')"

echo
echo "  codec  : $ACTUAL_CODEC"
echo "  frames : $FRAMES"
echo "  bytes  : $CAPTURE_BYTES"
echo "  probe  : $PROBE_JSON"
echo
echo "RESULT: PASS — the UI path produced a decodable $CODEC stream"
exit 0
