import { defineConfig } from "@playwright/test";

// D-53 (reverses D-28): browser-driven e2e tests. E1 ships no real UI yet, so `e2e/` holds only a smoke
// test proving the pipeline works; real coverage of browser-only behaviour (drag/drop, clipboard, upload
// resume, mobile pickers) lands with the epics that ship it.

// E5.1 Wave H: the SHA-256 SPKI hash of nginx-e2e's self-signed cert, computed from the FIXED committed
// dev key (e2e/fixtures/dev-tls-key.pem - see docker-compose.verify.yml's nginx-e2e comment for why it
// must be fixed rather than freshly random per build). Recompute with:
//   openssl x509 -pubkey -noout -in <cert> | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
// ONLY if the key file itself ever changes (it should not, absent a deliberate rotation).
const SW_CERT_SPKI = "2bl76Rh7pGwf8Ps/sXG+6oNOi6lwychzJRmMDTCW8hU=";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    // E5.1 Wave H (D-162): project-wide, not a per-test test.use() - nginx-e2e now terminates real TLS for
    // files-e2e.test/dl.mosni.dev with a self-signed cert (never trusted outside this tier), and EVERY spec
    // that navigates a real page through it needs this now, not just the one file (e2e/browse.spec.ts) that
    // used to need it for a different reason (loading the real ui.mosni.dev design system through the
    // sandbox's own proxy). Real production terminates a real, CA-issued cert; this never applies there.
    ignoreHTTPSErrors: true,
    // ⚠ LOAD-BEARING, found only by executing (E5.1 Wave H): `ignoreHTTPSErrors` above is NOT sufficient
    // for a page to register a service worker over this self-signed cert - Chromium enforces a STRICTER,
    // separate certificate check specifically for the service-worker script fetch, which `ignoreHTTPSErrors`
    // does not relax. Measured directly: without this flag, `navigator.serviceWorker.register()` rejects
    // with `SecurityError: ... An unknown error occurred when fetching the script.`, even though an
    // ordinary page navigation to the exact same origin succeeds fine. `--ignore-certificate-errors-spki-list`
    // pins the ONE cert this tier actually serves (by its public key hash, not the cert bytes, so
    // re-issuing the cert from the SAME fixed key never invalidates this) and is the documented Chromium
    // mechanism for exactly this case. This is what closes E5-ARCHIVE-E2E for real - without it, "Download
    // all" never gets past `isArchiveSupported()`/registration in this tier, the same structural gap H1's
    // TLS fix alone does not close.
    launchOptions: {
      args: [`--ignore-certificate-errors-spki-list=${SW_CERT_SPKI}`],
    },
  },
});
