/**
 * Post-optimization output validator and repairer.
 * Replays the hourly plan against all constraints and directives
 * to verify the optimizer's solution is valid before returning it.
 * If violations are found, attempts to repair them.
 */

const TOLERANCE = 0.01; // 0.01 kWh or 0.01 BDT

/**
 * Pre-compute all directive constraint maps from validated directives.
 */
function buildConstraintMaps(hoursData, battery, directives) {
  const hours = [...hoursData].sort((a, b) => a.hour - b.hour);

  const effectiveSolar = new Array(24);
  for (let h = 0; h < 24; h++) {
    effectiveSolar[h] = hours[h].solar_kwh;
  }

  const noChargeHours = new Set();
  const noDischargeHours = new Set();
  const minReserveMap = {};
  const maxGridMap = {};

  for (const d of directives) {
    if (!d.applies) continue;
    const adj = d.structured_adjustment;
    if (!adj) continue;

    switch (d.directive_type) {
      case "solar_reduction":
        for (const h of adj.hours) {
          effectiveSolar[h] = hours[h].solar_kwh * adj.factor;
        }
        break;
      case "no_charge_window":
        for (const h of adj.hours) noChargeHours.add(h);
        break;
      case "no_discharge_window":
        for (const h of adj.hours) noDischargeHours.add(h);
        break;
      case "minimum_battery_reserve":
        for (const h of adj.hours) {
          minReserveMap[h] = Math.max(
            minReserveMap[h] || battery.minimum_energy_kwh,
            adj.minimum_energy_kwh
          );
        }
        break;
      case "max_grid_window":
        for (const h of adj.hours) {
          if (maxGridMap[h] === undefined) maxGridMap[h] = adj.max_grid_kwh;
          else maxGridMap[h] = Math.min(maxGridMap[h], adj.max_grid_kwh);
        }
        break;
    }
  }

  return { hours, effectiveSolar, noChargeHours, noDischargeHours, minReserveMap, maxGridMap };
}

/**
 * Validate the full hourly plan after optimization.
 * Returns { valid, errors } — errors is an array of violation descriptions.
 */
