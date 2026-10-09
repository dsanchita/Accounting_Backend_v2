import ApiResponse from "../../../utils/ApiResponse.js";
import AppError from "../../../utils/AppError.js";
import { createAuditLog } from "../../../utils/createAuditLog.js";
import { getTrialBalance, getTrialBalanceForPeriod, validateTrialBalance, getTrialBalanceSummary } from "../services/trialBalanceService.js";
import { getLedgerReport, getGeneralLedger, getPartyWiseLedger, getLedgerWithFilters } from "../services/ledgerReportService.js";
import { getBalanceSheet, getProfitAndLoss, getFinancialStatements } from "../services/financialStatementService.js";

/**
 * Report Controller
 * Handles all reporting endpoints for the accounting module
 * Includes ledger, trial balance, balance sheet, and P&L reports
 */

/**
 * Get ledger report for a single account
 * GET /api/accounting/report/:companyId/ledger?accountId=xxx&startDate=xxx&endDate=xxx
 */
export const getLedgerReportHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { accountId, startDate, endDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getLedgerReportHandler");
    }

    if (!accountId) {
      throw new AppError("Account ID is required", 400, "getLedgerReportHandler");
    }

    if (!startDate || !endDate) {
      throw new AppError("Start date and end date are required", 400, "getLedgerReportHandler");
    }

    const report = await getLedgerReport(accountId, companyId, new Date(startDate), new Date(endDate));

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "LEDGER_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { accountId, startDate, endDate },
      description: `Ledger report viewed for account ${accountId}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: report,
      message: "Ledger report generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get general ledger (all accounts)
 * GET /api/accounting/report/:companyId/general-ledger?startDate=xxx&endDate=xxx&groupBy=scheduleHead
 */
export const getGeneralLedgerHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { startDate, endDate, groupName, scheduleLineItem } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getGeneralLedgerHandler");
    }

    if (!startDate || !endDate) {
      throw new AppError("Start date and end date are required", 400, "getGeneralLedgerHandler");
    }

    let ledgers;

    if (groupName || scheduleLineItem) {
      ledgers = await getLedgerWithFilters({
        companyId,
        groupName,
        scheduleLineItem,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    } else {
      // Get all accounts for company
      const Account = await require("../models/Account.js").getAccountModel();
      const accounts = await Account.find({ companyId, isActive: true }).lean();
      const accountIds = accounts.map((a) => a._id.toString());
      ledgers = await getGeneralLedger(accountIds, companyId, new Date(startDate), new Date(endDate));
    }

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "GENERAL_LEDGER_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { startDate, endDate, count: ledgers.length },
      description: `General ledger report viewed (${ledgers.length} accounts)`,
    });

    new ApiResponse({
      statusCode: 200,
      data: {
        ledgers,
        totalAccounts: ledgers.length,
      },
      message: "General ledger report generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get trial balance
 * GET /api/accounting/report/:companyId/trial-balance?asOfDate=xxx
 */
export const getTrialBalanceHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { asOfDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getTrialBalanceHandler");
    }

    if (!asOfDate) {
      throw new AppError("As of date is required", 400, "getTrialBalanceHandler");
    }

    const report = await getTrialBalance(companyId, new Date(asOfDate), {
      groupByScheduleHead: true,
      includeZeroBalance: false,
    });

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "TRIAL_BALANCE_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { asOfDate },
      description: `Trial balance report viewed as of ${asOfDate}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: report,
      message: "Trial balance report generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get trial balance for a period
 * GET /api/accounting/report/:companyId/trial-balance-period?startDate=xxx&endDate=xxx
 */
export const getTrialBalancePeriodHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { startDate, endDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getTrialBalancePeriodHandler");
    }

    if (!startDate || !endDate) {
      throw new AppError("Start date and end date are required", 400, "getTrialBalancePeriodHandler");
    }

    const report = await getTrialBalanceForPeriod(companyId, new Date(startDate), new Date(endDate));

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "TRIAL_BALANCE_PERIOD_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { startDate, endDate },
      description: `Trial balance for period ${startDate} to ${endDate} viewed`,
    });

    new ApiResponse({
      statusCode: 200,
      data: report,
      message: "Trial balance for period generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Validate trial balance (check if debits = credits)
 * GET /api/accounting/report/:companyId/validate-trial-balance?asOfDate=xxx
 */
export const validateTrialBalanceHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { asOfDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "validateTrialBalanceHandler");
    }

    if (!asOfDate) {
      throw new AppError("As of date is required", 400, "validateTrialBalanceHandler");
    }

    const validation = await validateTrialBalance(companyId, new Date(asOfDate));

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "VALIDATE_TRIAL_BALANCE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { asOfDate, isValid: validation.isValid },
      description: `Trial balance validation performed as of ${asOfDate}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: validation,
      message: validation.isValid ? "Trial balance is valid (balanced)" : "Trial balance is NOT valid (unbalanced)",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get balance sheet
 * GET /api/accounting/report/:companyId/balance-sheet?asOfDate=xxx&periodStartDate=xxx
 */
export const getBalanceSheetHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { asOfDate, periodStartDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getBalanceSheetHandler");
    }

    if (!asOfDate) {
      throw new AppError("As of date is required", 400, "getBalanceSheetHandler");
    }

    const report = await getBalanceSheet(companyId, new Date(asOfDate), {
      ...(periodStartDate ? { periodStartDate: new Date(periodStartDate) } : {}),
    });

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "BALANCE_SHEET_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { asOfDate, periodStartDate },
      description: `Balance sheet generated as of ${asOfDate}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: report,
      message: "Balance sheet generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get profit & loss statement
 * GET /api/accounting/report/:companyId/profit-loss?startDate=xxx&endDate=xxx
 */
export const getProfitAndLossHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { startDate, endDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getProfitAndLossHandler");
    }

    if (!startDate || !endDate) {
      throw new AppError("Start date and end date are required", 400, "getProfitAndLossHandler");
    }

    const report = await getProfitAndLoss(companyId, new Date(startDate), new Date(endDate));

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "PROFIT_LOSS_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { startDate, endDate },
      description: `P&L statement generated for period ${startDate} to ${endDate}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: report,
      message: "Profit & loss statement generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get comprehensive financial statements
 * GET /api/accounting/report/:companyId/financial-statements?statementDate=xxx
 */
export const getFinancialStatementsHandler = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { statementDate } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "getFinancialStatementsHandler");
    }

    if (!statementDate) {
      throw new AppError("Statement date is required", 400, "getFinancialStatementsHandler");
    }

    const reports = await getFinancialStatements(companyId, new Date(statementDate));

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Report",
      action: "FINANCIAL_STATEMENTS_VIEW",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { statementDate },
      description: `Comprehensive financial statements generated as of ${statementDate}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: reports,
      message: "Financial statements generated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export default {
  getLedgerReportHandler,
  getGeneralLedgerHandler,
  getTrialBalanceHandler,
  getTrialBalancePeriodHandler,
  validateTrialBalanceHandler,
  getBalanceSheetHandler,
  getProfitAndLossHandler,
  getFinancialStatementsHandler,
};
