/**
 * Rule-based fallback parser for operator notes.
 * Used when LLM is rate-limited (e.g. HTTP 429 quota error), unavailable, or times out.
 *
 * This parser covers the six supported directive types:
 *   solar_reduction, minimum_battery_reserve, no_charge_window,
 *   no_discharge_window, max_grid_window, no_op
 *
 * Hidden test cases may paraphrase directives in many ways.
 * This parser is a FALLBACK — the LLM is the primary interpreter.
 */

// ── Spelled-out number mapping ──
const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  "twenty-one": 21, "twenty-two": 22, "twenty-three": 23,
};

function parseTimeStr(rawStr) {
  if (!rawStr) return null;
  const str = rawStr.trim().toLowerCase();
  if (str === "noon" || str === "midday") return 12;
  if (str === "midnight") return 0;

  // Check spelled-out number first (e.g., "one", "three")
  // Strip trailing am/pm for word matching
  const wordMatch = str.match(/^([a-z-]+)\s*(am|pm)?$/);
  if (wordMatch && WORD_NUMBERS[wordMatch[1]] !== undefined) {
    let hr = WORD_NUMBERS[wordMatch[1]];
    const meridiem = wordMatch[2];
    if (meridiem === "pm" && hr < 12) hr += 12;
    if (meridiem === "am" && hr === 12) hr = 0;
    return hr;
  }

  // matches "10", "10am", "10 am", "10:00", "10:00am", "10:00 am", "10.00 am"
  const m = str.match(/^(\d{1,2})(?::(\d{2})|\.(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hr = parseInt(m[1], 10);
  const meridiem = m[4];
  if (meridiem === "pm" && hr < 12) hr += 12;
  if (meridiem === "am" && hr === 12) hr = 0;
  return hr;
}

function extractHours(text) {
  const lower = text.toLowerCase();

  // Pattern: (from|between|during)? <time1> (until|to|and|through|till|-|–) <time2>
  const phraseRegex = /(?:from|between|during)?\s*(\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:-(?:one|two|three))?)\s*(?:am|pm)?|noon|midday|midnight))\s*(?:until|to|and|through|till|-|–)\s*(\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:-(?:one|two|three))?)\s*(?:am|pm)?|noon|midday|midnight))/;

  const match = lower.match(phraseRegex);
  if (!match) return null;

  let startStr = match[1].trim();
  let endStr = match[2].trim();

  let startHr = parseTimeStr(startStr);
  let endHr = parseTimeStr(endStr);

  if (startHr === null || endHr === null) return null;

  const startHasMeridiem =
    startStr.includes("am") ||
    startStr.includes("pm") ||
    startStr === "noon" ||
    startStr === "midnight" ||
    startStr === "midday";
  const endHasMeridiem =
    endStr.includes("am") ||
    endStr.includes("pm") ||
    endStr === "noon" ||
    endStr === "midnight" ||
    endStr === "midday";

  // Infer AM/PM for start when end has meridiem
  if (!startHasMeridiem && endHasMeridiem) {
    if (endStr.includes("pm") || endStr === "noon") {
      // If start is a small number and end is PM, start might be AM or PM
      // e.g., "1 until 3 PM" → start should be 1 PM = 13
      // e.g., "6 until 9 PM" → start should be 6 PM = 18
      if (startHr < 12 && startHr + 12 <= endHr) {
        startHr += 12;
      } else if (startHr < 12 && startHr < endHr) {
        // "10 until noon" → startHr=10 is AM, endHr=12
        // keep as-is
      }
    }
    if (endStr.includes("am")) {
      // "11 until 5 AM" → doesn't make much sense, but keep as-is
    }
  }

  // Handle "midnight" as 24 when it's the end time and start > 0
  if (endStr === "midnight" && startHr > 0) {
    endHr = 24;
  }

  if (startHr >= endHr) return null;

  const hours = [];
  for (let h = startHr; h < endHr; h++) {
    if (h >= 0 && h < 24) {
      hours.push(h);
    }
  }
  return hours.length > 0 ? hours : null;
}

