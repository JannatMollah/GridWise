/**
 * End-to-end test runner for the 10 public sample cases.
 * Loads cases from the PRD JSON file, POSTs each to /optimize-energy,
 * and validates directive interpretation + hourly plan correctness.
 *
 * Usage: node tests/sampleCases.test.js
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const TOLERANCE = 0.01;
const BASE_URL = process.env.TEST_URL || "http://localhost:8000";

// ── Load sample cases ──
// Try multiple paths for the sample cases JSON
const possiblePaths = [
  path.join(__dirname, "..", "PRD", "BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json"),
  path.join(__dirname, "..", "..", "PRD", "BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json"),
  path.join(process.cwd(), "PRD", "BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json"),
];
let sampleData;
for (const p of possiblePaths) {
  try {
    sampleData = JSON.parse(fs.readFileSync(p, "utf8"));
    break;
  } catch (_) { /* try next */ }
}
if (!sampleData) {
  console.error("Failed to load sample cases from any known path");
  process.exit(1);
}

const cases = sampleData.cases;

// ── HTTP POST helper ──
function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 30000,
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body: body });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(data);
    req.end();
  });
}

// ── Validation helpers ──
function approxEqual(a, b, tol = TOLERANCE) {
  return Math.abs(a - b) <= tol;
}

function validateDirectiveInterpretation(actual, expected, caseId) {
  const errors = [];

  if (actual.length !== expected.length) {
    errors.push(`${caseId}: interpretation count ${actual.length} != expected ${expected.length}`);
    return errors;
  }

  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];

    if (a.note_index !== e.note_index) {
      errors.push(`${caseId} note ${i}: note_index ${a.note_index} != ${e.note_index}`);
    }
    if (a.applies !== e.applies) {
      errors.push(`${caseId} note ${i}: applies ${a.applies} != ${e.applies}`);
    }
    if (a.directive_type !== e.directive_type) {
      errors.push(`${caseId} note ${i}: directive_type "${a.directive_type}" != "${e.directive_type}"`);
    }

    // Validate structured_adjustment
    if (e.structured_adjustment === null) {
      if (a.structured_adjustment !== null) {
        errors.push(`${caseId} note ${i}: expected null adjustment, got ${JSON.stringify(a.structured_adjustment)}`);
      }
    } else if (a.structured_adjustment === null) {
      errors.push(`${caseId} note ${i}: expected adjustment, got null`);
    } else {
      // Compare hours
      if (e.structured_adjustment.hours) {
        const expHours = JSON.stringify(e.structured_adjustment.hours);
        const actHours = JSON.stringify(a.structured_adjustment.hours || []);
        if (expHours !== actHours) {
          errors.push(`${caseId} note ${i}: hours ${actHours} != ${expHours}`);
        }
      }
      // Compare factor
      if (e.structured_adjustment.factor !== undefined) {
        if (!approxEqual(a.structured_adjustment.factor || 0, e.structured_adjustment.factor)) {
          errors.push(`${caseId} note ${i}: factor ${a.structured_adjustment.factor} != ${e.structured_adjustment.factor}`);
        }
      }
      // Compare minimum_energy_kwh
      if (e.structured_adjustment.minimum_energy_kwh !== undefined) {
        if (!approxEqual(a.structured_adjustment.minimum_energy_kwh || 0, e.structured_adjustment.minimum_energy_kwh)) {
          errors.push(`${caseId} note ${i}: minimum_energy_kwh ${a.structured_adjustment.minimum_energy_kwh} != ${e.structured_adjustment.minimum_energy_kwh}`);
        }
      }
      // Compare max_grid_kwh
      if (e.structured_adjustment.max_grid_kwh !== undefined) {
        if (!approxEqual(a.structured_adjustment.max_grid_kwh || 0, e.structured_adjustment.max_grid_kwh)) {
          errors.push(`${caseId} note ${i}: max_grid_kwh ${a.structured_adjustment.max_grid_kwh} != ${e.structured_adjustment.max_grid_kwh}`);
        }
      }
    }
  }

  return errors;
}

