/**
 * LLM Interpreter — Supports Google Gemini SDK and OpenRouter API.
 * 
 * Uses LLM_PROVIDER env var to choose:
 *   "gemini" (default) → Google Generative AI SDK
 *   "openrouter"       → OpenRouter-compatible HTTP API
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config");

let geminiModel = null;

/**
 * Build the interpretation prompt.
 */
function buildPrompt(operatorNotes, battery) {
  const notesText = operatorNotes
    .map((note, i) => `  Note ${i}: "${note}"`)
    .join("\n");

  return `You are an energy operations analyst for a university campus energy management system.
You must interpret each operator note and extract a structured energy directive.

BATTERY CONTEXT (use for percentage/fraction calculations):
- Battery capacity: ${battery.capacity_kwh} kWh
- Initial energy: ${battery.initial_energy_kwh} kWh
- Base minimum reserve: ${battery.minimum_energy_kwh} kWh
- Half of capacity = ${battery.capacity_kwh * 0.5} kWh
- One-third of capacity = ${Math.round(battery.capacity_kwh / 3 * 100) / 100} kWh
- One-quarter of capacity = ${battery.capacity_kwh * 0.25} kWh

SUPPORTED DIRECTIVE TYPES (use ONLY these):
1. "solar_reduction" → structured_adjustment: {"hours": [...], "factor": <number 0-1>}
   - factor = usable fraction REMAINING after reduction
   - "80% reduction" means factor = 0.2 (only 20% remains)
   - "reduced to 25%" or "roughly 25% of forecast" means factor = 0.25
   - "drop to about 20%" means factor = 0.2
   - "one-fifth of normal output" means factor = 0.2
   - "halved" or "half of forecast" means factor = 0.5
   - "completely offline" means factor = 0.0
   
2. "minimum_battery_reserve" → structured_adjustment: {"hours": [...], "minimum_energy_kwh": <number>}
   - "50% of capacity" with ${battery.capacity_kwh} kWh battery = ${battery.capacity_kwh * 0.5} kWh
   - "half the battery's storage capability" = ${battery.capacity_kwh * 0.5} kWh
   - "half of the battery capacity" = ${battery.capacity_kwh * 0.5} kWh
   - "at least 120 kWh" = minimum_energy_kwh: 120
   - "no less than half the battery's storage capability" = ${battery.capacity_kwh * 0.5} kWh
   - "keep no less than" = minimum_battery_reserve
   - "must not fall below" = minimum_battery_reserve
   
3. "no_charge_window" → structured_adjustment: {"hours": [...]}
   - Battery charging is forbidden during these hours
   - "charger isolated" / "charger unavailable" / "charging disabled" / "charger inspection"
   
4. "no_discharge_window" → structured_adjustment: {"hours": [...]}
   - Battery discharging is forbidden during these hours
   - "must not discharge" / "protection testing" / "relay testing"
   
5. "max_grid_window" → structured_adjustment: {"hours": [...], "max_grid_kwh": <number>}
   - Grid import cannot exceed the stated amount during these hours
   - "grid import must not exceed 155 kWh" / "transformer limit" / "feeder cap"
   
6. "no_op" → structured_adjustment: null
   - The note does NOT affect the 24-hour energy schedule (irrelevant/distractor)

CRITICAL TIME RULES:
- Time windows are START-INCLUSIVE, END-EXCLUSIVE using whole hours:
  * "noon until 2 PM" → hours [12, 13]
  * "1 PM to 3 PM" → hours [13, 14]
  * "2 AM until 5 AM" → hours [2, 3, 4]
  * "6 PM until 9 PM" → hours [18, 19, 20]
  * "6 PM until 10 PM" → hours [18, 19, 20, 21]
  * "7 PM through 10 PM" → hours [19, 20, 21]
  * "from midnight to 4 AM" → hours [0, 1, 2, 3]
  * "11 AM and 2 PM" → hours [11, 12, 13]
  * "between 11 AM and 1 PM" → hours [11, 12]
- Hours must be unique integers from 0-23, sorted in ASCENDING order

CRITICAL DIRECTIVE RULES:
- For no_op: set applies=false, directive_type="no_op", structured_adjustment=null
- For ALL other directives: set applies=true
- NEVER invent demand, tariff, or battery parameters
- NEVER create directive types not listed above
- If a note discusses cafeteria menus, sports schedules, registration deadlines, events, seminar rooms, library hours, hostel, parking, timetable, club notices, campus bus, bookings, or anything NOT related to solar/battery/grid energy → it is "no_op"

OPERATOR NOTES TO INTERPRET:
${notesText}

Return a JSON array with EXACTLY ${operatorNotes.length} entries, one per note, in order.
Each entry must have:
{
  "note_index": <0-based index>,
  "applies": <true for energy directives, false ONLY for no_op>,
  "directive_type": "<one of the 6 types above>",
  "structured_adjustment": <object matching the type's shape, or null for no_op>,
  "explanation": "<short 1-sentence explanation>"
}

Return ONLY the JSON array, no other text.`;
}

