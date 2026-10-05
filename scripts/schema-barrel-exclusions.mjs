// The components.schemas names that generate.mjs leaves OUT of the public schema barrel
// (src/generated/schemas.gen.ts), each with the reason. Read by generate.mjs and by
// tests/barrel.test.mjs, so the barrel and its test agree on one list.
//
// A schema belongs here only when its generated type would let an SDK caller build a request the
// server refuses. src/ergonomic.ts then exports a corrected type under the same name (so the public
// name still exists and `types.ts`'s two star re-exports cannot collide on it). generate.mjs fails if a
// name here is no longer a schema, so a stale entry cannot linger.
export const SCHEMA_BARREL_EXCLUSIONS = Object.freeze({
  // `selector` stays in the contract only so the server can recognise and refuse it: since API
  // version 5 a plain exec carrying it gets a 400 (sdk/openapi.yaml, ExecRequestDto.selector). The
  // generator drops that description, so the generated type would advertise the field as usable.
  ExecRequestDto: 'the server refuses `selector` on plain exec (400); the public type omits it',
});
