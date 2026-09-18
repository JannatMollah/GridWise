/**
 * Quick test: Optimizer-only test (bypasses LLM).
 * Tests the LP solver directly with known directives from SAMPLE-01.
 */
const fs = require("fs");
const path = require("path");
const { optimizeEnergy } = require("../src/services/optimizer");
const { validateHourlyPlan } = require("../src/services/outputValidator");

const casesPath = path.join(__dirname, "..", "..", "PRD", "BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json");
const sampleData = JSON.parse(fs.readFileSync(casesPath, "utf8"));

// Test SAMPLE-01: Solar cleaning + distractor
const tc = sampleData.cases[0]; // SAMPLE-01
const input = tc.input;

// Use the known-correct directives (bypass LLM)
const directives = tc.expected_output.directive_interpretation;

console.log(`\n🔧 Optimizer-only test: ${tc.id} (${tc.label})\n`);
console.log("Directives:", JSON.stringify(directives, null, 2));

try {
  const plan = optimizeEnergy(input.hours, input.battery, directives);

  // Calculate totals
  let totalGrid = 0;
  let totalCost = 0;
  let peakGrid = 0;
  const tariffMap = {};
  for (const h of input.hours) tariffMap[h.hour] = h.tariff_bdt_per_kwh;

  for (const entry of plan) {
    totalGrid += entry.grid_kwh;
    totalCost += entry.grid_kwh * tariffMap[entry.hour];
    peakGrid = Math.max(peakGrid, entry.grid_kwh);
  }

  console.log("\n📊 Results:");
  console.log(`  Total grid: ${Math.round(totalGrid * 100) / 100} kWh (expected: ${tc.expected_output.total_grid_kwh})`);
  console.log(`  Total cost: ${Math.round(totalCost * 100) / 100} BDT (expected: ${tc.expected_output.total_cost_bdt})`);
  console.log(`  Peak grid:  ${Math.round(peakGrid * 100) / 100} kWh (expected: ${tc.expected_output.peak_grid_kwh})`);

  // Validate
  const validation = validateHourlyPlan(plan, input.hours, input.battery, directives);
  if (validation.valid) {
    console.log("\n✅ Hourly plan is VALID");
  } else {
    console.log("\n❌ Hourly plan has errors:");
    validation.errors.forEach((e) => console.log(`  ⚠ ${e}`));
  }

  // Compare cost with reference
  const refCost = tc.expected_output.total_cost_bdt;
  const costRatio = refCost / totalCost;
  console.log(`\n  Cost ratio (ref/actual): ${costRatio.toFixed(4)}`);
  if (totalCost <= refCost + 0.01) {
    console.log("  ✅ Cost is optimal or better than reference");
  } else {
    console.log(`  ⚠ Cost is ${(totalCost - refCost).toFixed(2)} BDT higher than reference`);
  }

  // Print first few hours for inspection
  console.log("\nHourly plan (first 6 hours):");
  console.log("Hour | Grid    | Solar   | Action    | BattKwh | BattAfter");
  for (let i = 0; i < 6; i++) {
    const h = plan[i];
    console.log(
      `  ${String(h.hour).padStart(2)} | ${String(h.grid_kwh).padStart(7)} | ${String(h.solar_used_kwh).padStart(7)} | ${h.battery_action.padEnd(9)} | ${String(h.battery_kwh).padStart(7)} | ${String(h.battery_energy_after_kwh).padStart(9)}`
    );
  }

} catch (err) {
  console.error("❌ Optimizer failed:", err.message);
  console.error(err.stack);
}
