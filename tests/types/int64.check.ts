// By design, int64 is `number`. hey-api's types-only plugin emits `number` unless @hey-api/transformers
// (bigInt defaults to true) is enabled; generate.mjs leaves it out. A re-pin that changes this fails here.
import type { ReservationRef } from "../../src/generated/types.gen.js";
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const memoryMbIsNumber: Equals<ReservationRef["memory_mb"], number> = true;
void memoryMbIsNumber;
