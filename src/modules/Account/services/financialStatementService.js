import AppError from "../../../utils/AppError.js";
import { getTrialBalance, getTrialBalanceForPeriod } from "./trialBalanceService.js";
import {
  getScheduleMappingForLineItem,
  SCHEDULE_III_CONFIG,
} from "../utils/scheduleIIIConfig.js";

export const getFinancialYearStartDate = (date) => {
  const asOfDate = new Date(date);
  const year = asOfDate.getUTCFullYear();
  const financialYearStartYear =
    asOfDate.getUTCMonth() < 3 ? year - 1 : year;

  return new Date(Date.UTC(financialYearStartYear, 3, 1));
};

export const calculateNetProfit = (totalRevenue, totalExpenses) =>
  totalRevenue - totalExpenses;

export const addProfitLossToReserves = (equityGroups, netProfit) => {
  if (!Number.isFinite(netProfit)) {
    throw new AppError("Net profit or loss must be a finite number", 500, "addProfitLossToReserves");
  }

  if (netProfit === 0) return 0;

  const groupName = "Shareholders' Funds";
  const lineItemName = "Reserves and Surplus";
  const group = equityGroups[groupName] || { total: 0, items: [], lineItems: {} };
  const lineItem = group.lineItems[lineItemName] || { total: 0, items: [] };
  const adjustment = {
    label: "Profit / (Loss) for the period",
    groupName,
    scheduleLineItem: lineItemName,
    amount: netProfit,
  };

  lineItem.total += netProfit;
  lineItem.items.push(adjustment);
  group.lineItems[lineItemName] = lineItem;
  group.total += netProfit;
  group.items.push(adjustment);
  equityGroups[groupName] = group;

  return netProfit;
};

export const findUnmappedScheduleAccounts = (accounts) =>
  accounts
    .filter((account) => {
      const expectedMapping = getScheduleMappingForLineItem(
        account.groupNature,
        account.scheduleLineItem
      );

      return (
        !expectedMapping ||
        account.scheduleMainHead !== expectedMapping.scheduleMainHead ||
        account.scheduleGroup !== expectedMapping.scheduleGroup
      );
    })
    .map((account) => ({
      accountId: account.accountId,
      accountCode: account.accountCode,
      accountName: account.accountName,
      groupName: account.groupName,
      groupNature: account.groupNature,
    }));

export const calculateBalanceSheetTotals = (assets, liabilities, equity) => {
  const totalAssets = assets.reduce((sum, account) => sum + account.amount, 0);
  const totalLiabilities = liabilities.reduce((sum, account) => sum + account.amount, 0);
  const totalEquity = equity.reduce((sum, account) => sum + account.amount, 0);
  const totalEquityAndLiabilities = totalLiabilities + totalEquity;
  const difference = totalAssets - totalEquityAndLiabilities;

  return {
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalEquityAndLiabilities,
    difference,
    isBalanced: Math.abs(difference) < 0.01,
  };
};

/**
 * Financial Statement Service
 * Generates Profit & Loss (P&L) and Balance Sheet from Trial Balance
 * Both reports are derived by applying Schedule III mapping to trial balance accounts
 */

/**
 * Build Balance Sheet from trial balance
 * Groups accounts into Assets, Liabilities, and Equity sections
 * @param {string} companyId - Company ID
 * @param {Date} asOfDate - Date for balance sheet
 * @param {Object} options - Report options
 * @returns {Promise<Object>} Balance sheet with assets, liability, equity sections
 */
