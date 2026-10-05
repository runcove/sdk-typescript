// The contract declares these enum-valued query parameters as plain `string`, and the server ignores a
// value it cannot parse (an unfiltered answer, not an error), so the ergonomic bags keep the closed
// unions: a misspelt or unknown value must be a compile error.
import type {
  ListVmsParams,
  ListWebhookDeliveriesParams,
  ListWebhooksParams,
} from "../../src/ergonomic.js";
const vms: ListVmsParams = { state: "running", tag: ["env=prod", "team=a"] };
void vms;
// @ts-expect-error "Running" (wrong case) is not a VmState
const misspeltState: ListVmsParams = { state: "Running" };
void misspeltState;
// @ts-expect-error "vms" is not a webhook scope
const misspeltScope: ListWebhooksParams = { scope: "vms" };
void misspeltScope;
// @ts-expect-error "succeeded" is not a DeliveryState
const misspeltDelivery: ListWebhookDeliveriesParams = { state: "succeeded" };
void misspeltDelivery;
