# GridWise LLM — Smart Campus Energy Optimization

> BUP CSE Fest 2026 Hackathon · Online Preliminary Round  
> LLM-Assisted Operator Directive Interpretation

## Overview

An HTTP API service that receives a 24-hour campus energy scenario with natural-language operator notes and returns:
1. **Machine-checkable directive interpretation** of each operator note
2. **Optimal 24-hour energy schedule** that minimizes grid electricity cost

### Architecture

```
Request → Input Validation (Zod) → LLM Interpreter (Gemini) → Guardrail Validator → LP Optimizer → Output Replay Validator → Response
```

```
┌──────────────────────────────────────────────────────────────────┐
│                        POST /optimize-energy                      │
│                                                                    │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────┐  │
│  │   Zod    │──▶│  Gemini  │──▶│ Guardrail│──▶│ LP Optimizer │  │
│  │ Validator│   │   LLM    │   │ Validator│   │  (simplex)   │  │
│  └──────────┘   └──────────┘   └──────────┘   └──────┬───────┘  │
│                                                       │          │
│                                              ┌────────▼───────┐  │
│                                              │ Output Replay  │  │
│                                              │   Validator    │  │
│                                              └────────┬───────┘  │
│                                                       │          │
│                                              ┌────────▼───────┐  │
│                                              │  JSON Response │  │
│                                              └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js |
| LLM | Google Gemini (`@google/generative-ai` SDK) |
| LP Solver | `javascript-lp-solver` (simplex method) |
| Validation | Zod (schema validation) |
| Deployment | Render (online) / Docker (local) |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key for Gemini |
| `GEMINI_MODEL` | ❌ | Model name (default: `gemini-1.5-flash`) |
| `PORT` | ❌ | Server port (default: `8000`) |

⚠️ **Do NOT commit `.env` or any secrets to the repository.**

## Local Quickstart

```bash
# 1. Clone the repository
git clone <repo-url>
cd project

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# 4. Start the service
npm start

# 5. Verify health
curl http://localhost:8000/health
# Expected: {"status":"ok"}
```

## API Endpoints

### GET /health

Readiness check for the judging harness.

```bash
curl http://localhost:8000/health
```

**Response (200):**
```json
{"status": "ok"}
```

### POST /optimize-energy

Main LLM interpretation + 24-hour optimization endpoint.

```bash
curl -X POST http://localhost:8000/optimize-energy \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_id": "SAMPLE-01",
    "operator_notes": [
      "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
      "The sports office moved next month'\''s registration deadline."
    ],
    "hours": [
      {"hour": 0, "demand_kwh": 90, "solar_kwh": 0, "tariff_bdt_per_kwh": 6},
      ...
    ],
    "battery": {
      "capacity_kwh": 220,
      "initial_energy_kwh": 110,
      "minimum_energy_kwh": 40,
      "max_charge_kwh_per_hour": 50,
      "max_discharge_kwh_per_hour": 50
    }
  }'
```

**Response (200):**
```json
{
  "scenario_id": "SAMPLE-01",
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "solar_reduction",
      "structured_adjustment": {"hours": [12, 13], "factor": 0.25},
      "explanation": "Solar availability is reduced to 25% during the panel-cleaning window."
    },
    {
      "note_index": 1,
      "applies": false,
      "directive_type": "no_op",
      "structured_adjustment": null,
      "explanation": "This note does not affect today's energy schedule."
    }
  ],
  "hourly_plan": [ ... 24 hourly entries ... ],
  "total_grid_kwh": 2692.5,
  "total_cost_bdt": 38365,
  "peak_grid_kwh": 175,
  "plan_summary": "Applied 1 directive(s): solar_reduction. Ignored 1 irrelevant note(s)..."
}
```

## LLM Role

The Google Gemini LLM is used to **interpret natural-language operator notes** into structured energy directives. It is part of the critical path:

1. Operator notes (free text) → **Gemini LLM** → raw structured interpretation
2. Raw interpretation → **Deterministic guardrails** → validated directives
3. Validated directives → **LP optimizer** → optimal 24-hour schedule

The LLM is NOT used for plan_summary generation or cosmetic purposes only — it directly produces the `directive_interpretation` consumed by the optimizer.

### Guardrails

LLM output is treated as **untrusted data**. Before any directive reaches the optimizer:
- Directive type must be one of 6 supported types
- Hours must be unique integers 0-23 in ascending order
- Solar factor must be between 0 and 1
- Battery reserve must be ≤ capacity
- Grid cap must be non-negative
- `no_op` enforces `applies=false` + `structured_adjustment=null`
- Invalid LLM output falls back to `no_op` (safe failure, no crash)

### Optimizer/Solver

Uses `javascript-lp-solver` (simplex method) for linear programming:
- **Objective**: Minimize `Σ(grid_kwh[h] × tariff[h])`
- **Constraints**: Energy balance, battery bounds, charge/discharge rate limits, solar limits, end-of-day neutrality, plus all directive-specific constraints
- Produces **globally optimal** solutions for feasible problems

## Running Public Sample Tests

```bash
# Test optimizer against all 10 sample cases (no LLM needed)
node tests/optimizerAllCases.js