export const getBalanceSheet = async (companyId, asOfDate, options = {}) => {
  const { includeComparativePeriod = false, priorYearDate = null } = options;

  if (!companyId) {
    throw new AppError("Company ID is required", 400, "getBalanceSheet");
  }

  const periodStartDate = options.periodStartDate
    ? new Date(options.periodStartDate)
    : getFinancialYearStartDate(asOfDate);
  const profitAndLossPromise =
    options.profitAndLoss ||
    getProfitAndLoss(companyId, periodStartDate, new Date(asOfDate));

  const [trialBalance, profitAndLoss] = await Promise.all([
    getTrialBalance(companyId, asOfDate, {
      groupByScheduleHead: true,
      includeZeroBalance: true,
    }),
    profitAndLossPromise,
  ]);
  const mappingIssues = findUnmappedScheduleAccounts(trialBalance.accounts);

  // Filter and group accounts by sheet section
  const assets = [];
  const liabilities = [];
  const equity = [];

  for (const account of trialBalance.accounts) {
    if (
      !account.scheduleMainHead ||
      !account.scheduleGroup ||
      !account.scheduleLineItem
    ) {
      continue;
    }

    const accountLine = {
      accountId: account.accountId,
      code: account.accountCode,
      name: account.accountName,
      groupName: account.groupName,
      normalBalance: account.normalBalance,
      openingBalance: account.openingBalance || 0,
      linkedClientId: account.linkedClientId,
      linkedVendorId: account.linkedVendorId,
      linkedPartyType: account.linkedPartyType,
      partyName: account.partyName,
      scheduleGroup: account.scheduleGroup,
      scheduleLineItem: account.scheduleLineItem,
      amount: account.closingDebit || account.closingCredit || 0,
    };

    switch (account.scheduleMainHead) {
      case "Assets":
        assets.push(accountLine);
        break;
      case "Equity and Liabilities":
        if (account.groupNature === "Equity") {
          equity.push(accountLine);
        } else {
          liabilities.push(accountLine);
        }
        break;
      default:
        break;
    }
  }

  // Aggregate by schedule group and line item
  const groupAssets = {};
  const groupLiabilities = {};
  const groupEquity = {};

  // Initialize all standard groups and line items from config
  const initializeSections = (nature, target) => {
    const config = SCHEDULE_III_CONFIG[nature];
    if (!config) return;
    for (const [groupName, lineItems] of Object.entries(config.groups)) {
      target[groupName] = { total: 0, items: [], lineItems: {} };
      for (const lineItem of lineItems) {
        target[groupName].lineItems[lineItem] = { total: 0, items: [] };
      }
    }
  };

  initializeSections("Asset", groupAssets);
  initializeSections("Liability", groupLiabilities);
  initializeSections("Equity", groupEquity);

  for (const asset of assets) {
    const group = asset.scheduleGroup || "Other Current Assets";
    const lineItem = asset.scheduleLineItem || "Other Current Assets";
    
    if (!groupAssets[group]) groupAssets[group] = { total: 0, items: [], lineItems: {} };
    if (!groupAssets[group].lineItems[lineItem]) groupAssets[group].lineItems[lineItem] = { total: 0, items: [] };
    
    groupAssets[group].items.push(asset);
    groupAssets[group].total += asset.amount;
    groupAssets[group].lineItems[lineItem].items.push(asset);
    groupAssets[group].lineItems[lineItem].total += asset.amount;
  }

  for (const liability of liabilities) {
    const group = liability.scheduleGroup || "Other Current Liabilities";
    const lineItem = liability.scheduleLineItem || "Other Current Liabilities";

    if (!groupLiabilities[group]) groupLiabilities[group] = { total: 0, items: [], lineItems: {} };
    if (!groupLiabilities[group].lineItems[lineItem]) groupLiabilities[group].lineItems[lineItem] = { total: 0, items: [] };

    groupLiabilities[group].items.push(liability);
    groupLiabilities[group].total += liability.amount;
    groupLiabilities[group].lineItems[lineItem].items.push(liability);
    groupLiabilities[group].lineItems[lineItem].total += liability.amount;
  }

  for (const eq of equity) {
    const group = eq.scheduleGroup || "Shareholders' Funds";
    const lineItem = eq.scheduleLineItem || "Reserves and Surplus";

    if (!groupEquity[group]) groupEquity[group] = { total: 0, items: [], lineItems: {} };
    if (!groupEquity[group].lineItems[lineItem]) groupEquity[group].lineItems[lineItem] = { total: 0, items: [] };

    groupEquity[group].items.push(eq);
    groupEquity[group].total += eq.amount;
    groupEquity[group].lineItems[lineItem].items.push(eq);
    groupEquity[group].lineItems[lineItem].total += eq.amount;
  }

  const profitTransferredToReserves = addProfitLossToReserves(
    groupEquity,
    profitAndLoss.profitAndLoss.netProfitBeforeTax
  );

  const totals = calculateBalanceSheetTotals(assets, liabilities, [
    ...equity,
    { amount: profitTransferredToReserves },
  ]);

  const balanceSheet = {
    companyId,
    asOfDate,
    profitTransferredToReserves,
    assets: {
      current: groupAssets["Current Assets"] || { items: [], total: 0 },
      nonCurrent: groupAssets["Non-Current Assets"] || { items: [], total: 0 },
      total: totals.totalAssets,
    },
    liabilitiesAndEquity: {
      equity: {
        shareholders: groupEquity["Shareholders' Funds"] || { items: [], total: 0 },
        other: groupEquity["Other"] || { items: [], total: 0 },
        total: totals.totalEquity,
      },
      liabilities: {
        current: groupLiabilities["Current Liabilities"] || { items: [], total: 0 },
        nonCurrent: groupLiabilities["Non-Current Liabilities"] || { items: [], total: 0 },
        total: totals.totalLiabilities,
      },
      total: totals.totalEquityAndLiabilities,
    },
    validation: {
      assetsEqualLiabilitiesPlusEquity: totals.isBalanced,
      difference: totals.difference,
      mappingIssues,
    },
  };

  // Add comparative period if requested
  if (includeComparativePeriod && priorYearDate) {
    const priorBalance = await getBalanceSheet(companyId, new Date(priorYearDate), { includeComparativePeriod: false });
    balanceSheet.priorYear = {
      asOfDate: priorYearDate,
      assets: priorBalance.assets,
      liabilitiesAndEquity: priorBalance.liabilitiesAndEquity,
    };
  }

  return balanceSheet;
};

