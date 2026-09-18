# ==============================================================================
# BUP CSE Fest 2026 Hackathon - GridWise LLM Service
# Production-Grade Containerfile (Docker Fallback Image)
# ==============================================================================
FROM node:20-alpine

# Metadata labels
LABEL maintainer="Md Sohan Bhuyan"
LABEL project="GridWise LLM - BUP CSE Fest 2026"
LABEL description="Smart Campus Energy Optimizer with LLM Directive Interpretation"

# Set working directory
WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production \
    PORT=8000

# Copy package manifests first for optimal layer caching
COPY package*.json ./

# Install production dependencies only, remove cache to keep image minimal
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy application source code (defense-in-depth: only src/ is copied, never secrets)
COPY src/ ./src/

# Switch to non-root user for container security
USER node

# Expose documented service port
EXPOSE 8000

# Health check as required by judging harness (evaluator verifies /health reachability)
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://127.0.0.1:' + (process.env.PORT || 8000) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Launch the GridWise HTTP API service
CMD ["node", "src/index.js"]