// ═══════════════════════════════════════════════
// Google Gemini SDK path
// ═══════════════════════════════════════════════
function getGeminiModel() {
  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    geminiModel = genAI.getGenerativeModel({
      model: config.geminiModel,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });
  }
  return geminiModel;
}

async function callGemini(prompt) {
  const model = getGeminiModel();
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ═══════════════════════════════════════════════
// OpenRouter / OpenAI-compatible HTTP path
// ═══════════════════════════════════════════════
async function callOpenRouter(prompt) {
  const baseUrl = config.openrouterBaseUrl;
  const modelName = config.geminiModel;

  const body = JSON.stringify({
    model: modelName,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.geminiApiKey}`,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}

// ═══════════════════════════════════════════════
// Router based on LLM_PROVIDER config
// ═══════════════════════════════════════════════
async function callLLM(prompt) {
  if (config.llmProvider === "openrouter") {
    return await callOpenRouter(prompt);
  }
  // Default: Gemini SDK
  return await callGemini(prompt);
}

const { parseOperatorNotesRuleBased } = require("./ruleBasedParser");

// ═══════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════
async function interpretOperatorNotes(operatorNotes, battery) {
  if (!config.geminiApiKey || config.geminiApiKey.trim() === "") {
    console.log("[LLM] No API key configured; using Rule-Based Parser.");
    return parseOperatorNotesRuleBased(operatorNotes, battery);
  }

  const prompt = buildPrompt(operatorNotes, battery);
  let lastError = null;
  const provider = config.llmProvider === "openrouter" ? "OpenRouter" : "Gemini";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const responseText = await Promise.race([
        callLLM(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("LLM timeout (15s)")), 15000)
        ),
      ]);

      const parsed = JSON.parse(responseText);

      // Handle both direct array and wrapped object
      const interpretations = Array.isArray(parsed)
        ? parsed
        : parsed.directive_interpretation ||
          parsed.interpretations ||
          parsed.results ||
          parsed.directives ||
          [parsed];

      if (!Array.isArray(interpretations)) {
        throw new Error("LLM did not return an array");
      }

      console.log(`[${provider}] Interpretation successful (attempt ${attempt + 1})`);
      return interpretations;
    } catch (err) {
      lastError = err;
      console.warn(`[${provider}] attempt ${attempt + 1} failed: ${err.message.slice(0, 150)}`);

      // If quota/auth/client error, break immediately to use rule fallback
      if (
        err.message.includes("429") ||
        err.message.includes("Quota exceeded") ||
        err.message.includes("API_KEY_INVALID") ||
        err.message.includes("400") ||
        err.message.includes("403") ||
        err.message.includes("404")
      ) {
        console.warn(`[${provider}] API error, switching immediately to Rule-Based Parser fallback.`);
        break;
      }

      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // Fallback to Rule-Based Parser
  console.log(`[${provider}] Using Rule-Based Parser fallback for operator notes.`);
  return parseOperatorNotesRuleBased(operatorNotes, battery);
}

module.exports = { interpretOperatorNotes };