/**
 * Build Profit & Loss statement from trial balance
 * Shows income and expenses for a period
 * @param {string} companyId - Company ID
 * @param {Date} startDate - Period start
 * @param {Date} endDate - Period end
 * @param {Object} options - Report options
 * @returns {Promise<Object>} P&L statement with income, expense, and profit sections
 */
export const getProfitAndLoss = async (companyId, startDate, endDate, options = {}) => {
  const { includeComparativePeriod = false, priorStartDate = null, priorEndDate = null } = options;

  if (!companyId || !startDate || !endDate) {
    throw new AppError("Company ID, start date, and end date are required", 400, "getProfitAndLoss");
  }

  // Get trial balance for the period
  const tb = await getTrialBalanceForPeriod(companyId, startDate, endDate, {
    groupByScheduleHead: true,
    includeZeroBalance: true,
  });

  // Filter P&L accounts. Nature is the primary section classifier;
  // schedule fields only determine grouping inside that section.
  const revenue = [];
  const expenses = [];

  for (const account of tb.accounts) {
    if (!["Income", "Expense"].includes(account.groupNature)) continue;

    const accountLine = {
      accountId: account.accountId,
      code: account.accountCode,
      name: account.accountName,
      groupName: account.groupName,
      normalBalance: account.normalBalance,
      openingBalance: account.openingBalance || 0,
      linkedClientId: account.linkedClientId,
      linkedVendorId: account.linkedVendorId,
      linkedPartyType: account.linkedPartyType,
      partyName: account.partyName,
      groupNature: account.groupNature,
      scheduleGroup: account.scheduleGroup,
      scheduleLineItem: account.scheduleLineItem,
      amount: account.periodDebit || account.periodCredit || 0,
      debit: account.periodDebit || 0,
      credit: account.periodCredit || 0,
    };

    if (account.groupNature === "Income") {
      accountLine.amount = account.periodCredit || 0;
      revenue.push(accountLine);
    } else if (account.groupNature === "Expense") {
      accountLine.amount = account.periodDebit || 0;
      expenses.push(accountLine);
    }
  }

  // Aggregate by schedule line item
  const groupRevenue = {};
  const groupExpenses = {};
  const revenueByScheduleGroup = {};
  const expensesByScheduleGroup = {};

  // Initialize standard line items
  for (const item of SCHEDULE_III_CONFIG.Income.groups.Revenue) {
    groupRevenue[item] = [];
  }
  for (const item of SCHEDULE_III_CONFIG.Expense.groups.Expenses) {
    groupExpenses[item] = [];
  }

  for (const rev of revenue) {
    const scheduleGroup = rev.scheduleGroup || "Revenue";
    const lineItem = rev.scheduleLineItem || "Other Income";
    if (!groupRevenue[lineItem]) {
      groupRevenue[lineItem] = [];
    }
    groupRevenue[lineItem].push(rev);
    if (!revenueByScheduleGroup[scheduleGroup]) {
      revenueByScheduleGroup[scheduleGroup] = { total: 0, lineItems: {} };
    }
    if (!revenueByScheduleGroup[scheduleGroup].lineItems[lineItem]) {
      revenueByScheduleGroup[scheduleGroup].lineItems[lineItem] = { total: 0, items: [] };
    }
    revenueByScheduleGroup[scheduleGroup].total += rev.amount;
    revenueByScheduleGroup[scheduleGroup].lineItems[lineItem].total += rev.amount;
    revenueByScheduleGroup[scheduleGroup].lineItems[lineItem].items.push(rev);
  }

  for (const exp of expenses) {
    const scheduleGroup = exp.scheduleGroup || "Expenses";
    const lineItem = exp.scheduleLineItem || "Other Expenses";
    if (!groupExpenses[lineItem]) {
      groupExpenses[lineItem] = [];
    }
    groupExpenses[lineItem].push(exp);
    if (!expensesByScheduleGroup[scheduleGroup]) {
      expensesByScheduleGroup[scheduleGroup] = { total: 0, lineItems: {} };
    }
    if (!expensesByScheduleGroup[scheduleGroup].lineItems[lineItem]) {
      expensesByScheduleGroup[scheduleGroup].lineItems[lineItem] = { total: 0, items: [] };
    }
    expensesByScheduleGroup[scheduleGroup].total += exp.amount;
    expensesByScheduleGroup[scheduleGroup].lineItems[lineItem].total += exp.amount;
    expensesByScheduleGroup[scheduleGroup].lineItems[lineItem].items.push(exp);
  }

  // Calculate totals
  const totalRevenue = revenue.reduce((sum, r) => sum + r.amount, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const netProfit = calculateNetProfit(totalRevenue, totalExpenses);

  const pnl = {
    companyId,
    period: {
      startDate,
      endDate,
    },
    revenue: {
      groups: revenueByScheduleGroup,
      lineItems: groupRevenue,
      total: totalRevenue,
    },
    expenses: {
      groups: expensesByScheduleGroup,
      lineItems: groupExpenses,
      total: totalExpenses,
    },
    profitAndLoss: {
      grossProfit: totalRevenue, // Can be enhanced with COGS logic
      operatingExpense: totalExpenses - (totalExpenses * 0.8), // Estimate
      netProfitBeforeTax: netProfit,
      profitAfterTax: netProfit * 0.75, // Estimated with 25% tax
    },
  };

  // Add comparative period if requested
  if (includeComparativePeriod && priorStartDate && priorEndDate) {
    const priorPnL = await getProfitAndLoss(companyId, new Date(priorStartDate), new Date(priorEndDate), {
      includeComparativePeriod: false,
    });
    pnl.priorPeriod = priorPnL;
  }

  return pnl;
};

/**
 * Get comprehensive financial statements
 * Combined Balance Sheet + P&L + Key metrics
 * @param {string} companyId - Company ID
 * @param {Date} statementDate - Statement date
 * @returns {Promise<Object>} Comprehensive financial statement
 */
export const getFinancialStatements = async (companyId, statementDate) => {
  const asOfDate = new Date(statementDate);
  const periodStart = getFinancialYearStartDate(asOfDate);

  const profitAndLossPromise = getProfitAndLoss(companyId, periodStart, asOfDate);
  const [balanceSheet, profitAndLoss] = await Promise.all([
    getBalanceSheet(companyId, asOfDate, {
      periodStartDate: periodStart,
      profitAndLoss: profitAndLossPromise,
    }),
    profitAndLossPromise,
  ]);

  // Calculate key financial ratios
  const totalAssets = balanceSheet.assets.total;
  const totalEquity = balanceSheet.liabilitiesAndEquity.equity.total;
  const totalLiabilities = balanceSheet.liabilitiesAndEquity.liabilities.total;
  const netProfit = profitAndLoss.profitAndLoss.netProfitBeforeTax;
  const totalRevenue = profitAndLoss.revenue.total;

  const ratios = {
    debtToEquity: totalEquity > 0 ? totalLiabilities / totalEquity : 0,
    returnOnAssets: totalAssets > 0 ? netProfit / totalAssets : 0,
    returnOnEquity: totalEquity > 0 ? netProfit / totalEquity : 0,
    profitMargin: totalRevenue > 0 ? netProfit / totalRevenue : 0,
    assetTurnover: totalAssets > 0 ? totalRevenue / totalAssets : 0,
  };

  return {
    companyId,
    statementDate: asOfDate,
    balanceSheet,
    profitAndLoss,
    ratios,
    notes: {
      preparedDate: new Date(),
      currency: "INR",
      standard: "Schedule III - Indian Company Law",
    },
  };
};

export default {
  getBalanceSheet,
  getProfitAndLoss,
  getFinancialStatements,
};