# Full end-to-end test (requires GEMINI_API_KEY)
npm test
```

## Docker Fallback Image (Official Evaluation Artifact)

As required by the **BUP CSE Fest 2026 Evaluation Rubric (Item 4 & Rubric Section 6)**, a tested, pullable container image is provided as a fallback execution path for judges and organizers.

### Container Specifications

| Specification | Value |
|---|---|
| **Registry Reference** | `ghcr.io/md-sohan-bhuyan/bup_preli:latest` |
| **Alternative Docker Hub** | `docker.io/mdsohanbhuyan/gridwise-llm:latest` |
| **Exposed Port** | `8000` (binds to `0.0.0.0`) |
| **Base Image** | `node:20-alpine` (~130 MB minimal footprint) |
| **Security User** | `node` (non-root UID 1000) |
| **Baked-in Secrets** | **None** (zero credentials baked into the image) |
| **Health Check** | Native HTTP check on `http://127.0.0.1:8000/health` |

### Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key for Gemini LLM |
| `PORT` | ❌ | Port to bind (default: `8000`) |
| `GEMINI_MODEL` | ❌ | Model identifier (default: `gemini-1.5-flash`) |
| `LLM_PROVIDER` | ❌ | Provider selection (default: `gemini`) |

---

### One-Command Quickstart (For Judges & Organizers)

#### Step 1: Pull the image from registry
```bash
docker pull ghcr.io/md-sohan-bhuyan/bup_preli:latest
```

#### Step 2: Run container with your API key
```bash
docker run -d \
  --name gridwise-service \
  -p 8000:8000 \
  -e GEMINI_API_KEY="<your-gemini-api-key>" \
  -e PORT=8000 \
  ghcr.io/md-sohan-bhuyan/bup_preli:latest
```

#### Step 3: Verify readiness (/health)
```bash
curl http://localhost:8000/health
# Expected Output: {"status":"ok"}
```

#### Step 4: Test optimization endpoint (/optimize-energy)
```bash
curl -X POST http://localhost:8000/optimize-energy \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_id": "HEALTH-CHECK",
    "operator_notes": ["No special directives today."],
    "hours": [
      {"hour": 0, "demand_kwh": 10, "solar_kwh": 0, "tariff_bdt_per_kwh": 5}
    ],
    "battery": {
      "capacity_kwh": 100,
      "initial_energy_kwh": 50,
      "minimum_energy_kwh": 10,
      "max_charge_kwh_per_hour": 25,
      "max_discharge_kwh_per_hour": 25
    }
  }'
```

---

### Local Build from Source (Alternative)

If building locally from the repository source:

```bash
# Build the production image
docker build -t gridwise-llm .

# Run with .env file
docker run -d \
  --name gridwise-service \
  -p 8000:8000 \
  --env-file .env \
  gridwise-llm

# Or using Docker Compose
docker compose up -d --build
```

### Stop & Cleanup
```bash
docker stop gridwise-service && docker rm gridwise-service
# Or with Docker Compose:
docker compose down
```

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| express | ^5.x | HTTP framework |
| @google/generative-ai | ^0.24.x | Google Gemini LLM SDK |
| javascript-lp-solver | ^1.0.x | Linear programming solver |
| zod | ^4.x | Request schema validation |
| cors | ^2.x | CORS middleware |
| dotenv | ^18.x | Environment variable loading |

## Known Limitations

- **LLM latency**: Gemini API calls typically take 1-5 seconds; under load, may approach the 30-second timeout
- **LLM paraphrase coverage**: Novel or highly unusual phrasings may be misinterpreted; guardrails catch structurally invalid interpretations but cannot fix semantic errors
- **Cold start**: First request after deployment may be slower due to Gemini SDK initialization
- **Rate limits**: Google AI Studio free tier has rate limits; monitor quota during extended testing
- **LP solver precision**: Uses floating-point arithmetic; values are rounded to 2 decimal places (within the 0.01 tolerance)

## Secret Handling

- API keys are loaded via environment variables only
- `.env` is gitignored and never committed
- No secrets appear in API responses, logs, or error messages
- Stack traces are suppressed in production error responses
