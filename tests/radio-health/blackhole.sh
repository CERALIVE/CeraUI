#!/usr/bin/env bash
# Host-only network namespace fixture; never uses a physical interface.
set -euo pipefail
fixture_ns="radio-health-fixture-$$"
ip netns add "$fixture_ns"
trap 'ip netns del "$fixture_ns"' EXIT
ip -n "$fixture_ns" link set lo up
ip -n "$fixture_ns" route add blackhole 198.18.0.1/32
ip netns exec "$fixture_ns" python3 - <<'PY'
import http.server, json, subprocess, threading
server=http.server.HTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler)
threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
for _ in range(2):
    bad=subprocess.run(['curl','--noproxy','*','--silent','--max-time','1','http://198.18.0.1/'],capture_output=True)
    good=subprocess.run(['curl','--noproxy','*','--silent','--max-time','1',f'http://127.0.0.1:{server.server_port}/'],capture_output=True)
    results.append({'failed':bad.returncode!=0,'otherPassed':good.returncode==0})
server.shutdown()
assert all(row['failed'] and row['otherPassed'] for row in results),results
print(json.dumps(results))
PY