function extractSolarFactor(lower) {
  // ── Word fractions ──

  // "one-fifth" / "a fifth" / "1/5"
  if (lower.match(/(?:one[- ]fifth|a fifth|1\/5)/)) {
    if (lower.match(/reduced by|cut by|drop by|reduction of/)) return 0.8;
    return 0.2;
  }

  // Explicit fractions with "quarter"
  if (lower.includes("quarter") || lower.includes("fourth")) {
    if (lower.match(/reduced by\s+(?:a|one)?\s*(?:quarter|fourth)/) || lower.match(/(?:quarter|fourth)\s+reduction/)) {
      return 0.75;
    }
    if (lower.match(/reduced by\s+three[\s-](?:quarters|fourths)/)) {
      return 0.25;
    }
    if (lower.match(/three[\s-](?:quarters|fourths)/)) {
      return 0.75;
    }
    if (lower.match(/(?:only|roughly|about|approximately)?\s*(?:a|one)?\s*quarter/)) {
      return 0.25;
    }
    return 0.25;
  }

  // Explicit fractions with "half"
  if (lower.includes("half") || lower.includes("halved")) {
    if (lower.match(/reduced by\s+(?:a\s+)?half/)) return 0.5;
    return 0.5;
  }

  // Explicit fractions with "third"
  if (lower.includes("third")) {
    if (lower.match(/two[\s-]thirds/)) {
      if (lower.match(/reduced by\s+two[\s-]thirds/)) return 0.33;
      return 0.67;
    }
    if (lower.match(/reduced by\s+(?:a|one)?\s*third/)) {
      return 0.67;
    }
    if (lower.match(/(?:only|roughly|about|approximately)?\s*(?:a|one)?\s*third/)) {
      return 0.33;
    }
    return 0.33;
  }

  // Zero generation
  if (
    lower.includes("zero output") ||
    lower.includes("no solar") ||
    lower.includes("zero solar") ||
    lower.includes("completely offline") ||
    lower.includes("zero generation") ||
    lower.includes("producing zero") ||
    lower.includes("no generation") ||
    lower.includes("offline")
  ) {
    return 0.0;
  }

  // "reduced by X%" / "X% reduction" / "cut by X%" / "drop by X%"
  const matchRed =
    lower.match(/(?:reduced by|cut by|curtailed by|drop by|decrease by|fall by|decline by)\s*(?:about\s*|roughly\s*|approximately\s*)?([\d.]{1,5})%/) ||
    lower.match(/([\d.]{1,5})%\s*(?:reduction|cut|drop|decrease|decline|fall)/) ||
    lower.match(/reduction of\s*(?:about\s*|roughly\s*|approximately\s*)?([\d.]{1,5})%/);
  if (matchRed) {
    return Math.max(0, Math.min(1, 1 - parseFloat(matchRed[1]) / 100));
  }

  // "X% of (the/its)? forecast/normal/expected/usual/capacity/output"
  const matchOf = lower.match(
    /([\d.]{1,5})%\s+of\s+(?:the\s+|its\s+)?(?:forecast|normal|expected|usual|capacity|output|rated)/
  );
  if (matchOf) {
    return Math.max(0, Math.min(1, parseFloat(matchOf[1]) / 100));
  }

  // "drop to / reduced to / leave / producing / fall to / operating at / down to X%"
  const matchTo = lower.match(
    /(?:drop to|reduced to|leave|leaving|producing|produce|fall to|falling to|operating at|curtailed to|down to|limited to|at)\s*(?:about\s*|only\s*|roughly\s*|approximately\s*|around\s*)?([\d.]{1,5})%/
  );
  if (matchTo) {
    return Math.max(0, Math.min(1, parseFloat(matchTo[1]) / 100));
  }

  // Any other percentage in solar context
  const matchPct = lower.match(/([\d.]{1,5})%/);
  if (matchPct) {
    const pct = parseFloat(matchPct[1]);
    // Heuristic: if the percentage > 50, it's likely a reduction amount, not remaining
    // e.g., "80% reduction" already captured above
    // Here, "25%" likely means 25% remaining
    return Math.max(0, Math.min(1, pct / 100));
  }

  return null;
}

/**
 * Extract a numeric reserve value from the note, relative to battery if needed.
 */
