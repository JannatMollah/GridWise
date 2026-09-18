/**
 * Comprehensive Deterministic Test Suite for GridWise LLM
 * 
 * Tests the rule-based parser, guardrails, and optimizer components
 * WITHOUT requiring the LLM or a running server.
 * 
 * Coverage:
 * - All 6 directive types with paraphrases
 * - Percentages, fractions, AM/PM/time ranges
 * - Battery-relative expressions ("half the battery capacity")
 * - "through" vs "to" vs "until" semantics
 * - Energy balance validation
 * - Battery transition validation
 * - Charge/discharge rate limits
 * - No-charge/no-discharge window enforcement
 * - Max-grid constraint enforcement
 * - Solar reduction application
 * - End-of-day battery neutrality
 * - Totals recalculation accuracy
 * - Malformed input handling
 * - Public sample case directive parsing
 * - Specific failing case: "Keep no less than half the battery's storage capability..."
 */

const { parseOperatorNotesRuleBased, extractHours, parseTimeStr } = require("../src/services/ruleBasedParser");
const { validateInterpretations, validateHours } = require("../src/services/guardrail");
const { optimizeEnergy } = require("../src/services/optimizer");
const { validateHourlyPlan } = require("../src/services/outputValidator");
const { buildResponseWithTariffs } = require("../src/schemas/response");
const { optimizeEnergyRequestSchema } = require("../src/schemas/request");

const TOLERANCE = 0.01;
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, details) {
  if (condition) {
    passed++;
  } else {
    failed++;
    const msg = details ? `${testName}: ${details}` : testName;
    failures.push(msg);
    console.error(`  ❌ ${msg}`);
  }
}

function approxEqual(a, b, tol = TOLERANCE) {
  return Math.abs(a - b) <= tol;
}

