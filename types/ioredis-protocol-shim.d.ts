// TEMPORARY SHIM — remove once the @open-mercato platform develop builds ≥ 6940 clear their
// npm quarantine and this repo repins off the interim 6931 pin.
//
// Why this exists: @open-mercato/shared@0.6.8-develop.6931 ships
// `src/lib/ratelimit/service.ts`, which passes a `protocol` option to ioredis'
// `new Redis(url, { ... })`. ioredis 5.x's `RedisOptions` (= `CommonRedisOptions & ...`)
// does not declare `protocol`, so the platform source fails to typecheck under our toolchain.
// Platform build 6940 fixes this at source, but 6940–6950 are npm-quarantined and uninstallable,
// so we are pinned to the newest installable build (6931) and bridge the single type gap here.
// When we repin to 6940+, delete this file and its `files` entry in tsconfig.base.json.
import 'ioredis'

declare module 'ioredis' {
  interface CommonRedisOptions {
    protocol?: unknown
  }
}
