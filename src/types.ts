/**
 * The public type surface: every schema in `sdk/openapi.yaml`
 * `components.schemas`, generated (`generated/schemas.gen.ts`), plus the
 * hand-written ergonomic types that are not schemas (`ergonomic.ts`). The few
 * schemas `scripts/schema-barrel-exclusions.mjs` leaves out of the generated
 * list are exported from `ergonomic.ts` in corrected form instead.
 *
 * Exactly two star re-exports and no named ones, on purpose: TypeScript fails
 * the build (TS2308) when two `export *` lines export the same name, so an
 * ergonomic type named like a schema cannot slip in; a named export beside a
 * star would instead shadow the schema silently. `tests/barrel.test.mjs` pins
 * this shape. Wire field names stay snake_case, exactly as on the wire.
 */

export * from "./generated/schemas.gen.js";
export * from "./ergonomic.js";
