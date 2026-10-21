# Architecture decisions

Short records of the choices that shape the system, with the alternatives that were rejected and why. Chronological order is not important; each record stands alone.

## 1. Two services split along a consistency boundary, not along entities

**Decision.** `collateral-service` owns the customer's money held as a guarantee. `lending-service` owns the credit line (limit usage, debt, interest, statements, late fees). Each has its own database. Lending depends on collateral; collateral never calls lending.

**Why.** The invariant "a purchase can never exceed the available credit" must be checked and applied in one ACID transaction over the card balance. Authorizations, payments, reversals, interest and fees all change that same balance, so they stay together in `lending`. The guarantee, by contrast, has its own lifecycle (bank confirmations, release, application), its own external integrations (banks) and a different risk profile (custody of customer money, not credit extended to the customer). It also tolerates eventual consistency well: a confirmed deposit becomes spendable credit a moment later.

**Rejected.** One service (simplest, but the guarantee would stay welded to the credit product, which is exactly what must change when the product stops being secured). Five services, one per entity (cards, authorizations, repayments, ledger, collateral): every purchase would become a distributed transaction.

**Consequence.** The limit is an external variable for `lending`. Today it comes from collateral (held amount times a ratio); an unsecured product only needs another source behind the same port.

## 2. Credit semantics, not debit semantics

Spending never reduces the guarantee; it grows a debt. Paying reduces the debt and restores available credit. The guarantee only moves at closure (released or applied to the debt). That is why custody and the card account are separate books: `available = min(limit, own cap) - debt`.

## 3. Append-only journal, derived balances

Every money movement is a signed-direction row (`DEBIT`/`CREDIT`) with a bucket (`PRINCIPAL`, `INTEREST`, `FEES`, `DEFERRED`). Balances on the account row are updated in the same transaction and are checked by `CHECK` constraints (never negative). Database triggers reject `UPDATE`/`DELETE` on journal and audit tables. Tests assert that balances always equal the sum of the journal, including a property-based test over random operation sequences.

**Rejected.** Full double-entry across the two services: it only makes sense inside one database, and each service already has a self-balancing journal.

## 4. Money is integer minor units

`BIGINT` in PostgreSQL, `bigint` in domain code, safe-integer validation at the API boundary, no floating point anywhere. Interest uses integer arithmetic with round-half-even (`sum of daily balances * APR / (10000 * 365)`).

## 5. Concurrency: row lock around a short transaction

Authorization locks the account row (`SELECT ... FOR UPDATE`), checks status and available credit, inserts the movement and updates the balance, all in one short transaction. Optimistic retries were rejected: under contention on a single card they waste work. External calls (limit lookup) happen before the transaction, never while holding the lock. Tests fire dozens of concurrent purchases at one card and assert the exact number approved and that the limit is never exceeded.

## 6. Idempotency in the same transaction as the effect

Every money-moving endpoint requires `Idempotency-Key`. The key row (scope, owner, key, request hash, stored response) is inserted in the same transaction as the operation. A concurrent duplicate blocks on the unique index until the first commits and then replays the stored response; the same key with a different body gets `422`. Bank webhooks use `(bank, event id)` as the key.

## 7. Limit lookup: shared cache with versions, plus events

The limit is read from Redis (shared by all tasks, survives restarts). On a miss or expiry it is fetched from custody over HTTP. Writes are compare-and-set on a version, so duplicated or out-of-order updates are harmless. Custody publishes `custody.limit-changed` (only `accountId` and `version`) through a transactional outbox to SNS, delivered to an SQS queue with a dead-letter queue; lending acknowledges the message only after Redis has the new value. TTL (12h) is the safety net if an event is lost. If custody is unreachable and the cache has expired, the behaviour is configurable (`deny` or `use_stale` with a maximum age); the default is `deny`.

**Rejected.** Pushing the limit into the lending database as a snapshot (couples the schema to a value it does not own), calling custody on every purchase (availability coupling and extra latency on the hot path), API destinations/webhooks for internal events (exposed endpoint, weaker authentication), Lambda consumers (extra artifact and VPC wiring), RabbitMQ (cost and operations on AWS), EventBridge as the bus (not needed today; the consumer would not change if adopted later).

## 8. Reducing a limit needs a safety cap

When the customer lowers the limit, lending writes its own cap in the same transaction that validates the debt, then asks custody to release the collateral. The cap is kept until a safety margin (`LIMIT_CAP_RELEASE_SECONDS`) has passed after Redis was updated. A concurrency test found that dropping the cap immediately lets an authorization that read the old limit just before the update be approved above the new limit; the margin closes that window.

## 9. Closure is a retryable command, not a saga

Lending marks the account `CLOSING` (no purchases, no payments), computes the debt and sends custody one idempotent command (`settle`, key `close:<account>`). Custody applies `min(debt, held)` and releases the rest in one transaction. If the call fails the account stays `CLOSING` and a job retries with the same key. There is nothing to compensate because the command only moves forward. Any shortfall is recorded in the audit log.

## 10. Billing lives inside lending

Statements, interest and fees are movements on the same journal and need a deterministic snapshot of it at the cut. Separating them would turn the cut into a distributed read plus idempotent writes against a balance that authorizations update concurrently. The module boundary is strict (billing only uses the public interface of accounts) so it can be extracted or run as its own scheduled task later.

Rules implemented: cut on day 1 or 15 chosen by the customer; interest on the average daily balance of principal only (no interest on interest or fees); statements are immutable and carry a snapshot of the terms used; minimum payment = max(floor, percentage), capped at the balance; late fee charged once per statement when the minimum is not paid by the due date; payments apply to fees, then interest, then principal; automatic closure after N days past due, applying the collateral.

## 11. Ports and adapters at the edges

Messaging, cache, custody client, bank adapters, token verification and product terms are abstract classes with adapters (SNS/SQS, Redis, HTTP, simulated bank, JWT/JWKS, static terms) and in-memory versions for tests. Swapping SNS/SQS for Kafka or RabbitMQ, or the static terms for a product service, is a new adapter. Prisma and PostgreSQL are deliberately not wrapped.

## 12. Identity is somebody else's problem, authorization is local

Services only verify signed JWTs (public key or JWKS) and build a `CurrentUser`. Customers can only touch accounts whose `ownerId` equals their subject (otherwise `404`, to avoid leaking existence). Service-to-service calls and the card network use service tokens with explicit scopes. Banks are authenticated by an asymmetric signature over the raw body plus a timestamp, with a per-deposit unguessable reference.

## 13. Prisma per service, pnpm monorepo

One schema, one migration history and one generated client per database, never shared. SQL that Prisma cannot express (`CHECK`, partial unique indexes, immutability triggers) lives in the migrations. pnpm for strict dependency resolution and `pnpm deploy`. No Turborepo or task runner yet: `pnpm -r` orders builds, and a task runner earns its place when CI time hurts.

## 14. Deployment

ECS Fargate behind an ALB (public, with WAF) and an internal ALB for service-to-service traffic, one RDS instance per service, ElastiCache Redis, SNS/SQS with alarms, EventBridge Scheduler running the daily jobs as a task, migrations as one-off tasks. See `terraform/`.

## Known limitations

- Deferred purchases (installments) are designed but not implemented; the `DEFERRED` bucket already exists in the model.
- Only the asymmetric bank signature scheme is implemented; HMAC for banks that need it is designed.
- Service tokens come from a local key; the production issuer is an open decision.
- Interest uses UTC dates; per-product time zones are not modelled.
- Reversing a purchase that was already paid is rejected (no credit balances or refunds).
- Terms are static; versions are stored per account and per statement so a product service can replace them.