// ── Standard test battery ──
const battery200 = {
  capacity_kwh: 200,
  initial_energy_kwh: 120,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

const battery500 = {
  capacity_kwh: 500,
  initial_energy_kwh: 200,
  minimum_energy_kwh: 50,
  max_charge_kwh_per_hour: 100,
  max_discharge_kwh_per_hour: 100,
};

const battery220 = {
  capacity_kwh: 220,
  initial_energy_kwh: 110,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

// ═══════════════════════════════════════════════
// SECTION 1: Time Parsing Tests
// ═══════════════════════════════════════════════
console.log("\n🕐 Section 1: Time Parsing Tests\n");

// parseTimeStr
assert(parseTimeStr("noon") === 12, "parseTimeStr('noon')");
assert(parseTimeStr("midnight") === 0, "parseTimeStr('midnight')");
assert(parseTimeStr("2 PM") === 14, "parseTimeStr('2 PM')");
assert(parseTimeStr("2 AM") === 2, "parseTimeStr('2 AM')");
assert(parseTimeStr("12 PM") === 12, "parseTimeStr('12 PM')");
assert(parseTimeStr("12 AM") === 0, "parseTimeStr('12 AM')");
assert(parseTimeStr("6") === 6, "parseTimeStr('6') = 6");
assert(parseTimeStr("10") === 10, "parseTimeStr('10') = 10");
assert(parseTimeStr("10:00") === 10, "parseTimeStr('10:00')");
assert(parseTimeStr("10:00 am") === 10, "parseTimeStr('10:00 am')");
assert(parseTimeStr("10:00 pm") === 22, "parseTimeStr('10:00 pm')");
assert(parseTimeStr("one") === 1, "parseTimeStr('one') = 1");
assert(parseTimeStr("three") === 3, "parseTimeStr('three') = 3");
assert(parseTimeStr("twelve") === 12, "parseTimeStr('twelve') = 12");

// extractHours tests
assert(JSON.stringify(extractHours("from noon until 2 PM")) === JSON.stringify([12, 13]),
  "extractHours 'noon until 2 PM'");
assert(JSON.stringify(extractHours("from 1 PM to 3 PM")) === JSON.stringify([13, 14]),
  "extractHours '1 PM to 3 PM'");
assert(JSON.stringify(extractHours("from 2 AM until 5 AM")) === JSON.stringify([2, 3, 4]),
  "extractHours '2 AM until 5 AM'");
assert(JSON.stringify(extractHours("from 6 PM until 9 PM")) === JSON.stringify([18, 19, 20]),
  "extractHours '6 PM until 9 PM'");
assert(JSON.stringify(extractHours("from 6 PM until 10 PM")) === JSON.stringify([18, 19, 20, 21]),
  "extractHours '6 PM until 10 PM'");
assert(JSON.stringify(extractHours("from 7 PM through 10 PM")) === JSON.stringify([19, 20, 21]),
  "extractHours '7 PM through 10 PM'");
assert(JSON.stringify(extractHours("between 11 AM and 2 PM")) === JSON.stringify([11, 12, 13]),
  "extractHours '11 AM and 2 PM'");
assert(JSON.stringify(extractHours("between 11 AM and 1 PM")) === JSON.stringify([11, 12]),
  "extractHours '11 AM and 1 PM'");

// ═══════════════════════════════════════════════
// SECTION 2: Solar Reduction Directive Tests
// ═══════════════════════════════════════════════
console.log("\n☀️ Section 2: Solar Reduction Directive Tests\n");

function testDirective(note, battery, expectedType, expectedApplies, expectedAdj, testName) {
  const result = parseOperatorNotesRuleBased([note], battery)[0];
  assert(result.directive_type === expectedType,
    `${testName}: type`, `got "${result.directive_type}" expected "${expectedType}"`);
  assert(result.applies === expectedApplies,
    `${testName}: applies`, `got ${result.applies} expected ${expectedApplies}`);
  if (expectedAdj && result.structured_adjustment) {
    if (expectedAdj.hours) {
      assert(JSON.stringify(result.structured_adjustment.hours) === JSON.stringify(expectedAdj.hours),
        `${testName}: hours`, `got ${JSON.stringify(result.structured_adjustment.hours)} expected ${JSON.stringify(expectedAdj.hours)}`);
    }
    if (expectedAdj.factor !== undefined) {
      assert(approxEqual(result.structured_adjustment.factor, expectedAdj.factor),
        `${testName}: factor`, `got ${result.structured_adjustment.factor} expected ${expectedAdj.factor}`);
    }
    if (expectedAdj.minimum_energy_kwh !== undefined) {
      assert(approxEqual(result.structured_adjustment.minimum_energy_kwh, expectedAdj.minimum_energy_kwh),
        `${testName}: minimum_energy_kwh`, `got ${result.structured_adjustment.minimum_energy_kwh} expected ${expectedAdj.minimum_energy_kwh}`);
    }
    if (expectedAdj.max_grid_kwh !== undefined) {
      assert(approxEqual(result.structured_adjustment.max_grid_kwh, expectedAdj.max_grid_kwh),
        `${testName}: max_grid_kwh`, `got ${result.structured_adjustment.max_grid_kwh} expected ${expectedAdj.max_grid_kwh}`);
    }
  }
  if (expectedAdj === null) {
    assert(result.structured_adjustment === null, `${testName}: null adjustment`,
      `got ${JSON.stringify(result.structured_adjustment)}`);
  }
}

// SAMPLE-01: "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast."
testDirective(
  "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
  battery220, "solar_reduction", true, { hours: [12, 13], factor: 0.25 },
  "SAMPLE-01 solar_reduction"
);

// SAMPLE-09: "Expect an 80% reduction in rooftop solar between 11 AM and 2 PM because of inverter work."
testDirective(
  "Expect an 80% reduction in rooftop solar between 11 AM and 2 PM because of inverter work.",
  battery220, "solar_reduction", true, { hours: [11, 12, 13], factor: 0.2 },
  "SAMPLE-09 80% reduction = factor 0.2"
);

// SAMPLE-06: "Cloud cover during panel inspection will leave about half of the forecast solar output from 10 AM until noon."
testDirective(
  "Cloud cover during panel inspection will leave about half of the forecast solar output from 10 AM until noon.",
  battery220, "solar_reduction", true, { hours: [10, 11], factor: 0.5 },
  "SAMPLE-06 half forecast solar"
);

// Paraphrase: "PV production will drop to about 20% between 13:00 and 15:00."
testDirective(
  "PV production will drop to about 20% between 1 PM and 3 PM.",
  battery220, "solar_reduction", true, { hours: [13, 14], factor: 0.2 },
  "PV drop to 20%"
);

// Paraphrase: "Panel washing from one until three will leave roughly one-fifth of normal solar output."
testDirective(
  "Panel washing from 1 PM until 3 PM will leave roughly one-fifth of normal solar output.",
  battery220, "solar_reduction", true, { hours: [13, 14], factor: 0.2 },
  "Panel washing one-fifth"
);

// Solar completely offline
testDirective(
  "The solar array will be completely offline between 11 AM and 1 PM for electrical rewiring.",
  battery220, "solar_reduction", true, { hours: [11, 12], factor: 0.0 },
  "Solar completely offline"
);

// 70% cut
testDirective(
  "Photovoltaic generation will experience a 70% cut between 1 PM and 3 PM.",
  battery220, "solar_reduction", true, { hours: [13, 14], factor: 0.3 },
  "PV 70% cut = factor 0.3"
);

// ═══════════════════════════════════════════════
// SECTION 3: Minimum Battery Reserve Tests
// ═══════════════════════════════════════════════
console.log("\n🔋 Section 3: Minimum Battery Reserve Tests\n");

// SAMPLE-03: "Keep at least 50% of the battery capacity stored in the battery from 6 PM until 9 PM for emergency operations."
testDirective(
  "Keep at least 50% of the battery capacity stored in the battery from 6 PM until 9 PM for emergency operations.",
  battery200, "minimum_battery_reserve", true, { hours: [18, 19, 20], minimum_energy_kwh: 100 },
  "SAMPLE-03 50% of 200 = 100 kWh"
);

// SAMPLE-07: "Keep at least 90 kWh in the battery from 6 PM until 10 PM for emergency services."
testDirective(
  "Keep at least 90 kWh in the battery from 6 PM until 10 PM for emergency services.",
  { capacity_kwh: 250, initial_energy_kwh: 150, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 60, max_discharge_kwh_per_hour: 60 },
  "minimum_battery_reserve", true, { hours: [18, 19, 20, 21], minimum_energy_kwh: 90 },
  "SAMPLE-07 90 kWh reserve"
);

// SAMPLE-10: "The data center requires at least 80 kWh to remain in the battery from 6 PM until 10 PM."
testDirective(
  "The data center requires at least 80 kWh to remain in the battery from 6 PM until 10 PM.",
  { capacity_kwh: 260, initial_energy_kwh: 140, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 65, max_discharge_kwh_per_hour: 65 },
  "minimum_battery_reserve", true, { hours: [18, 19, 20, 21], minimum_energy_kwh: 80 },
  "SAMPLE-10 data center 80 kWh"
);

// ★ THE CRITICAL FAILING CASE ★
// "Keep no less than half the battery's storage capability available from 7 PM through 10 PM."
testDirective(
  "Keep no less than half the battery's storage capability available from 7 PM through 10 PM.",
  battery500, "minimum_battery_reserve", true, { hours: [19, 20, 21], minimum_energy_kwh: 250 },
  "★ CRITICAL: half battery storage capability = 250 kWh"
);

// More reserve paraphrases
testDirective(
  "Battery reserve must not fall below 70 kWh between 4 PM and 9 PM.",
  battery220, "minimum_battery_reserve", true, { hours: [16, 17, 18, 19, 20], minimum_energy_kwh: 70 },
  "Reserve must not fall below 70 kWh"
);

testDirective(
  "Maintain at least a third of the battery capacity from 8 PM until 11 PM.",
  { capacity_kwh: 300, initial_energy_kwh: 150, minimum_energy_kwh: 50, max_charge_kwh_per_hour: 75, max_discharge_kwh_per_hour: 75 },
  "minimum_battery_reserve", true, { hours: [20, 21, 22], minimum_energy_kwh: 100 },
  "Third of 300 = 100 kWh"
);

// ═══════════════════════════════════════════════
// SECTION 4: No Charge Window Tests
// ═══════════════════════════════════════════════
console.log("\n🔌 Section 4: No Charge Window Tests\n");

// SAMPLE-02: "The battery charger will be isolated from 2 AM until 5 AM for electrical maintenance."
testDirective(
  "The battery charger will be isolated from 2 AM until 5 AM for electrical maintenance.",
  battery200, "no_charge_window", true, { hours: [2, 3, 4] },
  "SAMPLE-02 charger isolated"
);

// SAMPLE-06: "The charging circuit will be unavailable from 2 PM until 4 PM."
testDirective(
  "The charging circuit will be unavailable from 2 PM until 4 PM.",
  battery220, "no_charge_window", true, { hours: [14, 15] },
  "SAMPLE-06 charging unavailable"
);

// SAMPLE-08: "Battery charging is disabled from 11 AM until 1 PM while technicians inspect the charger."
testDirective(
  "Battery charging is disabled from 11 AM until 1 PM while technicians inspect the charger.",
  battery200, "no_charge_window", true, { hours: [11, 12] },
  "SAMPLE-08 charging disabled"
);

// Paraphrase
testDirective(
  "Charger inspection from 1 PM until 3 PM requires charger to be isolated.",
  battery220, "no_charge_window", true, { hours: [13, 14] },
  "Charger inspection isolated"
);

// ═══════════════════════════════════════════════
// SECTION 5: No Discharge Window Tests
// ═══════════════════════════════════════════════
console.log("\n⚡ Section 5: No Discharge Window Tests\n");

// SAMPLE-04: "For protection testing, the battery must not discharge from 6 PM until 8 PM."
testDirective(
  "For protection testing, the battery must not discharge from 6 PM until 8 PM.",
  battery200, "no_discharge_window", true, { hours: [18, 19] },
  "SAMPLE-04 protection testing"
);

// SAMPLE-08: "Do not discharge the battery from 5 PM until 7 PM during relay testing."
testDirective(
  "Do not discharge the battery from 5 PM until 7 PM during relay testing.",
  battery200, "no_discharge_window", true, { hours: [17, 18] },
  "SAMPLE-08 relay testing"
);

// Paraphrase
testDirective(
  "Routine relay check prevents discharge from 4 PM until 6 PM.",
  battery220, "no_discharge_window", true, { hours: [16, 17] },
  "Relay check prevents discharge"
);

// ═══════════════════════════════════════════════
// SECTION 6: Max Grid Window Tests
// ═══════════════════════════════════════════════
console.log("\n🏭 Section 6: Max Grid Window Tests\n");

// SAMPLE-05: "From 6 PM until 9 PM, campus grid import must not exceed 155 kWh..."
testDirective(
  "From 6 PM until 9 PM, campus grid import must not exceed 155 kWh in any hour because the feeder is operating under a temporary limit.",
  battery200, "max_grid_window", true, { hours: [18, 19, 20], max_grid_kwh: 155 },
  "SAMPLE-05 feeder 155 kWh cap"
);

// SAMPLE-07: "The evening transformer limit is 180 kWh of grid import from 7 PM until 9 PM."
testDirective(
  "The evening transformer limit is 180 kWh of grid import from 7 PM until 9 PM.",
  battery200, "max_grid_window", true, { hours: [19, 20], max_grid_kwh: 180 },
  "SAMPLE-07 transformer 180 kWh"
);

// SAMPLE-10: "Grid intake must stay at or below 190 kWh from 7 PM until 10 PM while the substation is constrained."
testDirective(
  "Grid intake must stay at or below 190 kWh from 7 PM until 10 PM while the substation is constrained.",
  battery200, "max_grid_window", true, { hours: [19, 20, 21], max_grid_kwh: 190 },
  "SAMPLE-10 substation 190 kWh"
);

// Paraphrase
testDirective(
  "During the evening peak, utility imports must stay at or below 90 kWh between 6 PM and 8 PM.",
  battery220, "max_grid_window", true, { hours: [18, 19], max_grid_kwh: 90 },
  "Utility imports cap 90 kWh"
);

// ═══════════════════════════════════════════════
// SECTION 7: No-Op / Distractor Tests
// ═══════════════════════════════════════════════
console.log("\n🚫 Section 7: No-Op / Distractor Tests\n");

const distractors = [
  "The sports office moved next month's registration deadline.",
  "The cafeteria menu changes tomorrow.",
  "The library is extending book-return hours next week.",
  "The student affairs office will publish club notices tomorrow.",
  "A seminar room booking was moved to next week.",
  "Campus hostel check-in schedule has been announced for tomorrow.",
  "The library's seminar timetable has been shifted to a different day.",
];

for (const d of distractors) {
  testDirective(d, battery220, "no_op", false, null, `Distractor: "${d.slice(0, 50)}..."`);
}

// ═══════════════════════════════════════════════
// SECTION 8: Guardrail Validation Tests
// ═══════════════════════════════════════════════
console.log("\n🛡️ Section 8: Guardrail Validation Tests\n");

// Valid hours
assert(JSON.stringify(validateHours([0, 1, 2])) === JSON.stringify([0, 1, 2]), "validateHours valid sorted");
assert(JSON.stringify(validateHours([5, 2, 3])) === JSON.stringify([2, 3, 5]), "validateHours sorts unsorted");
assert(validateHours([]) === null, "validateHours rejects empty");
assert(validateHours([25]) === null, "validateHours rejects >23");
assert(validateHours([-1]) === null, "validateHours rejects negative");
assert(validateHours([1, 1, 2]) === null, "validateHours rejects duplicates");

// Guardrail validation - invalid directive type defaults to no_op
const badInterpretation = [{
  note_index: 0,
  applies: true,
  directive_type: "fake_directive",
  structured_adjustment: { hours: [1] },
  explanation: "test",
}];
const validated = validateInterpretations(badInterpretation, ["test note"], battery220);
assert(validated[0].directive_type === "no_op", "Guardrail rejects unsupported directive type");
assert(validated[0].applies === false, "Guardrail sets applies=false for no_op fallback");

// Guardrail validation - missing interpretation defaults to no_op
const emptyInterpretations = [];
const validatedEmpty = validateInterpretations(emptyInterpretations, ["test note"], battery220);
assert(validatedEmpty.length === 1, "Guardrail creates entry for missing interpretation");
assert(validatedEmpty[0].directive_type === "no_op", "Guardrail defaults missing to no_op");

// Guardrail validation - solar factor out of range
const badSolar = [{
  note_index: 0,
  applies: true,
  directive_type: "solar_reduction",
  structured_adjustment: { hours: [1, 2], factor: 1.5 },
  explanation: "test",
}];
const validatedSolar = validateInterpretations(badSolar, ["test note"], battery220);
assert(validatedSolar[0].directive_type === "no_op", "Guardrail rejects factor > 1");

// Guardrail validation - negative reserve
const badReserve = [{
  note_index: 0,
  applies: true,
  directive_type: "minimum_battery_reserve",
  structured_adjustment: { hours: [1], minimum_energy_kwh: -10 },
  explanation: "test",
}];
const validatedReserve = validateInterpretations(badReserve, ["test note"], battery220);
assert(validatedReserve[0].directive_type === "no_op", "Guardrail rejects negative reserve");

// ═══════════════════════════════════════════════
// SECTION 9: Optimizer Integration Tests
// ═══════════════════════════════════════════════
console.log("\n⚙️ Section 9: Optimizer Integration Tests\n");

// Generate minimal 24-hour test data
function makeHours(baseDemand, baseSolar, baseTariff) {
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    demand_kwh: baseDemand + (h >= 8 && h <= 16 ? 50 : 0),
    solar_kwh: h >= 6 && h <= 18 ? baseSolar * Math.sin(Math.PI * (h - 6) / 12) : 0,
    tariff_bdt_per_kwh: baseTariff + (h >= 17 && h <= 20 ? 15 : 0),
  }));
}

