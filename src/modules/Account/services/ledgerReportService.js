import AppError from "../../../utils/AppError.js";
import { getAccountModel } from "../models/Account.js";
import { getJournalLineModel } from "../models/JournalLine.js";
import { getBankLedgerTransactionModel } from "../models/BankLedgerTransaction.js";
import {
  sumJournalLineAmounts,
} from "../utils/balanceComputation.util.js";

/**
 * Ledger Report Service
 * Provides detailed transaction history and running balance for an account
 * Shows opening balance, each transaction, and closing balance
 */

/**
 * Get ledger report for a single account
 * @param {string} accountId - The account ID to report on
 * @param {string} companyId - Company context
 * @param {Date} startDate - Report period start (for transaction filtering)
 * @param {Date} endDate - Report period end (for transaction filtering)
 * @param {Object} options - Report options
 * @returns {Promise<Object>} Ledger report with account info and transactions
 */
export const getLedgerReport = async (accountId, companyId, startDate, endDate, options = {}) => {
  const {
    reverseOrder = false, // Show oldest to newest (default) or newest to oldest
    includePertyDetails = false,
  } = options;

  if (!accountId || !companyId) {
    throw new AppError("Account ID and Company ID are required", 400, "getLedgerReport");
  }

  // Get account master
  const Account = await getAccountModel();
  const account = await Account.findById(accountId).lean();

  if (!account) {
    throw new AppError("Account not found", 404, "getLedgerReport");
  }

  if (account.companyId.toString() !== companyId) {
    throw new AppError("Account does not belong to this company", 403, "getLedgerReport");
  }

  const JournalLine = await getJournalLineModel();
  const BankLedgerTransaction = await getBankLedgerTransactionModel();
  const journalLines = await JournalLine.find({
    accountId,
    companyId,
  })
    .populate({
      path: "journalId",
      select: "number date narration sourceType referenceNumber partyName externalDocNo createdAt voucherType status approvalStatus",
    })
    .lean();

  const bankLedgerTransactions = (account.groupName || "").toUpperCase().includes("BANK")
    ? await BankLedgerTransaction.find({
        companyId,
        bankLedgerId: accountId,
      }).lean()
    : [];
  const bankLedgerTxByJournalLineId = new Map(
    bankLedgerTransactions.map((tx) => [String(tx.journalLineId), tx])
  );

  let openingBalance = account.openingBalance || 0;
  const filteredLines = [];
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if (end) end.setHours(23, 59, 59, 999);

  for (const line of journalLines) {
    if (!line.journalId) continue;
    const journalDate = new Date(line.journalId.date || line.createdAt);
    if (Number.isNaN(journalDate.getTime())) continue;

    if (start && journalDate < start) {
      // Add to true opening balance
      const debit = line.debitAmount || 0;
      const credit = line.creditAmount || 0;
      if (account.openingType === "Debit") {
        openingBalance += debit - credit;
      } else {
        openingBalance += credit - debit;
      }
    } else {
      if (end && journalDate > end) continue;
      filteredLines.push(line);
    }
  }

  const sortedLines = filteredLines.sort(
    (a, b) => new Date(a.journalId?.date || a.createdAt) - new Date(b.journalId?.date || b.createdAt)
  );

  if (reverseOrder) {
    sortedLines.reverse();
  }

  // Build ledger transactions with running balance
  let runningBalance = openingBalance;
  const transactions = [];

  for (const line of sortedLines) {
    const debit = line.debitAmount || 0;
    const credit = line.creditAmount || 0;

    // Compute running balance based on account's normal balance
    if (`${account.openingType}`.toLowerCase() === "debit") {
      runningBalance += debit - credit;
    } else {
      runningBalance += credit - debit;
    }

    const rawJournalDate = line.journalId?.date || line.createdAt;
    const createdAtTime = line.journalId?.createdAt || line.createdAt;
    let effectiveJournalDate = rawJournalDate;
    if (rawJournalDate && createdAtTime) {
      const dJournal = new Date(rawJournalDate);
      const dCreated = new Date(createdAtTime);
      if (dJournal > dCreated && dJournal > new Date()) {
        effectiveJournalDate = createdAtTime;
      }
    }

    transactions.push({
      journalDate: effectiveJournalDate,
      originalJournalDate: rawJournalDate,
      voucherType: line.journalId?.voucherType,
      journalNumber: line.journalId?.number,
      reference: line.journalId?.externalDocNo || line.journalId?.referenceNumber || "",
      narration: line.journalId?.narration || line.description || "",
      debit: debit > 0 ? debit : 0,
      credit: credit > 0 ? credit : 0,
      runningBalance,
      sourceType: line.journalId?.sourceType || "MANUAL",
      referenceNumber: line.journalId?.referenceNumber || line.journalId?.number || "",
      partyName: line.journalId?.partyName || "",
      externalDocNo: line.journalId?.externalDocNo || "",
      createdAt: line.journalId?.createdAt || line.createdAt,
      reconciliationStatus: bankLedgerTxByJournalLineId.get(String(line._id))?.reconciliationStatus || "UNMATCHED",
      isReconciled: Boolean(bankLedgerTxByJournalLineId.get(String(line._id))?.isReconciled),
      allocatedAmount: Number(bankLedgerTxByJournalLineId.get(String(line._id))?.allocatedAmount || 0),
      unreconciledAmount: Math.max(
        0,
        Math.abs(debit || credit) - Number(bankLedgerTxByJournalLineId.get(String(line._id))?.allocatedAmount || 0)
      ),
    });
  }

  // Compute account totals for the CURRENT period view
  const { totalDebit, totalCredit } = sumJournalLineAmounts(filteredLines, "debitAmount", "creditAmount");

  const closingBalance = account.openingType === "Debit"
    ? openingBalance + (totalDebit - totalCredit)
    : openingBalance + (totalCredit - totalDebit);

  const report = {
    account: {
      accountId: account._id,
      accountCode: account.code,
      accountName: account.name,
      groupName: account.groupName,
      nature: "Asset", // Would need to join group to get this properly
      normalBalance: `${account.openingType}`.toLowerCase() === "credit" ? "Credit" : "Debit",
    },
    period: {
      startDate,
      endDate,
    },
    summary: {
      openingBalance: openingBalance,
      totalDebit,
      totalCredit,
      closingBalance,
    },
    transactions,
    transactionCount: transactions.length,
  };

  if (includePertyDetails && (account.linkedClientId || account.linkedVendorId)) {
    report.party = {
      type: account.linkedPartyType,
      name: account.partyName,
      code: account.partyCode,
      linkedId: account.linkedClientId || account.linkedVendorId,
    };
  }

  return report;
};

