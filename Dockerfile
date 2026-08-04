# --- build stage: produces both Vite outputs (SPA + SSR) ---
FROM node:24-alpine AS build
WORKDIR /repo
COPY package*.json .npmrc ./
# scripts/ is copied ahead of the rest of the source purely to keep it in its own cache layer, alongside
# the package files. It used to also have to precede `npm ci` because a `postinstall` hook lived here;
# that hook (patch-vidstack-types.mjs) targeted @vidstack/react 0.6.15's type layout and became a no-op on
# the D-170 upgrade to 1.15.6, so it was removed by the E5/E5.1 review session and nothing here runs on
# install any more.
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npx vite build
RUN npx vite build --config vite.ssr.config.ts

# --- runtime image ---
FROM node:24-alpine
# D-60: video metadata stripping runs ffmpeg -map_metadata -1 -c copy at ingest (never a transcode - D-20,
# the box is too weak).
#
# `vips` is the system libvips, and sharp is deliberately BUILT FROM SOURCE against it rather than using
# its own prebuilt binary. The box is an Intel Atom N2800 (Cedarview, 2011) whose ISA stops at SSSE3 - no
# SSE4.1, no SSE4.2, no POPCNT, no AVX. sharp's prebuilt libvips uses SSE4.1 (the first deploy died on a
# `pmaxud` at libvips-cpp.so+0x35725f, exit 132/SIGILL, in glib hash-table code reached during module
# load), so no runtime flag can avoid it - VIPS_NOVECTOR only disables libvips' optional Highway paths,
# not compiler-emitted baseline codegen. Alpine builds its packages for baseline x86-64, so the system
# libvips is SSE4.1-free and runs on this CPU; verified by disassembly (0 offending instructions in both
# the system .so and the addon this compiles).
#
# `vips-cpp`, not just `vips`: sharp binds to libvips-cpp.so.42 (the C++ bindings), while the `vips`
# package ships only libvips.so.42 (the C library). Installing `vips` alone builds fine and then fails at
# runtime with "Could not load the sharp module", because vips-dev supplied libvips-cpp during the build
# and the cleanup step took it away again.
RUN apk add --no-cache ffmpeg vips vips-cpp
WORKDIR /app
COPY package*.json .npmrc ./
COPY scripts ./scripts
# vips-dev's presence at install time is what makes sharp's installer choose a source build over its
# prebuilt binary; node-addon-api and node-gyp must be real dependencies (not devDependencies) for that
# build to work under --omit=dev. The toolchain is a virtual package so it can be dropped again in the
# same layer.
#
# --omit=optional is load-bearing, not tidiness: sharp's prebuilt libvips ships as OPTIONAL dependencies
# (@img/sharp-libvips-*), and sharp prefers them at RUNTIME even after a successful source build. Without
# this the image builds and reports the system libvips, then loads the prebuilt 8.17.3 anyway and SIGILLs
# on the box - which is exactly what the first attempt at this fix did.
#
# The verification below runs AFTER apk del, so it tests the shipped state rather than the build state,
# and it FAILS THE BUILD if sharp ever resolves back to a bundled prebuilt. This crash cost a production
# outage and is invisible on any dev machine (every modern CPU has SSE4.1), so it gets a real gate.
RUN apk add --no-cache --virtual .sharp-build vips-dev build-base pkgconfig python3 \
 && npm ci --omit=dev --omit=optional \
 && apk del .sharp-build \
 && node -e " \
      const s = require('sharp'); \
      const fs = require('fs'); \
      const bundled = fs.existsSync('/app/node_modules/@img') \
        ? fs.readdirSync('/app/node_modules/@img').filter(d => d.includes('libvips')) : []; \
      if (bundled.length) { console.error('FAIL: bundled prebuilt libvips present:', bundled); process.exit(1); } \
      console.log('OK: sharp', s.versions.sharp, 'on system libvips', s.versions.vips); \
    "
COPY --from=build /repo/web/dist ./web/dist
COPY --from=build /repo/app/dist ./app/dist
# D-83: numbered migrations are read at runtime relative to the BUILT server.js's own location
# (import.meta.url via storage/db.ts's migrationsDir()), not their original app/src/storage/migrations
# path - the SSR build bundles everything into one file, so the .sql assets must sit next to it. This is
# the visible consequence of D-44 (the server runs built output, not source).
COPY --from=build /repo/app/src/storage/migrations ./app/dist/migrations
EXPOSE 3000
CMD ["node", "app/dist/server.js"]