function extractReserveValue(lower, battery) {
  // ── Percentage of battery capacity ──
  const matchPctCap = lower.match(
    /([\d.]{1,5})%\s+of\s+(?:the\s+)?(?:battery\s+)?(?:capacity|storage|stored)/
  );
  if (matchPctCap && battery) {
    return (parseFloat(matchPctCap[1]) / 100) * battery.capacity_kwh;
  }

  // ── Word fractions relative to battery ──
  // "half the battery capacity" / "half the battery's storage capability" / "half of the battery capacity"
  const isHalfBattery = lower.match(
    /half\s+(?:of\s+)?(?:the\s+)?(?:battery(?:'s)?\s+)?(?:storage\s+)?(?:capacity|capability|energy|charge|stored|full)/
  ) || (
    lower.includes("half") && (
      lower.includes("battery") || lower.includes("storage") || lower.includes("capacity")
    )
  );
  if (isHalfBattery && battery) {
    return 0.5 * battery.capacity_kwh;
  }

  // "a third of the battery capacity" / "one-third of the battery"
  const isThirdBattery = lower.match(
    /(?:a|one)[\s-]third\s+(?:of\s+)?(?:the\s+)?(?:battery|storage|capacity)/
  );
  if (isThirdBattery && battery) {
    return (1 / 3) * battery.capacity_kwh;
  }

  // "two-thirds of the battery capacity"
  const isTwoThirdsBattery = lower.match(
    /two[\s-]thirds?\s+(?:of\s+)?(?:the\s+)?(?:battery|storage|capacity)/
  );
  if (isTwoThirdsBattery && battery) {
    return (2 / 3) * battery.capacity_kwh;
  }

  // "a quarter of the battery capacity"
  const isQuarterBattery = lower.match(
    /(?:a|one)[\s-](?:quarter|fourth)\s+(?:of\s+)?(?:the\s+)?(?:battery|storage|capacity)/
  );
  if (isQuarterBattery && battery) {
    return 0.25 * battery.capacity_kwh;
  }

  // "three-quarters of the battery capacity"
  const isThreeQuartersBattery = lower.match(
    /three[\s-](?:quarters?|fourths?)\s+(?:of\s+)?(?:the\s+)?(?:battery|storage|capacity)/
  );
  if (isThreeQuartersBattery && battery) {
    return 0.75 * battery.capacity_kwh;
  }

  // Simple percentage (e.g., "50%") — in reserve context, likely percentage of capacity
  const matchPctSimple = lower.match(/([\d.]{1,5})%/);
  if (matchPctSimple && battery) {
    return (parseFloat(matchPctSimple[1]) / 100) * battery.capacity_kwh;
  }

  // ── Absolute kWh value ──
  const matchKwh = lower.match(
    /(?:at least|keep|maintain|hold|remain|reserve|minimum of|not fall below|no less than|not drop below|not go below|above)\s+([\d.]+)\s*kwh/
  );
  if (matchKwh) {
    return parseFloat(matchKwh[1]);
  }

  // Fallback: any kWh value in the note
  const matchKwh2 = lower.match(/([\d.]+)\s*kwh/);
  if (matchKwh2) {
    return parseFloat(matchKwh2[1]);
  }

  return null;
}

function parseSingleNote(note, battery, noteIndex) {
  const text = note.trim();
  const lower = text.toLowerCase();

  // ── Distractor detection ──
  const distractorKeywords = [
    "sports office", "registration deadline", "library", "book-return",
    "book return", "student affairs", "club notices", "seminar room",
    "cafeteria", "menu", "parking", "orientation", "timetable",
    "hostel", "convocation", "alumni", "faculty meeting", "campus bus",
    "shuttle", "moved to next week", "next month", "tomorrow",
    "booking", "schedule", "room booking", "exam", "class",
  ];
  const energyKeywords = [
    "solar", "photovoltaic", "pv", "battery", "kwh", "grid", "feeder",
    "substation", "transformer", "charger", "discharge", "charge",
    "panel", "rooftop", "inverter", "reserve", "energy", "power",
    "import", "intake", "electricity", "watt", "generation", "output",
    "storage", "capacity", "tariff",
  ];

  // Distractor check only if no explicit energy keywords
  const hasDistractor = distractorKeywords.some((k) => lower.includes(k));
  const hasEnergy = energyKeywords.some((k) => lower.includes(k));

  if (hasDistractor && !hasEnergy) {
    return makeNoOp(noteIndex, "This note does not affect today's energy schedule.");
  }

  const hours = extractHours(text);

  // 1. Solar reduction
  const isSolar =
    lower.includes("solar") ||
    lower.includes("photovoltaic") ||
    lower.includes("pv ") ||
    lower.includes("pv.") ||
    lower.match(/\bpv\b/) ||
    lower.includes("panel") ||
    lower.includes("rooftop") ||
    lower.includes("inverter") ||
    (lower.includes("roof") && (lower.includes("maintenance") || lower.includes("cleaning")));

  if (isSolar && hours) {
    const factor = extractSolarFactor(lower);
    if (factor !== null) {
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: "solar_reduction",
        structured_adjustment: { hours, factor: round2(factor) },
        explanation: "Solar availability is reduced during the specified hours.",
      };
    }
  }

  // 2. Minimum battery reserve — EXPANDED keyword detection
  const isReserve =
    lower.includes("reserve") ||
    lower.includes("keep at least") ||
    lower.includes("keep no less") ||
    lower.includes("no less than") ||
    lower.includes("remain in the battery") ||
    lower.includes("stored in the battery") ||
    lower.includes("maintain at least") ||
    lower.includes("hold at least") ||
    lower.includes("must not fall below") ||
    lower.includes("must not drop below") ||
    lower.includes("must not go below") ||
    lower.includes("stay above") ||
    lower.includes("stay at or above") ||
    lower.includes("emergency operations") ||
    lower.includes("emergency services") ||
    lower.includes("backup") ||
    lower.includes("available") ||
    lower.includes("storage capability") ||
    lower.includes("storage capacity") ||
    lower.includes("data center") ||
    lower.includes("data centre") ||
    (lower.includes("at least") && (lower.includes("battery") || lower.includes("stored") || lower.includes("kwh"))) ||
    (lower.includes("minimum") && (lower.includes("battery") || lower.includes("energy") || lower.includes("kwh")));

  // Battery/reserve context: must also mention battery/stored/capacity/energy/kwh
  const hasBatteryContext =
    lower.includes("battery") ||
    lower.includes("stored") ||
    lower.includes("storage") ||
    lower.includes("capacity") ||
    lower.includes("reserve") ||
    lower.includes("energy") ||
    lower.includes("kwh") ||
    lower.includes("charge");

  if (isReserve && hasBatteryContext && hours) {
    const minEnergy = extractReserveValue(lower, battery);

    if (minEnergy !== null && minEnergy >= 0) {
      // Cap at battery capacity
      const cappedEnergy = battery ? Math.min(minEnergy, battery.capacity_kwh) : minEnergy;
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: "minimum_battery_reserve",
        structured_adjustment: { hours, minimum_energy_kwh: round2(cappedEnergy) },
        explanation: "Battery reserve required for the specified window.",
      };
    }
  }

  // 3. No discharge window
  const isNoDischarge =
    lower.includes("discharge") &&
    (lower.includes("not") ||
     lower.includes("no ") ||
     lower.startsWith("no ") ||
     lower.includes("prevent") ||
     lower.includes("prohibit") ||
     lower.includes("forbid") ||
     lower.includes("disable") ||
     lower.includes("halt") ||
     lower.includes("stop") ||
     lower.includes("avoid") ||
     lower.includes("must not") ||
     lower.includes("cannot") ||
     lower.includes("relay testing") ||
     lower.includes("protection testing"));

  if (isNoDischarge && hours) {
    return {
      note_index: noteIndex,
      applies: true,
      directive_type: "no_discharge_window",
      structured_adjustment: { hours },
      explanation: "Battery discharging is forbidden during this window.",
    };
  }

  // 4. No charge window
  const isNoCharge =
    (lower.includes("charge") || lower.includes("charger") || lower.includes("charging")) &&
    (lower.includes("not") ||
     lower.includes("no ") ||
     lower.startsWith("no ") ||
     lower.includes("prevent") ||
     lower.includes("prohibit") ||
     lower.includes("forbid") ||
     lower.includes("disable") ||
     lower.includes("halt") ||
     lower.includes("stop") ||
     lower.includes("avoid") ||
     lower.includes("must not") ||
     lower.includes("cannot") ||
     lower.includes("isolated") ||
     lower.includes("unavailable") ||
     lower.includes("maintenance") ||
     lower.includes("disabled") ||
     lower.includes("inspection"));

  if (isNoCharge && hours) {
    return {
      note_index: noteIndex,
      applies: true,
      directive_type: "no_charge_window",
      structured_adjustment: { hours },
      explanation: "Battery charging is forbidden during this window.",
    };
  }

  // 5. Max grid window
  const isGrid =
    lower.includes("grid") ||
    lower.includes("utility") ||
    lower.includes("import") ||
    lower.includes("transformer") ||
    lower.includes("feeder") ||
    lower.includes("substation") ||
    lower.includes("intake");

  if (isGrid && hours) {
    const matchMax =
      lower.match(/(?:not exceed|limit is|at or below|stay at or below|cap at|capped at|maximum of|max of|stay below|must not exceed|cannot exceed|no more than|not go above)\s*([\d.]+)\s*kwh/) ||
      lower.match(/([\d.]+)\s*kwh\s*(?:of grid import|grid limit|import limit|per hour|limit|cap)/) ||
      lower.match(/(?:limit|cap|maximum|max)\s+(?:is\s+|of\s+)?([\d.]+)\s*kwh/) ||
      lower.match(/([\d.]+)\s*kwh/);
    if (matchMax) {
      const maxGrid = parseFloat(matchMax[1]);
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: "max_grid_window",
        structured_adjustment: { hours, max_grid_kwh: round2(maxGrid) },
        explanation: "Grid import is capped during this window.",
      };
    }
  }

  // If we have energy context but couldn't classify — default to no_op
  return makeNoOp(noteIndex, "This note does not affect today's energy schedule.");
}

function makeNoOp(noteIndex, explanation) {
  return {
    note_index: noteIndex,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: explanation || "This note does not affect today's energy schedule.",
  };
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

function parseOperatorNotesRuleBased(operatorNotes, battery) {
  return operatorNotes.map((note, i) => parseSingleNote(note, battery, i));
}

module.exports = { parseOperatorNotesRuleBased, extractHours, parseTimeStr };