function validateHourlyPlan(hourlyPlan, hoursData, battery, directives) {
  const errors = [];

  if (!Array.isArray(hourlyPlan) || hourlyPlan.length !== 24) {
    return { valid: false, errors: ["hourly_plan must contain exactly 24 entries"] };
  }

  const sorted = [...hourlyPlan].sort((a, b) => a.hour - b.hour);

  // Check unique hours 0-23
  const hourSet = new Set(sorted.map((e) => e.hour));
  if (hourSet.size !== 24) {
    errors.push("hourly_plan must have 24 unique hours");
  }

  const { hours, effectiveSolar, noChargeHours, noDischargeHours, minReserveMap, maxGridMap } =
    buildConstraintMaps(hoursData, battery, directives);

  // ── Hour-by-hour validation ──
  let batteryEnergy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const entry = sorted[h];
    const demand = hours[h].demand_kwh;
    const maxSolar = effectiveSolar[h];
    const minEnergy = minReserveMap[h] || battery.minimum_energy_kwh;

    // Non-negative values
    if (entry.grid_kwh < -TOLERANCE) errors.push(`Hour ${h}: negative grid_kwh (${entry.grid_kwh})`);
    if (entry.solar_used_kwh < -TOLERANCE) errors.push(`Hour ${h}: negative solar_used_kwh (${entry.solar_used_kwh})`);
    if (entry.battery_kwh < -TOLERANCE) errors.push(`Hour ${h}: negative battery_kwh (${entry.battery_kwh})`);

    // Solar limit
    if (entry.solar_used_kwh > maxSolar + TOLERANCE) {
      errors.push(`Hour ${h}: solar_used (${entry.solar_used_kwh}) exceeds effective solar (${round2(maxSolar)})`);
    }

    // Battery action consistency
    const charge = entry.battery_action === "charge" ? entry.battery_kwh : 0;
    const discharge = entry.battery_action === "discharge" ? entry.battery_kwh : 0;

    if (entry.battery_action === "idle" && entry.battery_kwh > TOLERANCE) {
      errors.push(`Hour ${h}: idle but battery_kwh > 0 (${entry.battery_kwh})`);
    }

    // Valid battery_action
    if (!["charge", "discharge", "idle"].includes(entry.battery_action)) {
      errors.push(`Hour ${h}: invalid battery_action "${entry.battery_action}"`);
    }

    // Charge/discharge rate limits
    if (charge > battery.max_charge_kwh_per_hour + TOLERANCE) {
      errors.push(`Hour ${h}: charge (${charge}) exceeds max rate (${battery.max_charge_kwh_per_hour})`);
    }
    if (discharge > battery.max_discharge_kwh_per_hour + TOLERANCE) {
      errors.push(`Hour ${h}: discharge (${discharge}) exceeds max rate (${battery.max_discharge_kwh_per_hour})`);
    }

    // Directive constraints
    if (noChargeHours.has(h) && charge > TOLERANCE) {
      errors.push(`Hour ${h}: charging during no_charge_window`);
    }
    if (noDischargeHours.has(h) && discharge > TOLERANCE) {
      errors.push(`Hour ${h}: discharging during no_discharge_window`);
    }
    if (maxGridMap[h] !== undefined && entry.grid_kwh > maxGridMap[h] + TOLERANCE) {
      errors.push(`Hour ${h}: grid_kwh (${entry.grid_kwh}) exceeds max_grid_window (${maxGridMap[h]})`);
    }

    // Energy balance: grid + solar_used + discharge = demand + charge
    const lhs = entry.grid_kwh + entry.solar_used_kwh + discharge;
    const rhs = demand + charge;
    if (Math.abs(lhs - rhs) > TOLERANCE) {
      errors.push(`Hour ${h}: energy balance violated (${round2(lhs)} != ${round2(rhs)})`);
    }

    // Battery state transition
    batteryEnergy = batteryEnergy + charge - discharge;

    // Battery bounds
    if (batteryEnergy < minEnergy - TOLERANCE) {
      errors.push(`Hour ${h}: battery energy (${round2(batteryEnergy)}) below minimum (${minEnergy})`);
    }
    if (batteryEnergy > battery.capacity_kwh + TOLERANCE) {
      errors.push(`Hour ${h}: battery energy (${round2(batteryEnergy)}) exceeds capacity (${battery.capacity_kwh})`);
    }

    // Check reported battery_energy_after_kwh
    if (Math.abs(batteryEnergy - entry.battery_energy_after_kwh) > TOLERANCE) {
      errors.push(`Hour ${h}: reported battery_energy_after (${entry.battery_energy_after_kwh}) != calculated (${round2(batteryEnergy)})`);
    }
  }

  // End-of-day neutrality
  if (Math.abs(batteryEnergy - battery.initial_energy_kwh) > TOLERANCE) {
    errors.push(`End-of-day battery (${round2(batteryEnergy)}) != initial (${battery.initial_energy_kwh})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Attempt to repair a hourly plan by fixing battery_energy_after_kwh values
 * and ensuring battery_kwh = 0 when idle.
 * Returns the repaired plan (new array, does not modify original).
 */
function repairHourlyPlan(hourlyPlan, hoursData, battery, directives) {
  const { hours, effectiveSolar, noChargeHours, noDischargeHours, minReserveMap, maxGridMap } =
    buildConstraintMaps(hoursData, battery, directives);

  const sorted = [...hourlyPlan].sort((a, b) => a.hour - b.hour);
  const repaired = [];
  let batteryEnergy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const entry = { ...sorted[h] };
    const demand = hours[h].demand_kwh;
    const maxSolar = effectiveSolar[h];

    // Fix: clamp solar_used_kwh to effective solar
    entry.solar_used_kwh = Math.max(0, Math.min(entry.solar_used_kwh, maxSolar));

    // Fix: ensure battery_kwh is 0 when idle
    if (entry.battery_action === "idle") {
      entry.battery_kwh = 0;
    }

    // Fix: enforce no-charge/no-discharge windows
    if (noChargeHours.has(h) && entry.battery_action === "charge") {
      entry.battery_action = "idle";
      entry.battery_kwh = 0;
    }
    if (noDischargeHours.has(h) && entry.battery_action === "discharge") {
      entry.battery_action = "idle";
      entry.battery_kwh = 0;
    }

    // Fix: clamp charge/discharge to rate limits
    if (entry.battery_action === "charge") {
      entry.battery_kwh = Math.min(entry.battery_kwh, battery.max_charge_kwh_per_hour);
    }
    if (entry.battery_action === "discharge") {
      entry.battery_kwh = Math.min(entry.battery_kwh, battery.max_discharge_kwh_per_hour);
    }

    // Fix: max grid cap
    if (maxGridMap[h] !== undefined) {
      entry.grid_kwh = Math.min(entry.grid_kwh, maxGridMap[h]);
    }

    // Fix: ensure non-negative
    entry.grid_kwh = Math.max(0, entry.grid_kwh);
    entry.battery_kwh = Math.max(0, entry.battery_kwh);
    entry.solar_used_kwh = Math.max(0, entry.solar_used_kwh);

    // Recompute energy balance: grid_kwh = demand + charge - solar - discharge
    const charge = entry.battery_action === "charge" ? entry.battery_kwh : 0;
    const discharge = entry.battery_action === "discharge" ? entry.battery_kwh : 0;
    const neededGrid = demand + charge - entry.solar_used_kwh - discharge;
    entry.grid_kwh = round2(Math.max(0, neededGrid));

    // Re-enforce max grid cap after rebalance
    if (maxGridMap[h] !== undefined && entry.grid_kwh > maxGridMap[h]) {
      entry.grid_kwh = maxGridMap[h];
    }

    // Update battery energy
    batteryEnergy = batteryEnergy + charge - discharge;
    entry.battery_energy_after_kwh = round2(batteryEnergy);

    repaired.push(entry);
  }

  return repaired;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

module.exports = { validateHourlyPlan, repairHourlyPlan, buildConstraintMaps, TOLERANCE };