const testHours = makeHours(100, 100, 8);
const testBattery = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 30,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

// Test basic optimization (no directives)
try {
  const noDirectives = [{ note_index: 0, applies: false, directive_type: "no_op", structured_adjustment: null, explanation: "test" }];
  const plan = optimizeEnergy(testHours, testBattery, noDirectives);
  assert(plan.length === 24, "Optimizer produces 24 hours");
  
  // Validate the plan
  const validation = validateHourlyPlan(plan, testHours, testBattery, noDirectives);
  assert(validation.valid, "Optimizer plan passes validation", validation.errors.join("; "));
  
  // Check end-of-day neutrality
  const lastHour = plan.find(h => h.hour === 23);
  assert(approxEqual(lastHour.battery_energy_after_kwh, testBattery.initial_energy_kwh, 0.5),
    "End-of-day battery neutrality");
} catch (e) {
  assert(false, "Basic optimization", e.message);
}

// Test optimization with no_charge_window
try {
  const directives = [{
    note_index: 0, applies: true, directive_type: "no_charge_window",
    structured_adjustment: { hours: [2, 3, 4] }, explanation: "test",
  }];
  const plan = optimizeEnergy(testHours, testBattery, directives);
  
  // Verify no charging in restricted hours
  for (const h of [2, 3, 4]) {
    const entry = plan.find(e => e.hour === h);
    assert(entry.battery_action !== "charge" || entry.battery_kwh < TOLERANCE,
      `No-charge window h${h}`, `action=${entry.battery_action} kwh=${entry.battery_kwh}`);
  }
} catch (e) {
  assert(false, "No-charge optimization", e.message);
}

