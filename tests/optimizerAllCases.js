/**
 * Test optimizer against ALL 10 public sample cases (bypasses LLM).
 * Uses known-correct directives to verify LP solver correctness.
 */
const fs = require("fs");
const path = require("path");
const { optimizeEnergy } = require("../src/services/optimizer");
const { validateHourlyPlan } = require("../src/services/outputValidator");

const casesPath = path.join(__dirname, "..", "..", "PRD", "BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json");
const sampleData = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const cases = sampleData.cases;

console.log(`\n🔧 Optimizer-only test: ALL ${cases.length} sample cases\n`);

let passed = 0;
let failed = 0;

for (const tc of cases) {
  const input = tc.input;
  const directives = tc.expected_output.directive_interpretation;

  process.stdout.write(`  ${tc.id} (${tc.label.padEnd(40)})... `);

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

    totalGrid = Math.round(totalGrid * 100) / 100;
    totalCost = Math.round(totalCost * 100) / 100;

    // Validate
    const validation = validateHourlyPlan(plan, input.hours, input.battery, directives);

    const refCost = tc.expected_output.total_cost_bdt;
    const costOk = totalCost <= refCost + 0.1;

    if (validation.valid && costOk) {
      console.log(`✅ cost=${totalCost} (ref=${refCost})`);
      passed++;
    } else {
      console.log(`❌`);
      if (!validation.valid) {
        validation.errors.forEach((e) => console.log(`     ⚠ ${e}`));
      }
      if (!costOk) {
        console.log(`     ⚠ cost=${totalCost} > ref=${refCost}`);
      }
      failed++;
    }
  } catch (err) {
    console.log(`❌ ERROR: ${err.message}`);
    failed++;
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed}/${cases.length} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
