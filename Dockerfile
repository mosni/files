# --- build stage: produces both Vite outputs (SPA + SSR) ---
FROM node:24-alpine AS build
WORKDIR /repo
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build
RUN npx vite build --config vite.ssr.config.ts

# --- runtime image ---
FROM node:24-alpine
# D-60: video metadata stripping runs ffmpeg -map_metadata -1 -c copy at ingest (never a transcode - D-20,
# the box is too weak).
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /repo/web/dist ./web/dist
COPY --from=build /repo/app/dist ./app/dist
# schema.sql is read at runtime relative to the BUILT server.js's own location (import.meta.url), not its
# original app/src/storage/ path - the SSR build bundles everything into one file, so the asset must sit
# next to it. This is the visible consequence of D-44 (the server runs built output, not source).
COPY --from=build /repo/app/src/storage/schema.sql ./app/dist/schema.sql
EXPOSE 3000
CMD ["node", "app/dist/server.js"]
