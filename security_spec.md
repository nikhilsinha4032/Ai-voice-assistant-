# Meridian Voice Firestore Security Specification

## 1. Data Invariants
1. **Strict Tenant Isolation**: Every document lives under `/users/{userId}/...` and MUST satisfy `request.auth != null`, `request.auth.token.email_verified == true`, `request.auth.uid == userId`, and `data.ownerId == request.auth.uid`.
2. **Path Variable & ID Integrity**: All document ID path parameters (`docId`, `ticketId`, `turnId`, `ruleId`, `platform`) and stored `id` fields must pass `isValidId()` (`^[a-zA-Z0-9_\-]+$`, max 128 chars).
3. **Immutable Ownership & Temporal Integrity**: `ownerId` and `createdAt` cannot be modified on update. Every `create` requires `createdAt == request.time` and `updatedAt == request.time`; every `update` requires `updatedAt == request.time`.
4. **No Shadow Fields**: Every collection strictly enforces `data.keys().hasAll(...)` and `data.keys().hasOnly(...)` on write, plus `affectedKeys().hasOnly(...)` per action on update.
5. **Volumetric Limits**: Every string field enforces `.size()` limits matching `firebase-blueprint.json`; every list (`tags`, `intents`, `autoTags`) is strictly bounded in size and checks element type.
6. **Terminal State Locking**: Once a `CrmTicket` reaches `status == 'Resolved'`, client updates to that ticket are denied.
7. **Query Enforcement**: Every `allow list` rule enforces `existing().ownerId == request.auth.uid` on the resource itself, never delegating security solely to the client.

## 2. The "Dirty Dozen" Attack Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated Read/Write**: Read or write `/users/uidA/tickets/tkt-101` with `request.auth == null`.
2. **Unverified Email Spoofing**: Write `/users/uidA/private/profile` where `request.auth.uid == 'uidA'` and `request.auth.token.email_verified == false`.
3. **Cross-Tenant PII Read**: Authenticated `uidB` attempts `get` on `/users/uidA/private/profile`.
4. **Cross-Tenant Query List**: Authenticated `uidB` attempts `list` on `/users/uidA/tickets`.
5. **OwnerId Spoofing on Create**: Authenticated `uidA` creates `/users/uidA/tickets/tkt-999` with `ownerId: 'uidB'`.
6. **Shadow Field Injection**: Authenticated `uidA` creates `/users/uidA/private/profile` with extra ghost field `isAdmin: true`.
7. **Timestamp Forgery on Create**: Authenticated `uidA` creates `/users/uidA/turns/turn-1` with client-supplied `createdAt: Timestamp(2020-01-01)` instead of `request.time`.
8. **CreatedAt Mutation on Update**: Authenticated `uidA` updates `/users/uidA/tickets/tkt-101` changing `createdAt`.
9. **Path ID Poisoning**: Authenticated `uidA` creates `/users/uidA/tickets/tkt$invalid!id` with non-alphanumeric ID or >128 chars.
10. **Terminal State Mutation**: Authenticated `uidA` attempts to reopen `/users/uidA/tickets/tkt-104` where `existing().status == 'Resolved'`.
11. **Oversized String / Resource Exhaustion**: Authenticated `uidA` writes a `TranscriptTurn` with `text` > 4000 characters or `tags` > 25 items.
12. **Type Poisoning on Whitelisted Update Key**: Authenticated `uidA` updates `/users/uidA/rules/rule-outage-p1` with `enabled: "true"` (string instead of boolean) or `assignPriority: "P0"` (invalid enum).
