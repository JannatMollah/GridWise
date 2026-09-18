/**
 * Deterministic guardrail validator for LLM-produced directive interpretations.
 * LLM output is treated as untrusted data — every field is validated
 * before the directives are applied to the optimizer.
 */

const ALLOWED_DIRECTIVE_TYPES = new Set([
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
]);

/**
 * Validate and sanitize an array of LLM-produced interpretations.
 * Returns a clean, validated array safe for the optimizer.
 */
function validateInterpretations(interpretations, operatorNotes, battery) {
  const noteCount = operatorNotes.length;
  const validated = [];
  const seenIndices = new Set();

  // If LLM returned wrong count, we still need one per note
  for (let i = 0; i < noteCount; i++) {
    const raw = interpretations.find((d) => d.note_index === i) || interpretations[i];

    if (!raw) {
      // Missing interpretation — fallback to no_op
      validated.push(makeNoOp(i, "Missing interpretation from LLM; defaulted to no_op."));
      continue;
    }

    const result = validateSingleDirective(raw, i, battery);

    if (seenIndices.has(result.note_index)) {
      // Duplicate — fallback to no_op
      validated.push(makeNoOp(i, "Duplicate note_index detected; defaulted to no_op."));
      continue;
    }

    seenIndices.add(result.note_index);
    validated.push(result);
  }

  return validated;
}

/**
 * Validate a single directive interpretation entry.
 */
function validateSingleDirective(raw, expectedIndex, battery) {
  // Fix note_index if wrong
  const noteIndex = typeof raw.note_index === "number" ? raw.note_index : expectedIndex;

  // Validate directive_type
  const directiveType =
    typeof raw.directive_type === "string" && ALLOWED_DIRECTIVE_TYPES.has(raw.directive_type)
      ? raw.directive_type
      : "no_op";

  // Handle no_op
  if (directiveType === "no_op") {
    return makeNoOp(expectedIndex, raw.explanation || "Marked as no_op.");
  }

  // Validate structured_adjustment
  const adj = raw.structured_adjustment;
  if (!adj || typeof adj !== "object") {
    return makeNoOp(expectedIndex, "Invalid structured_adjustment; defaulted to no_op.");
  }

  // Validate hours array (common to all non-no_op directives)
  const hours = validateHours(adj.hours);
  if (!hours) {
    return makeNoOp(expectedIndex, "Invalid hours array; defaulted to no_op.");
  }

  // Type-specific validation
  switch (directiveType) {
    case "solar_reduction": {
      const factor = parseFloat(adj.factor);
      if (isNaN(factor) || factor < 0 || factor > 1) {
        return makeNoOp(expectedIndex, "Invalid solar_reduction factor; defaulted to no_op.");
      }
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: "solar_reduction",
        structured_adjustment: { hours, factor: round2(factor) },
        explanation: sanitizeExplanation(raw.explanation),
      };
    }

    case "minimum_battery_reserve": {
      const minEnergy = parseFloat(adj.minimum_energy_kwh);
      if (isNaN(minEnergy) || minEnergy < 0 || !isFinite(minEnergy)) {
        return makeNoOp(expectedIndex, "Invalid minimum_energy_kwh; defaulted to no_op.");
      }
      // Cap at battery capacity
      const cappedEnergy = Math.min(minEnergy, battery.capacity_kwh);
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: "minimum_battery_reserve",
        structured_adjustment: { hours, minimum_energy_kwh: round2(cappedEnergy) },
        explanation: sanitizeExplanation(raw.explanation),
      };
    }

    case "no_charge_window": {
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: "no_charge_window",
        structured_adjustment: { hours },
        explanation: sanitizeExplanation(raw.explanation),
      };
    }

    case "no_discharge_window": {
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: "no_discharge_window",
        structured_adjustment: { hours },
        explanation: sanitizeExplanation(raw.explanation),
      };
    }

    case "max_grid_window": {
      const maxGrid = parseFloat(adj.max_grid_kwh);
      if (isNaN(maxGrid) || maxGrid < 0 || !isFinite(maxGrid)) {
        return makeNoOp(expectedIndex, "Invalid max_grid_kwh; defaulted to no_op.");
      }
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: "max_grid_window",
        structured_adjustment: { hours, max_grid_kwh: round2(maxGrid) },
        explanation: sanitizeExplanation(raw.explanation),
      };
    }

    default:
      return makeNoOp(expectedIndex, "Unsupported directive type; defaulted to no_op.");
  }
}

/**
 * Validate hours array: must be unique integers 0-23 in ascending order.
 * Returns cleaned array or null if invalid.
 */
function validateHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0) return null;

  const cleaned = [];
  const seen = new Set();

  for (const h of hours) {
    const num = typeof h === "number" ? Math.round(h) : parseInt(h, 10);
    if (isNaN(num) || num < 0 || num > 23) return null;
    if (seen.has(num)) return null;
    seen.add(num);
    cleaned.push(num);
  }

  // Must be in ascending order
  cleaned.sort((a, b) => a - b);
  return cleaned;
}

/**
 * Create a safe no_op fallback entry.
 */
function makeNoOp(noteIndex, explanation) {
  return {
    note_index: noteIndex,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: explanation || "This note does not affect today's energy schedule.",
  };
}

/**
 * Sanitize explanation string — remove any potential secrets or overly long text.
 */
function sanitizeExplanation(text) {
  if (!text || typeof text !== "string") {
    return "Interpretation provided by LLM.";
  }
  // Truncate to 500 chars, strip any potential key-like patterns
  return text.slice(0, 500).replace(/[A-Za-z0-9_-]{30,}/g, "[REDACTED]");
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

module.exports = { validateInterpretations, validateHours, makeNoOp };
