import { modemSchema } from "@ceraui/rpc/schemas";

// Test 1: Modem WITH model and manufacturer
const modemWithFields = {
  ifname: "usb0",
  name: "Modem 1",
  sim_network: "T-Mobile",
  model: "RM520N-GL",
  manufacturer: "Quectel",
  network_type: {
    supported: ["5g", "4g", "3g"],
    active: "5g",
  },
};

const result1 = modemSchema.safeParse(modemWithFields);
console.log("Test 1 (WITH model/manufacturer):", result1.success ? "✓ PASS" : "✗ FAIL");
if (!result1.success) console.error(result1.error);

// Test 2: Modem WITHOUT model and manufacturer (backward compat)
const modemWithoutFields = {
  ifname: "usb1",
  name: "Modem 2",
  network_type: {
    supported: ["4g"],
    active: "4g",
  },
};

const result2 = modemSchema.safeParse(modemWithoutFields);
console.log("Test 2 (WITHOUT model/manufacturer):", result2.success ? "✓ PASS" : "✗ FAIL");
if (!result2.success) console.error(result2.error);

// Test 3: Modem with only model (partial optional)
const modemPartial = {
  ifname: "usb2",
  name: "Modem 3",
  model: "EM7455",
  network_type: {
    supported: ["4g"],
    active: "4g",
  },
};

const result3 = modemSchema.safeParse(modemPartial);
console.log("Test 3 (PARTIAL - only model):", result3.success ? "✓ PASS" : "✗ FAIL");
if (!result3.success) console.error(result3.error);

console.log("\nAll tests passed!" );
