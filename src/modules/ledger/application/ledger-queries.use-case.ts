import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { AccountType, Direction, JournalKind } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { assertCurrency } from '../../../common/money/currency';
import { normalBalance } from '../domain/journal';

export interface PostingView {
  accountCode: string;
  accountName: string;
  direction: Direction;
  amount: string;
}

export interface JournalEntryView {
  id: string;
  kind: JournalKind;
  effectiveDate: string;
  description: string;
  idempotencyRef: string;
  reversesEntryId: string | null;
  createdAt: string;
  postings: PostingView[];
}

export interface AccountBalanceView {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: Direction;
  debits: string;
  credits: string;
  /** Net balance in the account's normal direction. */
  balance: string;
}

export interface LoanLedgerView {
  loanId: string;
  currency: string;
  entries: JournalEntryView[];
  /** Per-account totals of this loan's postings only. */
  balances: AccountBalanceView[];
}

export interface TrialBalanceView {
  currency: string;
  accounts: AccountBalanceView[];
  totalDebits: string;
  totalCredits: string;
  /** Double-entry proof: Σ debits = Σ credits over every account. */
  balanced: boolean;
}

interface AccountTotalsRow {
  code: string;
  name: string;
  type: AccountType;
  normal_balance: Direction;
  debits: bigint;
  credits: bigint;
}

function toBalanceView(row: AccountTotalsRow): AccountBalanceView {
  return {
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
    debits: row.debits.toString(),
    credits: row.credits.toString(),
    balance: normalBalance(row.normal_balance, row.debits, row.credits).toString(),
  };
}

// SUM over bigint is numeric in Postgres; cast back so the driver yields a JS bigint.
const debitSum = sql<bigint>`COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0)::bigint`;
const creditSum = sql<bigint>`COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0)::bigint`;

/**
 * Tie-break for entries posted in the same transaction (identical `created_at`): an accrual or
 * fee is recognised before the repayment that settles it. Deterministic, unlike the uuid.
 */
const KIND_ORDER = sql<number>`CASE kind
  WHEN 'DISBURSEMENT' THEN 0 WHEN 'INTEREST_ACCRUAL' THEN 1 WHEN 'LATE_FEE' THEN 2
  WHEN 'REVERSAL' THEN 3 WHEN 'REPAYMENT' THEN 4 ELSE 5 END`;

/**
 * Journal of one loan: every entry that references it with its postings, in business order
 * (effective date, then insertion time; entries of one transaction share `created_at`, so
 * recognition is listed before settlement via {@link KIND_ORDER}), plus per-account totals.
 * Staff only (`ledger:read`); another tenant's loan is a 404 (RLS).
 */
@Injectable()
export class GetLoanLedger {
  constructor(private readonly runner: TransactionRunner) {}

  execute(loanId: string): Promise<LoanLedgerView> {
    return this.runner.run(async (tx) => {
      const loan = await tx
        .selectFrom('loans')
        .select(['id', 'currency'])
        .where('id', '=', loanId)
        .executeTakeFirst();
      if (!loan) throw new NotFoundError('Loan', loanId);

      const entries = await tx
        .selectFrom('journal_entries')
        .selectAll()
        .where('loan_id', '=', loanId)
        .orderBy('effective_date', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy(KIND_ORDER, 'asc')
        .orderBy('id', 'asc')
        .execute();
      const postings =
        entries.length === 0
          ? []
          : await tx
              .selectFrom('postings as p')
              .innerJoin('ledger_accounts as a', 'a.id', 'p.account_id')
              .select(['p.journal_entry_id', 'a.code', 'a.name', 'p.direction', 'p.amount'])
              .where(
                'p.journal_entry_id',
                'in',
                entries.map((e) => e.id),
              )
              .orderBy('p.direction', 'desc')
              .orderBy('a.code', 'asc')
              .execute();
      const balances = await tx
        .selectFrom('postings as p')
        .innerJoin('journal_entries as je', 'je.id', 'p.journal_entry_id')
        .innerJoin('ledger_accounts as a', 'a.id', 'p.account_id')
        .select(['a.code', 'a.name', 'a.type', 'a.normal_balance'])
        .select([debitSum.as('debits'), creditSum.as('credits')])
        .where('je.loan_id', '=', loanId)
        .groupBy(['a.code', 'a.name', 'a.type', 'a.normal_balance'])
        .orderBy('a.code')
        .execute();

      return {
        loanId: loan.id,
        currency: loan.currency,
        entries: entries.map((e) => ({
          id: e.id,
          kind: e.kind,
          effectiveDate: e.effective_date,
          description: e.description,
          idempotencyRef: e.idempotency_ref,
          reversesEntryId: e.reverses_entry_id,
          createdAt: e.created_at.toISOString(),
          postings: postings
            .filter((p) => p.journal_entry_id === e.id)
            .map((p) => ({
              accountCode: p.code,
              accountName: p.name,
              direction: p.direction,
              amount: p.amount.toString(),
            })),
        })),
        balances: balances.map(toBalanceView),
      };
    });
  }
}

/**
 * Trial balance of the caller's institution in one currency (default: the institution's
 * default currency): debit and credit totals and the normal-direction balance of every account
 * of the chart, with the double-entry proof Σ debits = Σ credits.
 */
@Injectable()
export class GetTrialBalance {
  constructor(private readonly runner: TransactionRunner) {}

  execute(currencyParam?: string): Promise<TrialBalanceView> {
    return this.runner.run(async (tx) => {
      const currency =
        currencyParam !== undefined
          ? assertCurrency(currencyParam)
          : (
              await tx
                .selectFrom('institutions')
                .select('default_currency')
                .executeTakeFirstOrThrow()
            ).default_currency;

      const rows = await tx
        .selectFrom('ledger_accounts as a')
        .leftJoin('postings as p', 'p.account_id', 'a.id')
        .select(['a.code', 'a.name', 'a.type', 'a.normal_balance'])
        .select([debitSum.as('debits'), creditSum.as('credits')])
        .where('a.currency', '=', currency)
        .groupBy(['a.code', 'a.name', 'a.type', 'a.normal_balance'])
        .orderBy('a.code')
        .execute();

      const totalDebits = rows.reduce((acc, r) => acc + r.debits, 0n);
      const totalCredits = rows.reduce((acc, r) => acc + r.credits, 0n);
      return {
        currency,
        accounts: rows.map(toBalanceView),
        totalDebits: totalDebits.toString(),
        totalCredits: totalCredits.toString(),
        balanced: totalDebits === totalCredits,
      };
    });
  }
}
