# Tooling-only image: node + the claude CLI for the summarizer.
# NO application source is baked in — the repo is bind-mounted at /app.
FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
