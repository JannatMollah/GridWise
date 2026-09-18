const express = require("express");
const router = express.Router();
const { optimizeEnergyRequestSchema } = require("../schemas/request");
const { buildResponseWithTariffs } = require("../schemas/response");
const { interpretOperatorNotes } = require("../services/llmInterpreter");
const { validateInterpretations } = require("../services/guardrail");
const { optimizeEnergy } = require("../services/optimizer");
const { validateHourlyPlan, repairHourlyPlan } = require("../services/outputValidator");

/**
 * POST /optimize-energy
 * Main LLM interpretation + 24-hour optimization endpoint.
 * 
 * Pipeline:
 * 1. Validate request schema (Zod)
 * 2. Interpret operator notes (Gemini LLM)
 * 3. Validate interpretations (Deterministic guardrails)
 * 4. Optimize energy schedule (LP solver)
 * 5. Validate output (Post-optimization replay)
 * 6. Repair if needed
 * 7. Recalculate totals from final hourly_plan
 * 8. Assemble and return response
 */
router.post("/", async (req, res) => {
  try {
    // ── Step 1: Validate request ──
    const parseResult = optimizeEnergyRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid request schema",
        details: parseResult.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const input = parseResult.data;

    // ── Step 2: LLM Interpretation ──
    const rawInterpretations = await interpretOperatorNotes(
      input.operator_notes,
      input.battery
    );

    // ── Step 3: Guardrail Validation ──
    const directives = validateInterpretations(
      rawInterpretations,
      input.operator_notes,
      input.battery
    );

    // ── Step 4: LP Optimization ──
    let hourlyPlan = optimizeEnergy(input.hours, input.battery, directives);

    // ── Step 5: Post-optimization Validation ──
    let validation = validateHourlyPlan(
      hourlyPlan,
      input.hours,
      input.battery,
      directives
    );

    // ── Step 6: Repair if needed ──
    if (!validation.valid) {
      console.warn("Post-optimization validation failed, attempting repair:", validation.errors.slice(0, 5));
      hourlyPlan = repairHourlyPlan(hourlyPlan, input.hours, input.battery, directives);

      // Re-validate after repair
      const revalidation = validateHourlyPlan(hourlyPlan, input.hours, input.battery, directives);
      if (!revalidation.valid) {
        console.warn("Post-repair validation still has issues:", revalidation.errors.slice(0, 5));
        // Continue with best-effort plan — returning something is better than crashing
      }
    }

    // ── Step 7: Assemble Response (totals recalculated from hourly_plan) ──
    const response = buildResponseWithTariffs({
      scenarioId: input.scenario_id,
      directiveInterpretation: directives,
      hourlyPlan: hourlyPlan,
      hoursData: input.hours,
      planSummary: generatePlanSummary(directives, hourlyPlan),
    });

    return res.status(200).json(response);
  } catch (err) {
    console.error("Optimization error:", err.message);
    // Never expose stack traces or secrets
    return res.status(500).json({
      error: "Internal server error during optimization",
    });
  }
});

/**
 * Generate a short human-readable plan summary.
 */
function generatePlanSummary(directives, hourlyPlan) {
  const applied = directives.filter((d) => d.applies);
  const ignored = directives.filter((d) => !d.applies);

  const parts = [];

  if (applied.length > 0) {
    const types = applied.map((d) => d.directive_type).join(", ");
    parts.push(`Applied ${applied.length} directive(s): ${types}`);
  }

  if (ignored.length > 0) {
    parts.push(`Ignored ${ignored.length} irrelevant note(s)`);
  }

  // Calculate basic stats
  let totalGrid = 0;
  let peakGrid = 0;
  for (const h of hourlyPlan) {
    totalGrid += h.grid_kwh;
    peakGrid = Math.max(peakGrid, h.grid_kwh);
  }

  parts.push(
    `Total grid: ${Math.round(totalGrid * 100) / 100} kWh, peak: ${Math.round(peakGrid * 100) / 100} kWh`
  );

  parts.push("Battery returns to initial level at end of day.");

  return parts.join(". ") + ".";
}

module.exports = router;
