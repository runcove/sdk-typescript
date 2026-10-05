// The admin and service key fields reach the public types by regeneration, under their wire names
// (no translation layer). A contract change that drops or renames one fails to compile here.
import type { CreatedKey, CreateKeyRequest, KeySummary, ListApiKeysParams } from "../../src/index.js";
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const adminKey: Equals<CreateKeyRequest["admin_key"], boolean | null | undefined> = true;
const service: Equals<CreateKeyRequest["service"], string | null | undefined> = true;
const member: Equals<CreateKeyRequest["member"], string | null | undefined> = true;
const team: Equals<CreateKeyRequest["team"], string | null | undefined> = true;
const createdAdmin: Equals<CreatedKey["admin_key"], boolean | null | undefined> = true;
const summaryAdmin: Equals<KeySummary["admin_key"], boolean | null | undefined> = true;
const boundTeam: Equals<KeySummary["bound_team"], string | null | undefined> = true;
const boundMember: Equals<KeySummary["bound_member"], string | null | undefined> = true;
const listService: Equals<ListApiKeysParams["service"], boolean | undefined> = true;

// A service key request and an admin key request both type-check as written in the README.
const svc: CreateKeyRequest = { label: "svc", service: "deployer", team: "platform", expires_in_secs: 86400 };
const adm: CreateKeyRequest = { label: "ci", scopes: ["admin:vms:read"], admin_key: true, expires_in_secs: 86400 };

void [adminKey, service, member, team, createdAdmin, summaryAdmin, boundTeam, boundMember, listService, svc, adm];
