-- DropIndex
DROP INDEX "movements_account_id_created_at_idx";

-- AlterTable
ALTER TABLE "movements" ADD COLUMN     "effective_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "billing_profiles" (
    "account_id" UUID NOT NULL,
    "next_cut_date" DATE NOT NULL,
    "last_cut_date" DATE,
    "cycle_number" INTEGER NOT NULL DEFAULT 0,
    "delinquent_since" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "statements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "cycle_number" INTEGER NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "opening_balance" BIGINT NOT NULL,
    "purchases" BIGINT NOT NULL,
    "reversals" BIGINT NOT NULL,
    "payments" BIGINT NOT NULL,
    "interest_charged" BIGINT NOT NULL,
    "fees_charged" BIGINT NOT NULL,
    "closing_balance" BIGINT NOT NULL,
    "minimum_payment" BIGINT NOT NULL,
    "terms_version" INTEGER NOT NULL,
    "terms_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_outcomes" (
    "statement_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_outcomes_pkey" PRIMARY KEY ("statement_id")
);

-- CreateIndex
CREATE INDEX "billing_profiles_next_cut_date_idx" ON "billing_profiles"("next_cut_date");

-- CreateIndex
CREATE INDEX "statements_due_date_idx" ON "statements"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "statements_account_id_cycle_number_key" ON "statements"("account_id", "cycle_number");

-- CreateIndex
CREATE INDEX "movements_account_id_effective_at_idx" ON "movements"("account_id", "effective_at");

-- AddForeignKey
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statements" ADD CONSTRAINT "statements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_outcomes" ADD CONSTRAINT "statement_outcomes_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_cycle_number_nonnegative" CHECK ("cycle_number" >= 0);
ALTER TABLE "statements" ADD CONSTRAINT "statements_balance_identity" CHECK (
  "closing_balance" = "opening_balance" + "purchases" + "interest_charged" + "fees_charged" - "reversals" - "payments"
);
ALTER TABLE "statements" ADD CONSTRAINT "statements_minimum_within_balance" CHECK ("minimum_payment" >= 0 AND "minimum_payment" <= "closing_balance");
ALTER TABLE "statement_outcomes" ADD CONSTRAINT "statement_outcomes_valid" CHECK ("outcome" IN ('PAID', 'LATE'));

CREATE UNIQUE INDEX "movements_single_late_fee" ON "movements" ("statement_id") WHERE "type" = 'LATE_FEE';
CREATE UNIQUE INDEX "movements_single_interest" ON "movements" ("statement_id") WHERE "type" = 'INTEREST';

CREATE TRIGGER "statements_immutable" BEFORE UPDATE OR DELETE ON "statements"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
