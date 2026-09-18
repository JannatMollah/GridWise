/**
 * Comprehensive Edge Case Regression Test Runner
 * Tests paraphrased operator notes, tricky wording, fractions, and various edge cases.
 */

const { parseOperatorNotesRuleBased } = require('../src/services/ruleBasedParser');

const battery = {
  capacity_kwh: 220,
  initial_energy_kwh: 110,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 45,
  max_discharge_kwh_per_hour: 45
};

const edgeTestCases = [
  {
    name: "HIDDEN-EDGE-001 (Photovoltaic + quarter + utility import)",
    notes: [
      "Roof maintenance will leave the photovoltaic system producing only a quarter of its forecast between 10 AM and 1 PM.",
      "The library's seminar timetable has been shifted to a different day.",
      "During the evening peak, utility imports must stay at or below 90 kWh between 6 PM and 8 PM."
    ],
    expected: [
      { directive_type: "solar_reduction", applies: true, hours: [10, 11, 12], factor: 0.25 },
      { directive_type: "no_op", applies: false },
      { directive_type: "max_grid_window", applies: true, hours: [18, 19], max_grid_kwh: 90 }
    ]
  },
  {
    name: "Edge Case: Offline solar array and isolated charger",
    notes: [
      "The solar array will be completely offline between 11 AM and 1 PM for electrical rewiring.",
      "Charger inspection from 1 PM until 3 PM requires charger to be isolated.",
      "Campus hostel check-in schedule has been announced for tomorrow."
    ],
    expected: [
      { directive_type: "solar_reduction", applies: true, hours: [11, 12], factor: 0 },
      { directive_type: "no_charge_window", applies: true, hours: [13, 14] },
      { directive_type: "no_op", applies: false }
    ]
  },
  {
    name: "Edge Case: Word fractions and relay testing",
    notes: [
      "Photovoltaic generation will experience a 70% cut between 1 PM and 3 PM.",
      "Routine relay check prevents discharge from 4 PM until 6 PM.",
      "Battery reserve must not fall below 70 kWh between 4 PM and 9 PM."
    ],
    expected: [
      { directive_type: "solar_reduction", applies: true, hours: [13, 14], factor: 0.3 },
      { directive_type: "no_discharge_window", applies: true, hours: [16, 17] },
      { directive_type: "minimum_battery_reserve", applies: true, hours: [16, 17, 18, 19, 20], minimum_energy_kwh: 70 }
    ]
  }
];

console.log("\n🧪 Running Edge Case Directive Parser Tests...\n");
let totalPassed = 0;
let totalTests = edgeTestCases.length;

edgeTestCases.forEach((tc) => {
  const actual = parseOperatorNotesRuleBased(tc.notes, battery);
  let passed = true;

  tc.expected.forEach((exp, i) => {
    const act = actual[i];
    if (act.directive_type !== exp.directive_type || act.applies !== exp.applies) {
      passed = false;
      console.error(`  ❌ [${tc.name}] Note ${i} failed type/applies match!`);
      console.error(`     Actual: ${act.directive_type} (${act.applies}), Expected: ${exp.directive_type} (${exp.applies})`);
    }

    if (exp.hours && JSON.stringify(act.structured_adjustment?.hours) !== JSON.stringify(exp.hours)) {
      passed = false;
      console.error(`  ❌ [${tc.name}] Note ${i} hours mismatch!`);
      console.error(`     Actual: ${JSON.stringify(act.structured_adjustment?.hours)}, Expected: ${JSON.stringify(exp.hours)}`);
    }

    if (exp.factor !== undefined && act.structured_adjustment?.factor !== exp.factor) {
      passed = false;
      console.error(`  ❌ [${tc.name}] Note ${i} factor mismatch!`);
      console.error(`     Actual: ${act.structured_adjustment?.factor}, Expected: ${exp.factor}`);
    }

    if (exp.max_grid_kwh !== undefined && act.structured_adjustment?.max_grid_kwh !== exp.max_grid_kwh) {
      passed = false;
      console.error(`  ❌ [${tc.name}] Note ${i} max_grid_kwh mismatch!`);
      console.error(`     Actual: ${act.structured_adjustment?.max_grid_kwh}, Expected: ${exp.max_grid_kwh}`);
    }

    if (exp.minimum_energy_kwh !== undefined && act.structured_adjustment?.minimum_energy_kwh !== exp.minimum_energy_kwh) {
      passed = false;
      console.error(`  ❌ [${tc.name}] Note ${i} minimum_energy_kwh mismatch!`);
      console.error(`     Actual: ${act.structured_adjustment?.minimum_energy_kwh}, Expected: ${exp.minimum_energy_kwh}`);
    }
  });

  if (passed) {
    console.log(`  ✅ ${tc.name}: PASSED`);
    totalPassed++;
  }
});

console.log(`\nResults: ${totalPassed}/${totalTests} edge test suites passed.\n`);
if (totalPassed !== totalTests) process.exit(1);
