const express = require("express");
const router = express.Router();

/**
 * GET /health
 * Readiness endpoint for the judging harness.
 * Returns HTTP 200 with {"status": "ok"} when the service is ready.
 */
router.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

module.exports = router;
