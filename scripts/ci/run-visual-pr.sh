#!/usr/bin/env bash
set -euo pipefail

export CI=true
export E2E_PASSWORD="${E2E_PASSWORD:-12345678}"
runtime_dir="$PWD/dist/ci-runtime/usr/bin"
chmod +x "$runtime_dir/srtla_send"
export PATH="$runtime_dir:$PATH"
test "$(command -v srtla_send)" = "$runtime_dir/srtla_send"
RUNTIME_DIR="$runtime_dir" bun -e '
const path = "apps/backend/setup.json";
const setup = await Bun.file(path).json();
setup.srtla_path = process.env.RUNTIME_DIR;
await Bun.write(path, JSON.stringify(setup, null, 2) + "\n");
'
bun run --filter @ceraui/i18n generate:i18n
bun run scripts/ci/seed-e2e-auth.ts
mkdir -p apps/frontend/test-results

(
  cd apps/frontend
  exec env VITE_DEVICE_HOST=127.0.0.1 VITE_DEVICE_PORT=3002 node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 6173 --strictPort
) > apps/frontend/test-results/visual-preview.log 2>&1 &
preview_pid=$!
MOCK_SCENARIO=multi-modem-wifi NODE_ENV=development bun run --filter backend dev:e2e \
  > apps/frontend/test-results/visual-backend.log 2>&1 &
backend_pid=$!
trap 'kill "$preview_pid" "$backend_pid" 2>/dev/null || true; wait "$preview_pid" "$backend_pid" 2>/dev/null || true' EXIT

for url in http://127.0.0.1:6173 http://127.0.0.1:3002/api/health; do
  for attempt in {1..120}; do
    if curl -fsS "$url" >/dev/null; then
      echo "ready: $url"
      break
    fi
    if [[ "$attempt" -eq 120 ]]; then
      echo "::error::server did not become ready: $url"
      exit 1
    fi
    sleep 1
  done
done

# Recording supplies the same six-file invocation with an explicit update flag.
if [[ "$#" -gt 0 ]]; then
  "$@"
else
  bun run test:e2e:visual:pr
fi
