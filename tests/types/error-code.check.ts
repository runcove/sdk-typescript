// CoveAPIError.code is the generated closed ErrorCode union, widened by `string & {}` so a code this
// SDK does not know yet still parses (the union is for narrowing and completion, not validation).
import type { CoveAPIError } from "../../src/errors.js";
const c: CoveAPIError["code"] = "vm_name_taken";
void c;
const unknownStillParses: CoveAPIError["code"] = "a_code_this_sdk_does_not_know";
void unknownStillParses;
// @ts-expect-error a number is not an error code
const n: CoveAPIError["code"] = 42;
void n;