// Test optimization with no_discharge_window
try {
  const directives = [{
    note_index: 0, applies: true, directive_type: "no_discharge_window",
    structured_adjustment: { hours: [18, 19] }, explanation: "test",
  }];
  const plan = optimizeEnergy(testHours, testBattery, directives);
  
  for (const h of [18, 19]) {
    const entry = plan.find(e => e.hour === h);
    assert(entry.battery_action !== "discharge" || entry.battery_kwh < TOLERANCE,
      `No-discharge window h${h}`, `action=${entry.battery_action} kwh=${entry.battery_kwh}`);
  }
} catch (e) {
  assert(false, "No-discharge optimization", e.message);
}

// Test optimization with max_grid_window
try {
  const directives = [{
    note_index: 0, applies: true, directive_type: "max_grid_window",
    structured_adjustment: { hours: [18, 19, 20], max_grid_kwh: 120 }, explanation: "test",
  }];
  const plan = optimizeEnergy(testHours, testBattery, directives);
  
  for (const h of [18, 19, 20]) {
    const entry = plan.find(e => e.hour === h);
    assert(entry.grid_kwh <= 120 + TOLERANCE,
      `Max-grid cap h${h}`, `grid_kwh=${entry.grid_kwh}`);
  }
} catch (e) {
  assert(false, "Max-grid optimization", e.message);
}

