# BFA ↔ Polymarket arb notifier.
#
# Built on Playwright's official image so headless Chromium (used only to obtain
# the BFA login token) works with zero OS-dependency fiddling. The image TAG
# MUST match the `playwright` npm version in package.json (1.59.1) — a mismatch
# reproduces the exact "browserType.launch: Executable doesn't exist" error we
# hit on Render's native runtime, because the bundled browser build won't match.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Install deps first so this layer caches unless the manifest changes.
# npm ci when a lockfile is present (reproducible), else npm install.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# App source. node_modules / priv / .env / next-frontend are excluded via
# .dockerignore — priv is supplied at runtime by the Render persistent disk,
# and env vars come from the Render dashboard.
COPY . .

ENV NODE_ENV=production
# The notifier binds to process.env.PORT (Render injects it); 3001 is the local default.
EXPOSE 3001

CMD ["node", "services/notifier.js"]
