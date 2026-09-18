const dotenv = require("dotenv");
dotenv.config();

const config = {
  port: parseInt(process.env.PORT || "8000", 10),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  // Set LLM_PROVIDER=openrouter in .env to use OpenRouter instead of Gemini SDK
  llmProvider: process.env.LLM_PROVIDER || "gemini",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
};

module.exports = config;
