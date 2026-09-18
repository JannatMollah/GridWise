const express = require("express");
const cors = require("cors");
const config = require("./config");
const healthRouter = require("./routes/health");
const optimizeRouter = require("./routes/optimize");

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ── Request timeout (30 seconds as per specification) ──
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(500).json({ error: "Request timeout" });
  });
  next();
});

// ── Routes ──
app.use("/health", healthRouter);
app.use("/optimize-energy", optimizeRouter);

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler ──
// Never expose stack traces, secrets, or internal details
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err.message);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON in request body" });
  }

  res.status(500).json({ error: "Internal server error" });
});

// ── Start server ──
const PORT = config.port;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GridWise LLM service running on http://0.0.0.0:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Optimize: POST http://localhost:${PORT}/optimize-energy`);

  if (!config.geminiApiKey) {
    console.warn("WARNING: GEMINI_API_KEY is not set. LLM interpretation will fail.");
  }
});

module.exports = app;