function validateHourlyPlan(plan, input, directives, caseId) {
  const errors = [];
  const hours = [...input.hours].sort((a, b) => a.hour - b.hour);
  const battery = input.battery;

  if (!Array.isArray(plan) || plan.length !== 24) {
    errors.push(`${caseId}: hourly_plan must have 24 entries, got ${plan?.length}`);
    return errors;
  }

  const sorted = [...plan].sort((a, b) => a.hour - b.hour);

  // Compute effective solar
  const effectiveSolar = hours.map((h) => h.solar_kwh);
  for (const d of directives) {
    if (d.applies && d.directive_type === "solar_reduction") {
      for (const h of d.structured_adjustment.hours) {
        effectiveSolar[h] = hours[h].solar_kwh * d.structured_adjustment.factor;
      }
    }
  }

  // Collect directive constraints
  const noCharge = new Set();
  const noDischarge = new Set();
  const minReserve = {};
  const maxGrid = {};

  for (const d of directives) {
    if (!d.applies || !d.structured_adjustment) continue;
    switch (d.directive_type) {
      case "no_charge_window":
        for (const h of d.structured_adjustment.hours) noCharge.add(h);
        break;
      case "no_discharge_window":
        for (const h of d.structured_adjustment.hours) noDischarge.add(h);
        break;
      case "minimum_battery_reserve":
        for (const h of d.structured_adjustment.hours) {
          minReserve[h] = Math.max(minReserve[h] || battery.minimum_energy_kwh, d.structured_adjustment.minimum_energy_kwh);
        }
        break;
      case "max_grid_window":
        for (const h of d.structured_adjustment.hours) {
          maxGrid[h] = maxGrid[h] !== undefined ? Math.min(maxGrid[h], d.structured_adjustment.max_grid_kwh) : d.structured_adjustment.max_grid_kwh;
        }
        break;
    }
  }

  let battEnergy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const e = sorted[h];
    const demand = hours[h].demand_kwh;
    const maxSol = effectiveSolar[h];
    const minE = minReserve[h] || battery.minimum_energy_kwh;

    // Solar limit
    if (e.solar_used_kwh > maxSol + TOLERANCE) {
      errors.push(`${caseId} h${h}: solar_used ${e.solar_used_kwh} > effective ${maxSol}`);
    }

    // Energy balance
    const charge = e.battery_action === "charge" ? e.battery_kwh : 0;
    const discharge = e.battery_action === "discharge" ? e.battery_kwh : 0;
    const lhs = e.grid_kwh + e.solar_used_kwh + discharge;
    const rhs = demand + charge;
    if (!approxEqual(lhs, rhs)) {
      errors.push(`${caseId} h${h}: balance ${lhs} != ${rhs}`);
    }

    // Battery state
    battEnergy = battEnergy + charge - discharge;

    if (battEnergy < minE - TOLERANCE) {
      errors.push(`${caseId} h${h}: battery ${battEnergy} < min ${minE}`);
    }
    if (battEnergy > battery.capacity_kwh + TOLERANCE) {
      errors.push(`${caseId} h${h}: battery ${battEnergy} > capacity ${battery.capacity_kwh}`);
    }

    // Directive constraints
    if (noCharge.has(h) && charge > TOLERANCE) {
      errors.push(`${caseId} h${h}: charging during no_charge_window`);
    }
    if (noDischarge.has(h) && discharge > TOLERANCE) {
      errors.push(`${caseId} h${h}: discharging during no_discharge_window`);
    }
    if (maxGrid[h] !== undefined && e.grid_kwh > maxGrid[h] + TOLERANCE) {
      errors.push(`${caseId} h${h}: grid ${e.grid_kwh} > max ${maxGrid[h]}`);
    }

    // Idle check
    if (e.battery_action === "idle" && e.battery_kwh > TOLERANCE) {
      errors.push(`${caseId} h${h}: idle but battery_kwh > 0`);
    }
  }

  // End-of-day
  if (!approxEqual(battEnergy, battery.initial_energy_kwh)) {
    errors.push(`${caseId}: end-of-day battery ${battEnergy} != initial ${battery.initial_energy_kwh}`);
  }

  return errors;
}