/**
 * Get ledger for multiple accounts
 * Used for general ledger reports
 * @param {Array<string>} accountIds - Array of account IDs
 * @param {string} companyId - Company context
 * @param {Date} startDate - Report period start
 * @param {Date} endDate - Report period end
 * @returns {Promise<Array>} Array of ledger reports
 */
export const getGeneralLedger = async (accountIds = [], companyId, startDate, endDate) => {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new AppError("Account IDs array is required", 400, "getGeneralLedger");
  }

  const ledgers = [];

  for (const accountId of accountIds) {
    try {
      const ledger = await getLedgerReport(accountId, companyId, startDate, endDate);
      ledgers.push(ledger);
    } catch (error) {
      console.error(`Error generating ledger for account ${accountId}:`, error.message);
      // Continue with next account
    }
  }

  return ledgers;
};

/**
 * Get party-wise ledger (client or vendor specific)
 * Shows all transactions for a specific client or vendor across their linked accounts
 * @param {string} partyId - Client or Vendor ID
 * @param {string} partyType - "client" or "vendor"
 * @param {string} companyId - Company context
 * @param {Date} startDate - Report period start
 * @param {Date} endDate - Report period end
 * @returns {Promise<Array>} Ledger for all accounts linked to this party
 */
export const getPartyWiseLedger = async (partyId, partyType, companyId, startDate, endDate) => {
  const Account = await getAccountModel();

  const query = { companyId };
  if (partyType === "client") {
    query.linkedClientId = partyId;
  } else if (partyType === "vendor") {
    query.linkedVendorId = partyId;
  } else {
    throw new AppError("Invalid party type. Use 'client' or 'vendor'", 400, "getPartyWiseLedger");
  }

  const accounts = await Account.find(query).lean();

  if (accounts.length === 0) {
    throw new AppError("No accounts found for this party", 404, "getPartyWiseLedger");
  }

  const ledgers = [];
  for (const account of accounts) {
    const ledger = await getLedgerReport(account._id, companyId, startDate, endDate);
    ledgers.push(ledger);
  }

  return ledgers;
};

/**
 * Get ledger with filter options
 * Advanced ledger query with multiple filters
 * @param {Object} filters - Filter criteria
 * @param {string} filters.accountId - Account ID
 * @param {string} filters.companyId - Company ID
 * @param {string} filters.groupName - Group name filter
 * @param {string} filters.scheduleLineItem - Schedule line item filter
 * @param {Date} filters.startDate - Period start
 * @param {Date} filters.endDate - Period end
 * @returns {Promise<Array>} Filtered ledger reports
 */
export const getLedgerWithFilters = async (filters) => {
  const { accountId, companyId, groupName, scheduleLineItem, startDate, endDate } = filters;

  if (!companyId) {
    throw new AppError("Company ID is required", 400, "getLedgerWithFilters");
  }

  const Account = await getAccountModel();
  const query = { companyId };

  if (accountId) {
    query._id = accountId;
  }
  if (groupName) {
    query.groupName = groupName;
  }
  if (scheduleLineItem) {
    query["scheduleMapping.scheduleLineItem"] = scheduleLineItem;
  }

  const accounts = await Account.find(query).lean();

  if (accounts.length === 0) {
    return [];
  }

  const ledgers = [];
  for (const account of accounts) {
    try {
      const ledger = await getLedgerReport(account._id, companyId, startDate, endDate);
      ledgers.push(ledger);
    } catch (error) {
      console.error(`Error generating ledger for account ${account._id}:`, error.message);
    }
  }

  return ledgers;
};

export default {
  getLedgerReport,
  getGeneralLedger,
  getPartyWiseLedger,
  getLedgerWithFilters,
};
