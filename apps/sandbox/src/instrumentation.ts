export async function register(): Promise<void> {
  // no-op: dev warmup is handled by the dev runner splash flow.
  // (Local KSeF TEST-API mocking is done via the NODE_OPTIONS --import preload
  // apps/sandbox/scripts/ksef-mock-preload.mjs, gated by OM_KSEF_MOCK.)
}
