import type { AccountType, Direction } from '../../common/database/schema';

/**
 * Standard lending chart of accounts, created per institution and per supported currency at
 * registration. Codes follow the usual numbering convention: 1xxx assets, 4xxx income,
 * 5xxx expenses. Every posting rule in the ledger module refers to these codes.
 */
export const ACCOUNT = {
  CASH: '1000',
  LOAN_PRINCIPAL_RECEIVABLE: '1100',
  INTEREST_RECEIVABLE: '1110',
  FEE_RECEIVABLE: '1120',
  PENALTY_RECEIVABLE: '1130',
  INTEREST_INCOME: '4000',
  FEE_INCOME: '4100',
  PENALTY_INCOME: '4200',
  CREDIT_LOSS_EXPENSE: '5000',
} as const;

export type AccountCode = (typeof ACCOUNT)[keyof typeof ACCOUNT];

export const CHART_OF_ACCOUNTS: readonly {
  code: AccountCode;
  name: string;
  type: AccountType;
  normalBalance: Direction;
}[] = [
  { code: ACCOUNT.CASH, name: 'Settlement / Cash', type: 'ASSET', normalBalance: 'DEBIT' },
  {
    code: ACCOUNT.LOAN_PRINCIPAL_RECEIVABLE,
    name: 'Loan Principal Receivable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT.INTEREST_RECEIVABLE,
    name: 'Interest Receivable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
  },
  { code: ACCOUNT.FEE_RECEIVABLE, name: 'Fee Receivable', type: 'ASSET', normalBalance: 'DEBIT' },
  {
    code: ACCOUNT.PENALTY_RECEIVABLE,
    name: 'Penalty Receivable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT.INTEREST_INCOME,
    name: 'Interest Income',
    type: 'INCOME',
    normalBalance: 'CREDIT',
  },
  { code: ACCOUNT.FEE_INCOME, name: 'Fee Income', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: ACCOUNT.PENALTY_INCOME, name: 'Penalty Income', type: 'INCOME', normalBalance: 'CREDIT' },
  {
    code: ACCOUNT.CREDIT_LOSS_EXPENSE,
    name: 'Credit Loss Expense',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
];