// ═══════════════════════════════════════════════
// SECTION 10: Totals Recalculation Tests
// ═══════════════════════════════════════════════
console.log("\n📊 Section 10: Totals Recalculation Tests\n");

try {
  const noDirectives = [{ note_index: 0, applies: false, directive_type: "no_op", structured_adjustment: null, explanation: "test" }];
  const plan = optimizeEnergy(testHours, testBattery, noDirectives);
  
  const response = buildResponseWithTariffs({
    scenarioId: "TEST",
    directiveInterpretation: noDirectives,
    hourlyPlan: plan,
    hoursData: testHours,
    planSummary: "test",
  });
  
  // Recalculate from hourly_plan
  const tariffMap = {};
  for (const h of testHours) tariffMap[h.hour] = h.tariff_bdt_per_kwh;
  
  let recalcGrid = 0;
  let recalcCost = 0;
  let recalcPeak = 0;
  for (const h of response.hourly_plan) {
    recalcGrid += h.grid_kwh;
    recalcCost += h.grid_kwh * (tariffMap[h.hour] || 0);
    recalcPeak = Math.max(recalcPeak, h.grid_kwh);
  }
  
  assert(approxEqual(recalcGrid, response.total_grid_kwh, 0.1),
    "total_grid_kwh matches recalculation",
    `reported=${response.total_grid_kwh} recalc=${Math.round(recalcGrid * 100) / 100}`);
  assert(approxEqual(recalcCost, response.total_cost_bdt, 0.1),
    "total_cost_bdt matches recalculation",
    `reported=${response.total_cost_bdt} recalc=${Math.round(recalcCost * 100) / 100}`);
  assert(approxEqual(recalcPeak, response.peak_grid_kwh, 0.1),
    "peak_grid_kwh matches recalculation",
    `reported=${response.peak_grid_kwh} recalc=${Math.round(recalcPeak * 100) / 100}`);
} catch (e) {
  assert(false, "Totals recalculation", e.message);
}

