#!/usr/bin/env bash
# check-t18-doc-coverage.sh
#
# Verifies that every symbol and prose anchor introduced by T1-T17
# (dev-parity-ux pass) is documented in the relevant AGENTS.md / README files.
# Exits non-zero if any anchor is missing or if the tech-debt gate is red.
#
# Usage: bash scripts/check-t18-doc-coverage.sh
# Run from the CeraUI workspace root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CERAUI_AGENTS="${ROOT}/AGENTS.md"
BACKEND_AGENTS="${ROOT}/apps/backend/AGENTS.md"
FRONTEND_AGENTS="${ROOT}/apps/frontend/AGENTS.md"
README="${ROOT}/README.md"

PASS=0
FAIL=0

check() {
  local label="$1"
  local file="$2"
  local pattern="$3"

  if grep -qF -- "${pattern}" "${file}"; then
    echo "  OK  [${label}] '${pattern}' in $(basename "${file}")"
  else
    echo "MISS  [${label}] '${pattern}' NOT FOUND in $(basename "${file}")"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== T18 doc-coverage check ==="
echo ""

# ── T5: scenario-seeded capability profiles ───────────────────────────────────
echo "-- T5: MOCK_SCENARIO values + setMockEngineCapabilities + scenario-seeded --"
check "T5" "${CERAUI_AGENTS}"   "caps-full"
check "T5" "${CERAUI_AGENTS}"   "engine-starting"
check "T5" "${CERAUI_AGENTS}"   "engine-unavailable"
check "T5" "${CERAUI_AGENTS}"   "setMockEngineCapabilities"
check "T5" "${CERAUI_AGENTS}"   "scenario-seeded"
check "T5" "${README}"          "caps-full"
check "T5" "${README}"          "engine-starting"
check "T5" "${README}"          "engine-unavailable"
check "T5" "${BACKEND_AGENTS}"  "caps-full"
check "T5" "${BACKEND_AGENTS}"  "engine-starting"
check "T5" "${BACKEND_AGENTS}"  "engine-unavailable"
check "T5" "${BACKEND_AGENTS}"  "setMockEngineCapabilities"
echo ""

# ── T6: kiosk dev-seam gate ───────────────────────────────────────────────────
echo "-- T6: kiosk dev-seam (resolveActiveKioskDeps, shouldUseMocks) --"
check "T6" "${CERAUI_AGENTS}"   "resolveActiveKioskDeps"
check "T6" "${CERAUI_AGENTS}"   "shouldUseMocks()"
check "T6" "${BACKEND_AGENTS}"  "resolveActiveKioskDeps"
check "T6" "${BACKEND_AGENTS}"  "shouldUseMocks()"
echo ""

# ── T7: add-on dev-seam gate ──────────────────────────────────────────────────
echo "-- T7: add-on dev-seam (resolveActiveAddonManagerDeps, resolveReconcilerDeps) --"
check "T7" "${CERAUI_AGENTS}"   "resolveActiveAddonManagerDeps"
check "T7" "${CERAUI_AGENTS}"   "resolveReconcilerDeps"
check "T7" "${BACKEND_AGENTS}"  "resolveActiveAddonManagerDeps"
check "T7" "${BACKEND_AGENTS}"  "resolveReconcilerDeps"
echo ""

# ── T8: software-update + SSH dev mock seams ──────────────────────────────────
echo "-- T8: software-update + SSH seams --"
check "T8" "${CERAUI_AGENTS}"   "simulateMockSoftwareUpdate"
check "T8" "${CERAUI_AGENTS}"   "setSoftwareUpdateRunner"
check "T8" "${CERAUI_AGENTS}"   "setSshServiceRunner"
check "T8" "${BACKEND_AGENTS}"  "simulateMockSoftwareUpdate"
check "T8" "${BACKEND_AGENTS}"  "setSoftwareUpdateRunner"
check "T8" "${BACKEND_AGENTS}"  "setSshServiceRunner"
echo ""

# ── T1: isDevelopment() power-gate ────────────────────────────────────────────
echo "-- T1: isDevelopment() power-gate --"
check "T1" "${CERAUI_AGENTS}"   "isDevelopment()"
check "T1" "${CERAUI_AGENTS}"   "isDevelopment"
check "T1" "${BACKEND_AGENTS}"  "isDevelopment()"
echo ""

# ── T2: simulateDevReboot ─────────────────────────────────────────────────────
echo "-- T2: simulateDevReboot --"
check "T2" "${CERAUI_AGENTS}"   "simulateDevReboot"
check "T2" "${BACKEND_AGENTS}"  "simulateDevReboot"
echo ""

# ── T3: adapter diagnostics (extractValidationDetails, validation field) ──────
echo "-- T3: adapter diagnostics --"
check "T3" "${CERAUI_AGENTS}"   "extractValidationDetails"
check "T3" "${CERAUI_AGENTS}"   "adapter diagnostics"
check "T3" "${BACKEND_AGENTS}"  "extractValidationDetails"
check "T3" "${BACKEND_AGENTS}"  "adapter diagnostics"
echo ""

# ── T10: e-ink transitions ────────────────────────────────────────────────────
echo "-- T10: e-ink transitions (gateForEink, einkGatedSlide/Fade/Fly) --"
check "T10" "${FRONTEND_AGENTS}" "gateForEink"
check "T10" "${FRONTEND_AGENTS}" "einkGatedSlide"
check "T10" "${FRONTEND_AGENTS}" "einkGatedFade"
check "T10" "${FRONTEND_AGENTS}" "einkGatedFly"
echo ""

# ── T13: onboarding checklist ─────────────────────────────────────────────────
echo "-- T13: OnboardingChecklist + onboarding store --"
check "T13" "${FRONTEND_AGENTS}" "OnboardingChecklist"
check "T13" "${FRONTEND_AGENTS}" "onboarding.svelte.ts"
check "T13" "${FRONTEND_AGENTS}" "live.onboarding"
echo ""

# ── T14: PowerDialog countdown + clearRebooting ───────────────────────────────
echo "-- T14: PowerDialog countdown + clearRebooting --"
check "T14" "${FRONTEND_AGENTS}" "clearRebooting"
check "T14" "${FRONTEND_AGENTS}" "rebootCountdown"
echo ""

# ── T15: disabled-reason hints ────────────────────────────────────────────────
echo "-- T15: disabled-reason hints --"
check "T15" "${FRONTEND_AGENTS}" "disabledReason"
check "T15" "${FRONTEND_AGENTS}" "WifiNetworkList"
echo ""

# ── T16: mapCerastreamError + reason field ────────────────────────────────────
echo "-- T16: mapCerastreamError + reason field --"
check "T16" "${FRONTEND_AGENTS}" "mapCerastreamError"
check "T16" "${FRONTEND_AGENTS}" "live.startFailed"
check "T16" "${BACKEND_AGENTS}"  "mapCerastreamError"
echo ""

# ── T17: i18n placeholder keys ────────────────────────────────────────────────
echo "-- T17: i18n placeholder keys --"
check "T17" "${FRONTEND_AGENTS}" "ipPlaceholder"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "=== Coverage: $((PASS + FAIL - FAIL)) checks passed, ${FAIL} missing ==="
echo ""

if [ "${FAIL}" -gt 0 ]; then
  echo "FAIL: ${FAIL} required symbol(s)/anchor(s) not found in docs."
  echo "      Update the relevant AGENTS.md / README.md files and re-run."
  exit 1
fi

# ── Tech-debt gate ────────────────────────────────────────────────────────────
echo "=== Running tech-debt gate ==="
cd "${ROOT}"
bun run check:tech-debt
bun run test:tech-debt
echo ""
echo "=== All checks passed ==="