// ── Main test runner ──
async function runTests() {
  console.log(`\n🔬 GridWise Public Sample Case Test Runner`);
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Cases: ${cases.length}\n`);


  let passed = 0;
  let failed = 0;
  let totalErrors = [];

  for (const tc of cases) {
    const caseId = tc.id;
    process.stdout.write(`  Testing ${caseId} (${tc.label})... `);

    try {
      const startTime = Date.now();
      const result = await postJSON(`${BASE_URL}/optimize-energy`, tc.input);
      const elapsed = Date.now() - startTime;

      if (result.status !== 200) {
        console.log(`❌ HTTP ${result.status} (${elapsed}ms)`);
        totalErrors.push(`${caseId}: HTTP ${result.status} - ${JSON.stringify(result.body).slice(0, 200)}`);
        failed++;
        continue;
      }

      const resp = result.body;
      const errors = [];

      // Validate scenario_id echo
      if (resp.scenario_id !== tc.input.scenario_id) {
        errors.push(`${caseId}: scenario_id mismatch`);
      }

      // Validate directive interpretation
      if (resp.directive_interpretation) {
        errors.push(...validateDirectiveInterpretation(
          resp.directive_interpretation,
          tc.expected_output.directive_interpretation,
          caseId
        ));
      } else {
        errors.push(`${caseId}: missing directive_interpretation`);
      }

      // Validate hourly plan
      if (resp.hourly_plan) {
        errors.push(...validateHourlyPlan(
          resp.hourly_plan,
          tc.input,
          resp.directive_interpretation || [],
          caseId
        ));
      } else {
        errors.push(`${caseId}: missing hourly_plan`);
      }

      // Validate totals recalculated from hourly_plan
      if (resp.hourly_plan && resp.hourly_plan.length === 24) {
        const recalcGrid = resp.hourly_plan.reduce((s, h) => s + h.grid_kwh, 0);
        if (!approxEqual(recalcGrid, resp.total_grid_kwh, 0.1)) {
          errors.push(`${caseId}: total_grid_kwh mismatch (${resp.total_grid_kwh} vs recalc ${Math.round(recalcGrid * 100) / 100})`);
        }

        // Recalculate total_cost_bdt from hourly_plan
        const tariffMap = {};
        for (const h of tc.input.hours) tariffMap[h.hour] = h.tariff_bdt_per_kwh;
        const recalcCost = resp.hourly_plan.reduce((s, h) => s + h.grid_kwh * (tariffMap[h.hour] || 0), 0);
        if (!approxEqual(recalcCost, resp.total_cost_bdt, 0.1)) {
          errors.push(`${caseId}: total_cost_bdt mismatch (${resp.total_cost_bdt} vs recalc ${Math.round(recalcCost * 100) / 100})`);
        }

        // Validate peak_grid_kwh
        const recalcPeak = Math.max(...resp.hourly_plan.map(h => h.grid_kwh));
        if (!approxEqual(recalcPeak, resp.peak_grid_kwh, 0.1)) {
          errors.push(`${caseId}: peak_grid_kwh mismatch (${resp.peak_grid_kwh} vs recalc ${Math.round(recalcPeak * 100) / 100})`);
        }
      }

      if (errors.length === 0) {
        console.log(`✅ PASS (${elapsed}ms, cost: ${resp.total_cost_bdt} BDT)`);
        passed++;
      } else {
        console.log(`❌ FAIL (${elapsed}ms, ${errors.length} errors)`);
        errors.forEach((e) => console.log(`     ⚠ ${e}`));
        totalErrors.push(...errors);
        failed++;
      }
    } catch (err) {
      console.log(`❌ ERROR: ${err.message}`);
      totalErrors.push(`${caseId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed}/${cases.length} passed, ${failed} failed`);

  if (totalErrors.length > 0) {
    console.log(`\nAll errors:`);
    totalErrors.forEach((e) => console.log(`  ⚠ ${e}`));
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