// ═══════════════════════════════════════════════
// SECTION 11: Input Validation Tests
// ═══════════════════════════════════════════════
console.log("\n📋 Section 11: Input Validation Tests\n");

// Valid input
const validInput = {
  scenario_id: "TEST-01",
  operator_notes: ["Test note"],
  hours: Array.from({ length: 24 }, (_, h) => ({
    hour: h, demand_kwh: 100, solar_kwh: 50, tariff_bdt_per_kwh: 10,
  })),
  battery: battery220,
};
assert(optimizeEnergyRequestSchema.safeParse(validInput).success, "Valid input passes schema");

// Missing scenario_id
const badInput1 = { ...validInput, scenario_id: undefined };
assert(!optimizeEnergyRequestSchema.safeParse(badInput1).success, "Missing scenario_id fails");

// Empty operator_notes
const badInput2 = { ...validInput, operator_notes: [] };
assert(!optimizeEnergyRequestSchema.safeParse(badInput2).success, "Empty operator_notes fails");

// Too many operator_notes
const badInput3 = { ...validInput, operator_notes: ["a", "b", "c", "d"] };
assert(!optimizeEnergyRequestSchema.safeParse(badInput3).success, "4 operator_notes fails");

// Wrong number of hours
const badInput4 = { ...validInput, hours: validInput.hours.slice(0, 12) };
assert(!optimizeEnergyRequestSchema.safeParse(badInput4).success, "12 hours fails");

