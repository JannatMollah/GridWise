/**
 * Builds the final response object matching Problem Statement Section 10.
 */
function buildResponse({
  scenarioId,
  directiveInterpretation,
  hourlyPlan,
  planSummary,
}) {
  // Sort hourly plan by hour
  const sorted = [...hourlyPlan].sort((a, b) => a.hour - b.hour);

  // Recalculate totals from hourly_plan (source of truth)
  let totalGridKwh = 0;
  let totalCostBdt = 0;
  let peakGridKwh = 0;

  for (const entry of sorted) {
    totalGridKwh += entry.grid_kwh;
    peakGridKwh = Math.max(peakGridKwh, entry.grid_kwh);
  }

  return {
    scenario_id: scenarioId,
    directive_interpretation: directiveInterpretation,
    hourly_plan: sorted,
    total_grid_kwh: round2(totalGridKwh),
    total_cost_bdt: round2(totalCostBdt),
    peak_grid_kwh: round2(peakGridKwh),
    plan_summary: planSummary || "",
  };
}

/**
 * Builds the response with tariff data for cost calculation.
 */
function buildResponseWithTariffs({
  scenarioId,
  directiveInterpretation,
  hourlyPlan,
  hoursData,
  planSummary,
}) {
  const sorted = [...hourlyPlan].sort((a, b) => a.hour - b.hour);

  const tariffMap = {};
  for (const h of hoursData) {
    tariffMap[h.hour] = h.tariff_bdt_per_kwh;
  }

  let totalGridKwh = 0;
  let totalCostBdt = 0;
  let peakGridKwh = 0;

  for (const entry of sorted) {
    totalGridKwh += entry.grid_kwh;
    totalCostBdt += entry.grid_kwh * (tariffMap[entry.hour] || 0);
    peakGridKwh = Math.max(peakGridKwh, entry.grid_kwh);
  }

  return {
    scenario_id: scenarioId,
    directive_interpretation: directiveInterpretation,
    hourly_plan: sorted,
    total_grid_kwh: round2(totalGridKwh),
    total_cost_bdt: round2(totalCostBdt),
    peak_grid_kwh: round2(peakGridKwh),
    plan_summary: planSummary || "",
  };
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

module.exports = { buildResponse, buildResponseWithTariffs, round2 };
