/**
 * 24-hour energy optimizer using Linear Programming.
 * 
 * Minimizes total grid electricity cost while satisfying:
 * - Hourly energy balance
 * - Battery state transitions, bounds, and rate limits
 * - Solar usage limits (including solar_reduction directives)
 * - End-of-day battery neutrality
 * - All applicable operator directives
 * 
 * Uses javascript-lp-solver for the LP formulation.
 */

const solver = require("javascript-lp-solver");

/**
 * Run the 24-hour energy optimization.
 * 
 * @param {Array} hoursData - 24 hour entries with demand, solar, tariff
 * @param {Object} battery - Battery parameters
 * @param {Array} directives - Validated directive interpretations (from guardrail)
 * @returns {Object} { hourlyPlan, totalGridKwh, totalCostBdt, peakGridKwh }
 */
function optimizeEnergy(hoursData, battery, directives) {
  // Sort hours by hour number
  const hours = [...hoursData].sort((a, b) => a.hour - b.hour);

  // ── Pre-compute effective solar after solar_reduction ──
  const effectiveSolar = new Array(24);
  for (let h = 0; h < 24; h++) {
    effectiveSolar[h] = hours[h].solar_kwh;
  }

  // Apply solar_reduction directives
  for (const d of directives) {
    if (d.applies && d.directive_type === "solar_reduction") {
      for (const h of d.structured_adjustment.hours) {
        effectiveSolar[h] = hours[h].solar_kwh * d.structured_adjustment.factor;
      }
    }
  }

  // ── Collect directive constraints ──
  const noChargeHours = new Set();
  const noDischargeHours = new Set();
  const minReserveMap = {}; // hour -> minimum_energy_kwh
  const maxGridMap = {};    // hour -> max_grid_kwh

  for (const d of directives) {
    if (!d.applies) continue;
    const adj = d.structured_adjustment;
    if (!adj) continue;

    switch (d.directive_type) {
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
          if (maxGridMap[h] === undefined) {
            maxGridMap[h] = adj.max_grid_kwh;
          } else {
            maxGridMap[h] = Math.min(maxGridMap[h], adj.max_grid_kwh);
          }
        }
        break;
    }
  }

  // ── Build LP model using javascript-lp-solver ──
  // Variables: grid_h, solar_h, charge_h, discharge_h for each hour h
  // We'll use the model format expected by javascript-lp-solver

  const model = {
    optimize: "cost",
    opType: "min",
    constraints: {},
    variables: {},
    ints: {},
  };

  for (let h = 0; h < 24; h++) {
    const tariff = hours[h].tariff_bdt_per_kwh;
    const demand = hours[h].demand_kwh;
    const maxSolar = effectiveSolar[h];
    const minEnergy = minReserveMap[h] || battery.minimum_energy_kwh;

    // Variable names
    const gridVar = `grid_${h}`;
    const solarVar = `solar_${h}`;
    const chargeVar = `charge_${h}`;
    const dischargeVar = `discharge_${h}`;

    // ── Define variables with cost coefficient ──
    model.variables[gridVar] = { cost: tariff };
    model.variables[solarVar] = { cost: 0 };
    model.variables[chargeVar] = { cost: 0 };
    model.variables[dischargeVar] = { cost: 0 };

    // ── Energy balance: grid + solar + discharge = demand + charge ──
    // Rearranged: grid + solar + discharge - charge = demand
    const balanceKey = `balance_${h}`;
    model.constraints[balanceKey] = { equal: demand };
    model.variables[gridVar][balanceKey] = 1;
    model.variables[solarVar][balanceKey] = 1;
    model.variables[dischargeVar][balanceKey] = 1;
    model.variables[chargeVar][balanceKey] = -1;

    // ── Variable bounds ──
    // grid >= 0
    const gridMinKey = `grid_min_${h}`;
    model.constraints[gridMinKey] = { min: 0 };
    model.variables[gridVar][gridMinKey] = 1;

    // solar >= 0
    const solarMinKey = `solar_min_${h}`;
    model.constraints[solarMinKey] = { min: 0 };
    model.variables[solarVar][solarMinKey] = 1;

    // solar <= effective_solar
    const solarMaxKey = `solar_max_${h}`;
    model.constraints[solarMaxKey] = { max: maxSolar };
    model.variables[solarVar][solarMaxKey] = 1;

    // charge >= 0
    const chargeMinKey = `charge_min_${h}`;
    model.constraints[chargeMinKey] = { min: 0 };
    model.variables[chargeVar][chargeMinKey] = 1;

    // discharge >= 0
    const dischargeMinKey = `discharge_min_${h}`;
    model.constraints[dischargeMinKey] = { min: 0 };
    model.variables[dischargeVar][dischargeMinKey] = 1;

    // charge <= max_charge_kwh_per_hour (or 0 if no_charge_window)
    const chargeMaxKey = `charge_max_${h}`;
    model.constraints[chargeMaxKey] = {
      max: noChargeHours.has(h) ? 0 : battery.max_charge_kwh_per_hour,
    };
    model.variables[chargeVar][chargeMaxKey] = 1;

    // discharge <= max_discharge_kwh_per_hour (or 0 if no_discharge_window)
    const dischargeMaxKey = `discharge_max_${h}`;
    model.constraints[dischargeMaxKey] = {
      max: noDischargeHours.has(h) ? 0 : battery.max_discharge_kwh_per_hour,
    };
    model.variables[dischargeVar][dischargeMaxKey] = 1;

    // max_grid_window constraint
    if (maxGridMap[h] !== undefined) {
      const gridCapKey = `grid_cap_${h}`;
      model.constraints[gridCapKey] = { max: maxGridMap[h] };
      model.variables[gridVar][gridCapKey] = 1;
    }

    // ── Battery state constraints ──
    // E[h] = E[h-1] + charge[h] - discharge[h]
    // We need: minEnergy <= E[h] <= capacity
    //
    // E[h] = initial + SUM(charge[0..h]) - SUM(discharge[0..h])
    //
    // Battery upper bound: SUM(charge[0..h]) - SUM(discharge[0..h]) <= capacity - initial
    const battUpperKey = `batt_upper_${h}`;
    model.constraints[battUpperKey] = {
      max: battery.capacity_kwh - battery.initial_energy_kwh,
    };

    // Battery lower bound: SUM(charge[0..h]) - SUM(discharge[0..h]) >= minEnergy - initial
    const battLowerKey = `batt_lower_${h}`;
    model.constraints[battLowerKey] = {
      min: minEnergy - battery.initial_energy_kwh,
    };

    // Add cumulative charge/discharge contributions for hours 0..h
    for (let k = 0; k <= h; k++) {
      const ck = `charge_${k}`;
      const dk = `discharge_${k}`;

      if (!model.variables[ck][battUpperKey]) model.variables[ck][battUpperKey] = 0;
      model.variables[ck][battUpperKey] += 1;

      if (!model.variables[dk][battUpperKey]) model.variables[dk][battUpperKey] = 0;
      model.variables[dk][battUpperKey] -= 1;

      if (!model.variables[ck][battLowerKey]) model.variables[ck][battLowerKey] = 0;
      model.variables[ck][battLowerKey] += 1;

      if (!model.variables[dk][battLowerKey]) model.variables[dk][battLowerKey] = 0;
      model.variables[dk][battLowerKey] -= 1;
    }
  }

  // ── End-of-day neutrality: E[23] = initial_energy_kwh ──
  // SUM(charge[0..23]) - SUM(discharge[0..23]) = 0
  const neutralKey = "battery_neutral";
  model.constraints[neutralKey] = { equal: 0 };
  for (let h = 0; h < 24; h++) {
    model.variables[`charge_${h}`][neutralKey] = 1;
    model.variables[`discharge_${h}`][neutralKey] = -1;
  }

  // ── Solve ──
  const result = solver.Solve(model);

  if (!result.feasible) {
    throw new Error("LP solver found no feasible solution for the given constraints.");
  }

  // ── Extract hourly plan ──
  const hourlyPlan = [];
  let batteryEnergy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const gridKwh = round2(result[`grid_${h}`] || 0);
    const solarUsed = round2(result[`solar_${h}`] || 0);
    let chargeKwh = round2(result[`charge_${h}`] || 0);
    let dischargeKwh = round2(result[`discharge_${h}`] || 0);

    // Determine battery action
    let batteryAction;
    let batteryKwh;

    if (chargeKwh > 0.001 && dischargeKwh > 0.001) {
      // Simultaneous charge/discharge — net out
      const net = chargeKwh - dischargeKwh;
      if (net > 0.001) {
        batteryAction = "charge";
        batteryKwh = round2(net);
        chargeKwh = round2(net);
        dischargeKwh = 0;
      } else if (net < -0.001) {
        batteryAction = "discharge";
        batteryKwh = round2(-net);
        chargeKwh = 0;
        dischargeKwh = round2(-net);
      } else {
        batteryAction = "idle";
        batteryKwh = 0;
        chargeKwh = 0;
        dischargeKwh = 0;
      }
    } else if (chargeKwh > 0.001) {
      batteryAction = "charge";
      batteryKwh = chargeKwh;
    } else if (dischargeKwh > 0.001) {
      batteryAction = "discharge";
      batteryKwh = dischargeKwh;
    } else {
      batteryAction = "idle";
      batteryKwh = 0;
    }

    // Update battery energy
    if (batteryAction === "charge") {
      batteryEnergy += batteryKwh;
    } else if (batteryAction === "discharge") {
      batteryEnergy -= batteryKwh;
    }

    batteryEnergy = round2(batteryEnergy);

    hourlyPlan.push({
      hour: h,
      grid_kwh: gridKwh,
      solar_used_kwh: solarUsed,
      battery_action: batteryAction,
      battery_kwh: batteryKwh,
      battery_energy_after_kwh: batteryEnergy,
    });
  }

  return hourlyPlan;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

module.exports = { optimizeEnergy };