// Negative demand
const badInput5 = {
  ...validInput,
  hours: validInput.hours.map((h, i) => i === 0 ? { ...h, demand_kwh: -10 } : h),
};
assert(!optimizeEnergyRequestSchema.safeParse(badInput5).success, "Negative demand fails");

// ═══════════════════════════════════════════════
// SECTION 12: Multi-Note Parsing Tests
// ═══════════════════════════════════════════════
console.log("\n📝 Section 12: Multi-Note Parsing Tests\n");

// SAMPLE-06: 3 notes - solar + no_charge + distractor
{
  const notes = [
    "Cloud cover during panel inspection will leave about half of the forecast solar output from 10 AM until noon.",
    "The charging circuit will be unavailable from 2 PM until 4 PM.",
    "The library is extending book-return hours next week.",
  ];
  const results = parseOperatorNotesRuleBased(notes, battery220);
  assert(results.length === 3, "Multi-note produces 3 results");
  assert(results[0].directive_type === "solar_reduction", "Note 0 = solar_reduction");
  assert(results[0].applies === true, "Note 0 applies");
  assert(results[1].directive_type === "no_charge_window", "Note 1 = no_charge_window");
  assert(results[1].applies === true, "Note 1 applies");
  assert(results[2].directive_type === "no_op", "Note 2 = no_op");
  assert(results[2].applies === false, "Note 2 does not apply");
}

// SAMPLE-10: 3 notes - reserve + grid cap + distractor
{
  const bat = { capacity_kwh: 260, initial_energy_kwh: 140, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 65, max_discharge_kwh_per_hour: 65 };
  const notes = [
    "The data center requires at least 80 kWh to remain in the battery from 6 PM until 10 PM.",
    "Grid intake must stay at or below 190 kWh from 7 PM until 10 PM while the substation is constrained.",
    "A seminar room booking was moved to next week.",
  ];
  const results = parseOperatorNotesRuleBased(notes, bat);
  assert(results[0].directive_type === "minimum_battery_reserve", "Note 0 = reserve");
  assert(approxEqual(results[0].structured_adjustment.minimum_energy_kwh, 80), "Note 0 = 80 kWh");
  assert(results[1].directive_type === "max_grid_window", "Note 1 = max_grid");
  assert(approxEqual(results[1].structured_adjustment.max_grid_kwh, 190), "Note 1 = 190 kWh cap");
  assert(results[2].directive_type === "no_op", "Note 2 = no_op");
}

// ═══════════════════════════════════════════════
// Results Summary
// ═══════════════════════════════════════════════
console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log(`\nFailures:`);
  failures.forEach((f) => console.log(`  ⚠ ${f}`));
}

console.log();
process.exit(failed > 0 ? 1 : 0);
