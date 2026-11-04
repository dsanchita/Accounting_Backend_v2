import crypto from "crypto";
import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";
import { getAccountModel } from "../models/Account.js";
import { getGroupModel } from "../models/Group.js";
import { getJournalModel } from "../models/Journal.js";
import { getJournalLineModel } from "../models/JournalLine.js";
import { getHrmsIntegrationConfigModel } from "../models/HrmsIntegrationConfig.js";
import { getHrmsIntegrationEventModel } from "../models/HrmsIntegrationEvent.js";
import {
  getEmployeePayableModel,
  getEmployeeSettlementModel,
} from "../models/EmployeePayable.js";
import {
  assertJournalBalanced,
  reconcilePayrollEmployee,
  toMinorUnits,
} from "../services/hrmsIntegrationRules.js";

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const getPayloadHash = (body) =>
  crypto.createHash("sha256").update(stableStringify(body)).digest("hex");

const integrationError = (message, statusCode = 422, code = "VALIDATION_FAILED") =>
  Object.assign(new Error(message), { statusCode, code });

const accountById = async (Account, id, companyId, label, expectedNature) => {
  const account = await Account.findOne({ _id: id, companyId, isActive: true })
    .populate("groupId")
    .lean();
  if (!account) throw integrationError(`${label} is missing, inactive, or belongs to another company`);
  if (expectedNature && account.groupId?.nature !== expectedNature) {
    const article = expectedNature === "Asset" || expectedNature === "Expense" ? "an" : "a";
    throw integrationError(`${label} must belong to ${article} ${expectedNature} account group`, 422, "INVALID_ACCOUNT_NATURE");
  }
  return account;
};

const makeLine = (account, { debit = 0, credit = 0, description, employee, sourceReference, paymentReference }) => ({
  accountId: account._id,
  accountCode: account.code,
  accountName: account.name,
  companyId: String(account.companyId),
  debitAmount: debit / 100,
  creditAmount: credit / 100,
  description,
  paymentReference: paymentReference || employee?.paymentId || employee?.payment_uid || "",
  paymentId: employee?.paymentId || employee?.payment_uid || "",
  employeeId: employee?.employeeId || null,
  employeeCode: employee?.employeeCode || "",
  employeeName: employee?.employeeName || "",
  employeeDepartment: employee?.department || employee?.employeeDepartment || "",
  employeeDesignation: employee?.designation || employee?.employeeDesignation || "",
  employeeEmail: employee?.officialEmail || employee?.employeeEmail || "",
  employeePan: employee?.pan || employee?.employeePan || "",
  sourceReference: sourceReference || "",
});

const assertDateOpen = (config, date) => {
  const postingDate = new Date(date);
  if (!Number.isFinite(postingDate.getTime())) throw integrationError("A valid accounting date is required");
  if (config.closedThroughDate && postingDate <= new Date(config.closedThroughDate)) {
    throw integrationError("The accounting date falls in a closed period", 422, "CLOSED_PERIOD");
  }
  return postingDate;
};

const reserveEvent = async ({ body, eventType, companyId, sourceId }) => {
  const Event = await getHrmsIntegrationEventModel();
  const payloadHash = getPayloadHash(body);
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + 2 * 60 * 1000);
  try {
    const [event] = await Event.create([
      {
        eventId: body.eventId,
        eventType,
        payloadHash,
        companyId,
        sourceId,
        status: "PROCESSING",
        lockedUntil: leaseExpiry,
      },
    ]);
    return { event, acquired: true, payloadHash };
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const existing = await Event.findOne({
    $or: [
      { eventId: body.eventId },
      { companyId, eventType, sourceId: String(sourceId) },
    ],
  });
  if (!existing) throw integrationError("Could not reserve the integration event", 503, "EVENT_RESERVATION_FAILED");
  if (existing.eventId !== body.eventId) {
    throw integrationError(
      `This HRMS source was already submitted as event ${existing.eventId}`,
      409,
      "SOURCE_ALREADY_SUBMITTED"
    );
  }
  if (existing.payloadHash !== payloadHash) {
    throw integrationError("Event ID was already used with a different payload", 409, "IDEMPOTENCY_CONFLICT");
  }
  if (existing.status === "POSTED") return { event: existing, acquired: false, payloadHash };
  if (existing.status === "PROCESSING" && existing.lockedUntil > now) {
    return { event: existing, acquired: false, payloadHash };
  }

  const claimed = await Event.findOneAndUpdate(
    {
      _id: existing._id,
      payloadHash,
      $or: [
        { status: { $in: ["REJECTED", "FAILED"] } },
        { status: "PROCESSING", lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: "PROCESSING", lockedUntil: leaseExpiry, errorCode: null, errorMessage: null },
      $inc: { attemptCount: 1 },
    },
    { new: true }
  );
  return { event: claimed || existing, acquired: Boolean(claimed), payloadHash };
};

const persistJournal = async ({ event, payload, config, lines, payables, date, narration, sourceType }) => {
  const db = getDatabase("accounting");
  const Journal = await getJournalModel();
  const JournalLine = await getJournalLineModel();
  const Payable = await getEmployeePayableModel();
  const Event = await getHrmsIntegrationEventModel();
  const session = await db.startSession();
  const journalId = new mongoose.Types.ObjectId();
  const journalNumber = `HRMS-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  let createdJournal;
  try {
    await session.withTransaction(async () => {
      assertJournalBalanced(lines);
      const debitTotal = lines.reduce((sum, line) => sum + line.debitAmount, 0);
      const creditTotal = lines.reduce((sum, line) => sum + line.creditAmount, 0);
      const [journal] = await Journal.create(
        [
          {
            _id: journalId,
            number: journalNumber,
            voucherType: sourceType === "HRMS_PAYROLL" ? "JOURNAL" : "JOURNAL",
            date,
            referenceNumber: event.eventId,
            externalDocNo: payload.source.payrollRunId || payload.source.claimId,
            narration,
            companyId: config.companyId,
            sourceType,
            sourceId: event.eventId,
            totalDebit: debitTotal,
            totalCredit: creditTotal,
            status: "Draft",
            approvalStatus: "Pending",
            createdBy: "HRMS Integration",
          },
        ],
        { session }
      );
      const lineDocs = lines.map((line, index) => ({
        ...line,
        journalId: journal._id,
        lineNumber: index + 1,
      }));
      const savedLines = await JournalLine.insertMany(lineDocs, { session });
      const payableDocs = payables.map((item) => ({
        ...item.data,
        companyId: config.companyId,
        currency: config.currency,
        journalId: journal._id,
        journalLineId: savedLines[item.lineIndex]._id,
      }));
      if (payableDocs.length) await Payable.insertMany(payableDocs, { session });

      journal.status = "Posted";
      journal.approvalStatus = "Approved";
      journal.approvedBy = "HRMS Integration";
      journal.approvalDate = new Date();
      await journal.save({ session });
      const eventUpdate = await Event.updateOne(
        { _id: event._id, status: "PROCESSING" },
        {
          $set: {
            status: "POSTED",
            journalId: journal._id,
            lockedUntil: null,
            errorCode: null,
            errorMessage: null,
          },
        },
        { session }
      );
      if (eventUpdate.matchedCount !== 1) {
        throw integrationError("Integration event is no longer owned by this posting attempt", 409, "EVENT_LOCK_LOST");
      }
      createdJournal = journal;
    });
    return createdJournal;
  } finally {
    await session.endSession();
  }
};

const getActiveConfig = async () => {
  const Config = await getHrmsIntegrationConfigModel();
  const config = await Config.findOne({ key: "HRMS", isActive: true }).lean();
  if (!config) throw integrationError("HRMS accounting mappings are not configured", 503, "MAPPING_NOT_CONFIGURED");
  return config;
};

const markEventFailure = async (eventId, error) => {
  const Event = await getHrmsIntegrationEventModel();
  const status = error.statusCode && error.statusCode < 500 ? "REJECTED" : "FAILED";
  await Event.updateOne(
    { eventId, status: "PROCESSING" },
    {
      $set: {
        status,
        errorCode: error.code || "POSTING_FAILED",
        errorMessage: error.message,
        lockedUntil: null,
      },
    }
  );
};

const createAccrual = async (req, res, next, eventType) => {
  const body = req.body;
  if (!body?.eventId || typeof body.eventId !== "string" || body.eventId.length > 128) {
    return res.status(400).json({ success: false, message: "A stable eventId is required" });
  }
  try {
    const config = await getActiveConfig();
    const sourceId = eventType === "PAYROLL_ACCRUAL" ? body?.source?.payrollRunId : body?.source?.claimId;
    if (!sourceId) throw integrationError("A stable HRMS source ID is required");
    if (String(body.currency || "").toUpperCase() !== config.currency) {
      throw integrationError(`Unsupported currency. Expected ${config.currency}`, 422, "CURRENCY_MISMATCH");
    }
    if (body.accountingCompanyId && String(body.accountingCompanyId) !== String(config.companyId)) {
      throw integrationError("Caller cannot choose the Accounting company", 403, "COMPANY_SCOPE_DENIED");
    }

    const { event, acquired } = await reserveEvent({
      body,
      eventType,
      companyId: config.companyId,
      sourceId: String(sourceId),
    });
    if (!acquired) {
      if (event.status === "POSTED") {
        return res.status(200).json({
          success: true,
          status: event.status,
          eventId: event.eventId,
          journalId: event.journalId,
          message: "This event was already posted",
        });
      }
      return res.status(event.status === "REJECTED" ? 422 : 202).json({
        success: false,
        status: event.status,
        eventId: event.eventId,
        code: event.errorCode,
        message: event.errorMessage || "Event is already being processed",
      });
    }

    try {
      const Account = await getAccountModel();
      const lines = [];
      const payables = [];
      let postingDate;
      let narration;
      let sourceType;

      if (eventType === "PAYROLL_ACCRUAL") {
        const month = Number(body.period?.month);
        const year = Number(body.period?.year);
        if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
          throw integrationError("Payroll period must include a 1-based month and year");
        }
        const monthEnd = new Date(Date.UTC(year, month, 0));
        const now = new Date();
        const rawDate = body.date || body.postingDate || body.accrualDate || (monthEnd > now ? now : monthEnd);
        postingDate = assertDateOpen(config, rawDate);
        const employees = body.employees;
        if (!Array.isArray(employees) || employees.length === 0) {
          throw integrationError("Payroll must contain at least one employee");
        }

        const mapping = config.payroll;
        const salaryExpense = await accountById(Account, mapping?.salaryExpenseAccountId, config.companyId, "Salary expense account", "Expense");
        const outstandingSalary = await accountById(Account, mapping?.outstandingSalaryAccountId, config.companyId, "Outstanding Salary account", "Liability");
        const deductionMappings = new Map(
          (mapping?.deductions || []).map((item) => [item.key, item])
        );
        if (deductionMappings.size !== (mapping?.deductions || []).length) {
          throw integrationError("Payroll deduction mapping keys must be unique", 422, "INVALID_MAPPING");
        }
        const deductionAccounts = new Map();
        const benefitMap = {
          epf: {
            expense: await accountById(Account, mapping?.benefits?.epfExpenseAccountId, config.companyId, "Employer EPF expense account", "Expense"),
            payable: await accountById(Account, mapping?.benefits?.epfPayableAccountId, config.companyId, "Employer EPF payable account", "Liability"),
          },
          mediclaim: {
            expense: await accountById(Account, mapping?.benefits?.mediclaimExpenseAccountId, config.companyId, "Mediclaim expense account", "Expense"),
            payable: await accountById(Account, mapping?.benefits?.mediclaimPayableAccountId, config.companyId, "Mediclaim payable account", "Liability"),
          },
          gratuity: {
            expense: await accountById(Account, mapping?.benefits?.gratuityExpenseAccountId, config.companyId, "Gratuity expense account", "Expense"),
            payable: await accountById(Account, mapping?.benefits?.gratuityPayableAccountId, config.companyId, "Gratuity payable account", "Liability"),
          },
        };

        const grossTotal = employees.reduce((sum, employee) => sum + toMinorUnits(employee.grossSalaryMinorUnits, "Gross salary"), 0);
        const deductionTotals = new Map();
        const benefitTotals = { epf: 0, mediclaim: 0, gratuity: 0 };
        let netTotal = 0;
        for (const employee of employees) {
          if (!employee.employeeId || !employee.employeeName) throw integrationError("Each employee requires an ID and name");
          const { gross, net, deductions } = reconcilePayrollEmployee(employee);
          netTotal += net;
          for (const [key, amount] of deductions) {
            if (!amount) continue;
            const mappingEntry = deductionMappings.get(key);
            if (!mappingEntry) {
              throw integrationError(`Payroll deduction "${key}" has no configured liability account`, 422, "DEDUCTION_MAPPING_MISSING");
            }
            if (!deductionAccounts.has(key)) {
              deductionAccounts.set(
                key,
                await accountById(Account, mappingEntry.accountId, config.companyId, `${mappingEntry.label} payable account`, "Liability")
              );
            }
            deductionTotals.set(key, (deductionTotals.get(key) || 0) + amount);
          }
          const employeeBenefits = {
            epf: toMinorUnits(employee.employerBenefitsMinorUnits?.epf || 0, "Employer EPF"),
            mediclaim: toMinorUnits(employee.employerBenefitsMinorUnits?.mediclaim || 0, "Mediclaim"),
            gratuity: toMinorUnits(employee.employerBenefitsMinorUnits?.gratuity || 0, "Gratuity"),
          };
          Object.keys(employeeBenefits).forEach((key) => (benefitTotals[key] += employeeBenefits[key]));
          if (net > 0) {
            const lineIndex = lines.length;
            const pmtIdStr = employee.paymentId ? ` [Payment ID: ${employee.paymentId}]` : "";
            const deptStr = employee.department ? ` [Dept: ${employee.department}]` : "";
            lines.push(makeLine(outstandingSalary, {
              credit: net,
              description: `Payroll ${year}-${String(month).padStart(2, "0")} payable — ${employee.employeeName} (${employee.employeeCode || "N/A"})${pmtIdStr}${deptStr}`,
              employee,
              paymentReference: employee.paymentId || "",
              sourceReference: sourceId,
            }));
            payables.push({
              lineIndex,
              data: {
                accountId: outstandingSalary._id,
                sourceType: "PAYROLL",
                sourceId: String(sourceId),
                employeeId: String(employee.employeeId),
                employeeCode: employee.employeeCode || "",
                employeeName: employee.employeeName,
                employeeDepartment: employee.department || "",
                employeeDesignation: employee.designation || "",
                employeeEmail: employee.officialEmail || employee.email || "",
                employeePan: employee.pan || "",
                paymentId: employee.paymentId || "",
                originalAmountMinorUnits: net,
              },
            });
          }
        }
        lines.unshift(makeLine(salaryExpense, { debit: grossTotal, description: `Gross payroll expense ${year}-${String(month).padStart(2, "0")}` }));
        payables.forEach((item) => {
          item.lineIndex += 1;
        });
        for (const [key, amount] of deductionTotals) {
          const label = deductionMappings.get(key)?.label || key;
          lines.push(makeLine(deductionAccounts.get(key), { credit: amount, description: `${label} payable` }));
        }
        Object.entries(benefitTotals).forEach(([key, amount]) => {
          if (!amount) return;
          const entry = benefitMap[key];
          lines.push(makeLine(entry.expense, { debit: amount, description: `Employer ${key} expense` }));
          lines.push(makeLine(entry.payable, { credit: amount, description: `Employer ${key} payable` }));
        });
        narration = `HRMS payroll accrual ${year}-${String(month).padStart(2, "0")} (${employees.length} employees)`;
        sourceType = "HRMS_PAYROLL";
        if (netTotal + [...deductionTotals.values()].reduce((a, b) => a + b, 0) !== grossTotal) {
          throw integrationError("Payroll totals do not reconcile", 422, "PAYROLL_RECONCILIATION_FAILED");
        }
      } else {
        const claim = body.claim;
        if (!claim?.claimId || !claim.employeeId || !claim.employeeName) {
          throw integrationError("Claim ID and employee identity are required");
        }
        postingDate = assertDateOpen(config, claim.approvedAt);
        const amount = toMinorUnits(claim.amountMinorUnits, "Claim amount");
        if (amount <= 0) throw integrationError("Claim amount must be greater than zero");
        const categoryMapping = config.claims?.categoryMappings?.find(
          (item) => String(item.categoryId) === String(claim.categoryId)
        );
        if (!categoryMapping) throw integrationError("Claim category has no configured expense account", 422, "CLAIM_MAPPING_MISSING");
        const expenseAccount = await accountById(Account, categoryMapping.expenseAccountId, config.companyId, "Claim expense account", "Expense");
        const payableAccount = await accountById(Account, config.claims?.payableAccountId, config.companyId, "Employee Claims Payable account", "Liability");
        lines.push(makeLine(expenseAccount, { debit: amount, description: `Approved claim ${claim.claimId}` }));
        lines.push(makeLine(payableAccount, {
          credit: amount,
          description: `Claim payable — ${claim.employeeName}`,
          employee: {
            employeeId: String(claim.employeeId),
            employeeCode: claim.employeeCode || "",
            employeeName: claim.employeeName,
          },
          sourceReference: String(claim.claimId),
        }));
        payables.push({
          lineIndex: 1,
          data: {
            accountId: payableAccount._id,
            sourceType: "CLAIM",
            sourceId: String(claim.claimId),
            employeeId: String(claim.employeeId),
            employeeCode: claim.employeeCode || "",
            employeeName: claim.employeeName,
            originalAmountMinorUnits: amount,
          },
        });
        narration = `HRMS approved claim ${claim.claimId}: ${claim.categoryName || "Employee claim"}`;
        sourceType = "HRMS_CLAIM";
      }

      const journal = await persistJournal({
        event,
        payload: body,
        config,
        lines,
        payables,
        date: postingDate,
        narration,
        sourceType,
      });
      return res.status(201).json({
        success: true,
        status: "POSTED",
        eventId: body.eventId,
        journalId: journal._id,
        journalNumber: journal.number,
        postedAt: new Date(),
      });
    } catch (error) {
      await markEventFailure(body.eventId, error);
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

export const postPayrollAccrual = (req, res, next) =>
  createAccrual(req, res, next, "PAYROLL_ACCRUAL");

export const postClaimAccrual = (req, res, next) =>
  createAccrual(req, res, next, "CLAIM_ACCRUAL");

export const postPayrollSettlement = async (req, res, next) => {
  const body = req.body || {};
  if (!body?.eventId || typeof body.eventId !== "string") {
    return res.status(400).json({ success: false, message: "A stable eventId is required" });
  }

  try {
    const config = await getActiveConfig();
    const companyId = config.companyId;
    const paymentDate = body.paymentDate || new Date();
    const date = assertDateOpen(config, paymentDate);

    const Settlement = await getEmployeeSettlementModel();
    const payloadHash = getPayloadHash(body);
    const existing = await Settlement.findOne({ eventId: body.eventId }).lean();
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return res.status(409).json({ success: false, code: "IDEMPOTENCY_CONFLICT", message: "Settlement event ID was reused with a different payload" });
      }
      return res.status(200).json({
        success: true,
        status: "POSTED",
        journalId: existing.journalId,
        message: "Settlement already posted",
      });
    }

    const bankAccountId = body.bankAccountId || config.bankAccountIds?.[0];
    if (!bankAccountId) {
      throw integrationError("No bank ledger configured for HRMS settlement in Accounting", 422, "NO_BANK_ACCOUNT_CONFIGURED");
    }

    const Account = await getAccountModel();
    const Journal = await getJournalModel();
    const JournalLine = await getJournalLineModel();
    const Payable = await getEmployeePayableModel();

    const bankAccount = await accountById(Account, bankAccountId, companyId, "Bank account", "Asset");
    const outstandingSalary = await accountById(Account, config.payroll?.outstandingSalaryAccountId, companyId, "Outstanding Salary account", "Liability");

    // Match open payables
    let candidatePayables = [];
    if (Array.isArray(body.allocations) && body.allocations.some((a) => a.payableId)) {
      const payableIds = body.allocations.map((a) => a.payableId).filter((id) => mongoose.Types.ObjectId.isValid(id));
      candidatePayables = await Payable.find({
        _id: { $in: payableIds },
        companyId,
        sourceType: "PAYROLL",
        status: { $in: ["OPEN", "PARTIAL"] },
      }).lean();
    } else if (Array.isArray(body.employeeIds) && body.employeeIds.length) {
      const query = {
        companyId,
        sourceType: "PAYROLL",
        employeeId: { $in: body.employeeIds.map(String) },
        status: { $in: ["OPEN", "PARTIAL"] },
      };
      if (body.payrollRunId) query.sourceId = String(body.payrollRunId);
      candidatePayables = await Payable.find(query).lean();
    } else if (body.payrollRunId) {
      candidatePayables = await Payable.find({
        companyId,
        sourceType: "PAYROLL",
        sourceId: String(body.payrollRunId),
        status: { $in: ["OPEN", "PARTIAL"] },
      }).lean();
    } else if (Array.isArray(body.allocations) && body.allocations.some((a) => a.employeeId)) {
      const empIds = body.allocations.map((a) => String(a.employeeId));
      candidatePayables = await Payable.find({
        companyId,
        sourceType: "PAYROLL",
        employeeId: { $in: empIds },
        status: { $in: ["OPEN", "PARTIAL"] },
      }).lean();
    }

    if (!candidatePayables.length) {
      return res.status(200).json({
        success: true,
        status: "NOOP",
        message: "No open employee payables found matching settlement request",
      });
    }

    const bankRef = String(body.bankReference || `HRMS-PAY-${new Date().toISOString().slice(0, 10)}`).trim();
    const lines = [];
    const normalizedAllocations = [];
    let totalMinorUnits = 0;

    for (const payable of candidatePayables) {
      const remaining = payable.originalAmountMinorUnits - payable.settledAmountMinorUnits;
      if (remaining <= 0) continue;

      let allocAmount = remaining;
      if (Array.isArray(body.allocations)) {
        const customAlloc = body.allocations.find(
          (a) => String(a.payableId) === String(payable._id) || String(a.employeeId) === String(payable.employeeId)
        );
        if (customAlloc?.amountMinorUnits) {
          allocAmount = Math.min(Number(customAlloc.amountMinorUnits), remaining);
        }
      }

      if (allocAmount <= 0) continue;
      totalMinorUnits += allocAmount;

      const pmtIdStr = payable.paymentId ? ` [Payment ID: ${payable.paymentId}]` : "";
      lines.push(
        makeLine(outstandingSalary, {
          debit: allocAmount,
          description: `Salary settlement ${bankRef} — ${payable.employeeName} (${payable.employeeCode || ""})${pmtIdStr}`,
          employee: {
            employeeId: payable.employeeId,
            employeeCode: payable.employeeCode,
            employeeName: payable.employeeName,
            department: payable.employeeDepartment,
            designation: payable.employeeDesignation,
            officialEmail: payable.employeeEmail,
            pan: payable.employeePan,
            paymentId: payable.paymentId,
          },
          paymentReference: payable.paymentId || bankRef,
          sourceReference: payable.sourceId,
        })
      );
      normalizedAllocations.push({ payable, amount: allocAmount });
    }

    if (totalMinorUnits <= 0) {
      return res.status(200).json({
        success: true,
        status: "NOOP",
        message: "All matching payables are already fully settled",
      });
    }

    lines.push(
      makeLine(bankAccount, {
        credit: totalMinorUnits,
        description: `Salary disbursement ${bankRef} (${normalizedAllocations.length} employees)`,
        sourceReference: bankRef,
      })
    );

    assertJournalBalanced(lines);

    const db = getDatabase("accounting");
    const session = await db.startSession();
    let createdJournal;

    try {
      await session.withTransaction(async () => {
        const number = `PAY-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const [journal] = await Journal.create(
          [
            {
              number,
              voucherType: "PAYMENT",
              date,
              referenceNumber: bankRef,
              paymentReference: bankRef,
              bankReference: bankRef,
              narration: `HRMS salary disbursement ${bankRef} (${normalizedAllocations.length} employees)`,
              companyId,
              sourceType: "HRMS_SETTLEMENT",
              sourceId: body.eventId,
              totalDebit: totalMinorUnits / 100,
              totalCredit: totalMinorUnits / 100,
              status: "Posted",
              approvalStatus: "Approved",
              approvedBy: "HRMS Integration",
              approvalDate: new Date(),
              createdBy: "HRMS Integration",
            },
          ],
          { session }
        );

        const lineDocs = lines.map((line, index) => ({
          ...line,
          journalId: journal._id,
          lineNumber: index + 1,
          transactionMode: "BANK",
          bankReference: bankRef,
        }));
        const savedLines = await JournalLine.insertMany(lineDocs, { session });

        const savedAllocations = [];
        for (let i = 0; i < normalizedAllocations.length; i++) {
          const { payable, amount } = normalizedAllocations[i];
          const updated = await Payable.findOneAndUpdate(
            {
              _id: payable._id,
              companyId,
              settledAmountMinorUnits: payable.settledAmountMinorUnits,
              originalAmountMinorUnits: { $gte: payable.settledAmountMinorUnits + amount },
            },
            {
              $inc: { settledAmountMinorUnits: amount },
              $set: {
                status:
                  payable.settledAmountMinorUnits + amount >= payable.originalAmountMinorUnits
                    ? "SETTLED"
                    : "PARTIAL",
              },
            },
            { new: true, session }
          );

          if (!updated) {
            throw integrationError(`Payable changed during settlement for ${payable.employeeName}`, 409, "PAYABLE_CONCURRENTLY_CHANGED");
          }

          savedAllocations.push({
            payableId: payable._id,
            amountMinorUnits: amount,
            journalLineId: savedLines[i]._id,
          });
        }

        await Settlement.create(
          [
            {
              companyId,
              eventId: body.eventId,
              payloadHash,
              settlementType: "PAYROLL",
              journalId: journal._id,
              bankAccountId: bankAccount._id,
              paymentDate: date,
              bankReference: bankRef,
              allocations: savedAllocations,
              createdBy: "HRMS Integration",
            },
          ],
          { session }
        );

        createdJournal = journal;
      });

      return res.status(201).json({
        success: true,
        status: "POSTED",
        eventId: body.eventId,
        journalId: createdJournal._id,
        journalNumber: createdJournal.number,
        totalSettledAmount: totalMinorUnits / 100,
        settledEmployeesCount: normalizedAllocations.length,
      });
    } finally {
      await session.endSession();
    }
  } catch (error) {
    next(error);
  }
};

export const getIntegrationEvent = async (req, res, next) => {
  try {
    const Event = await getHrmsIntegrationEventModel();
    const event = await Event.findOne({ eventId: req.params.eventId }).lean();
    if (!event) return res.status(404).json({ success: false, message: "Integration event not found" });
    const Payable = await getEmployeePayableModel();
    const Journal = await getJournalModel();
    const payables = await Payable.find({
      companyId: event.companyId,
      sourceId: event.sourceId,
      sourceType: event.eventType === "PAYROLL_ACCRUAL" ? "PAYROLL" : "CLAIM",
    }).select("originalAmountMinorUnits settledAmountMinorUnits").lean();
    const originalMinorUnits = payables.reduce((sum, item) => sum + item.originalAmountMinorUnits, 0);
    const settledMinorUnits = payables.reduce((sum, item) => sum + item.settledAmountMinorUnits, 0);
    const outstandingMinorUnits = originalMinorUnits - settledMinorUnits;
    const journal = event.journalId ? await Journal.findById(event.journalId).select("number").lean() : null;
    res.json({
      success: true,
      eventId: event.eventId,
      status: event.status,
      journalId: event.journalId,
      journalNumber: journal?.number || null,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      settlement: {
        status: originalMinorUnits === 0
          ? "NOT_APPLICABLE"
          : outstandingMinorUnits === 0
            ? "SETTLED"
            : settledMinorUnits > 0
              ? "PARTIAL"
              : "OPEN",
        originalMinorUnits,
        settledMinorUnits,
        outstandingMinorUnits,
      },
    });
  } catch (error) {
    next(error);
  }
};

const requireAccountingAdmin = (req, res, next) => {
  if (!["admin", "superAdmin"].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: "Accounting administrator access required" });
  }
  next();
};

export const getMappings = async (req, res, next) => {
  try {
    const Config = await getHrmsIntegrationConfigModel();
    const config = await Config.findOne({ key: "HRMS" }).lean();
    if (config && String(config.companyId) !== String(req.params.companyId)) {
      return res.status(404).json({ success: false, message: "No HRMS mapping for this company" });
    }
    res.json({ success: true, data: config || null });
  } catch (error) {
    next(error);
  }
};

export const saveMappings = async (req, res, next) => {
  try {
    const companyId = String(req.params.companyId || "");
    const body = req.body || {};
    if (!companyId) return res.status(400).json({ success: false, message: "Company is required" });
    if (
      !Array.isArray(body.payroll?.deductions) ||
      !Array.isArray(body.claims?.categoryMappings) ||
      !Array.isArray(body.bankAccountIds)
    ) {
      return res.status(422).json({ success: false, message: "Deduction, claim category, and bank account mappings must be arrays" });
    }
    const Config = await getHrmsIntegrationConfigModel();
    const Account = await getAccountModel();
    const allIds = [
      body.payroll?.salaryExpenseAccountId,
      body.payroll?.outstandingSalaryAccountId,
      ...(body.payroll?.deductions || []).map((item) => item.accountId),
      body.payroll?.benefits?.epfExpenseAccountId,
      body.payroll?.benefits?.epfPayableAccountId,
      body.payroll?.benefits?.mediclaimExpenseAccountId,
      body.payroll?.benefits?.mediclaimPayableAccountId,
      body.payroll?.benefits?.gratuityExpenseAccountId,
      body.payroll?.benefits?.gratuityPayableAccountId,
      body.claims?.payableAccountId,
      ...(body.bankAccountIds || []),
      ...(body.claims?.categoryMappings || []).map((item) => item.expenseAccountId),
    ];
    if (allIds.some((id) => !id)) {
      return res.status(422).json({ success: false, message: "Complete every required account mapping before saving" });
    }
    const ids = [...new Set(allIds.map(String))];
    if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(422).json({ success: false, message: "One or more ledger account IDs are invalid" });
    }
    const validAccounts = await Account.find({
      _id: { $in: ids },
      companyId,
      isActive: true,
    }).populate("groupId").select("_id groupId");
    if (validAccounts.length !== ids.length) {
      return res.status(422).json({ success: false, message: "Every mapped ledger must be active and belong to this company" });
    }
    const expectedNature = new Map();
    const expectNature = (id, nature) => {
      if (!id) return;
      const key = String(id);
      if (expectedNature.has(key) && expectedNature.get(key) !== nature) {
        throw integrationError("A ledger cannot be mapped to roles with different account natures");
      }
      expectedNature.set(key, nature);
    };
    expectNature(body.payroll?.salaryExpenseAccountId, "Expense");
    expectNature(body.payroll?.outstandingSalaryAccountId, "Liability");
    (body.payroll?.deductions || []).forEach((item) => expectNature(item.accountId, "Liability"));
    expectNature(body.payroll?.benefits?.epfExpenseAccountId, "Expense");
    expectNature(body.payroll?.benefits?.epfPayableAccountId, "Liability");
    expectNature(body.payroll?.benefits?.mediclaimExpenseAccountId, "Expense");
    expectNature(body.payroll?.benefits?.mediclaimPayableAccountId, "Liability");
    expectNature(body.payroll?.benefits?.gratuityExpenseAccountId, "Expense");
    expectNature(body.payroll?.benefits?.gratuityPayableAccountId, "Liability");
    expectNature(body.claims?.payableAccountId, "Liability");
    (body.claims?.categoryMappings || []).forEach((item) => expectNature(item.expenseAccountId, "Expense"));
    (body.bankAccountIds || []).forEach((id) => expectNature(id, "Asset"));
    if (validAccounts.some((account) => account.groupId?.nature !== expectedNature.get(String(account._id)))) {
      return res.status(422).json({ success: false, message: "Mapped ledger account nature does not match its accounting role" });
    }
    const bankAccountIds = [...new Set((body.bankAccountIds || []).map(String))];
    if (!bankAccountIds.length || bankAccountIds.length !== (body.bankAccountIds || []).length) {
      return res.status(422).json({ success: false, message: "Select at least one unique bank ledger for settlement" });
    }
    const configuredBankAccounts = await Account.find({ _id: { $in: bankAccountIds }, companyId })
      .populate("groupId")
      .lean();
    if (configuredBankAccounts.some((account) => account.groupId?.nature !== "Asset")) {
      return res.status(422).json({ success: false, message: "Settlement bank ledgers must belong to an Asset group" });
    }
    const categoryIds = (body.claims?.categoryMappings || []).map((item) => String(item.categoryId || ""));
    if (categoryIds.some((id) => !id) || new Set(categoryIds).size !== categoryIds.length) {
      return res.status(422).json({ success: false, message: "Claim category IDs must be present and unique" });
    }
    const deductionKeys = (body.payroll?.deductions || []).map((item) => String(item.key || ""));
    if (
      deductionKeys.some((key) => !key) ||
      new Set(deductionKeys).size !== deductionKeys.length ||
      (body.payroll?.deductions || []).some((item) => !String(item.label || "").trim())
    ) {
      return res.status(422).json({ success: false, message: "Payroll deduction mapping keys and labels must be present and unique" });
    }
    const closedThroughDate = body.closedThroughDate ? new Date(body.closedThroughDate) : null;
    if (closedThroughDate && !Number.isFinite(closedThroughDate.getTime())) {
      return res.status(422).json({ success: false, message: "Invalid closed-through date" });
    }
    const currency = String(body.currency || "INR").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(422).json({ success: false, message: "Currency must be a three-letter ISO code" });
    }
    const saved = await Config.findOneAndUpdate(
      { key: "HRMS" },
      {
        $set: {
          key: "HRMS",
          companyId,
          currency,
          bankAccountIds,
          closedThroughDate,
          payroll: body.payroll,
          claims: body.claims,
          updatedBy: req.user?.id || req.user?._id?.toString() || "Accounting administrator",
          isActive: true,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({ success: true, data: saved, message: "HRMS accounting mappings saved" });
  } catch (error) {
    next(error);
  }
};

export const listOpenEmployeePayables = async (req, res, next) => {
  try {
    const companyId = String(req.query.companyId || "");
    const Config = await getHrmsIntegrationConfigModel();
    const config = await Config.findOne({ key: "HRMS", companyId, isActive: true }).lean();
    if (!config) return res.status(409).json({ success: false, message: "HRMS mappings are not configured for this company" });
    const Payable = await getEmployeePayableModel();
    
    const filter = { companyId };
    const statusQuery = String(req.query.status || "").toUpperCase();
    if (statusQuery === "ALL") {
      // return all statuses
    } else if (["OPEN", "PARTIAL", "SETTLED"].includes(statusQuery)) {
      filter.status = statusQuery;
    } else {
      filter.status = { $in: ["OPEN", "PARTIAL"] };
      filter.$expr = { $gt: ["$originalAmountMinorUnits", "$settledAmountMinorUnits"] };
    }
    if (req.query.search) {
      const searchRegex = new RegExp(String(req.query.search).trim(), "i");
      filter.$or = [
        { employeeName: searchRegex },
        { employeeCode: searchRegex },
        { paymentId: searchRegex },
        { sourceId: searchRegex },
      ];
    }
    const payables = await Payable.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: payables });
  } catch (error) {
    next(error);
  }
};

export const getSalaryRecords = async (req, res, next) => {
  try {
    const companyId = String(req.query.companyId || req.params.companyId || "");
    if (!companyId) return res.status(400).json({ success: false, message: "companyId is required" });

    const Journal = await getJournalModel();
    const JournalLine = await getJournalLineModel();

    const journals = await Journal.find({
      companyId,
      sourceType: { $in: ["HRMS_PAYROLL", "HRMS_SETTLEMENT"] },
    }).sort({ date: -1, createdAt: -1 }).lean();

    const journalIds = journals.map((j) => j._id);
    const lines = await JournalLine.find({
      companyId,
      journalId: { $in: journalIds },
    }).sort({ lineNumber: 1, createdAt: 1 }).lean();

    const linesByJournal = new Map();
    for (const line of lines) {
      const jId = String(line.journalId);
      if (!linesByJournal.has(jId)) linesByJournal.set(jId, []);
      linesByJournal.get(jId).push(line);
    }

    const records = journals.map((journal) => {
      const jLines = linesByJournal.get(String(journal._id)) || [];
      const employeeMap = new Map();

      for (const line of jLines) {
        if (!line.employeeName && !line.paymentId) continue;
        const key = line.paymentId || line.employeeId || line.employeeName;
        if (!employeeMap.has(key)) {
          employeeMap.set(key, {
            employeeId: line.employeeId,
            employeeName: line.employeeName,
            employeeCode: line.employeeCode,
            employeeDepartment: line.employeeDepartment,
            employeeDesignation: line.employeeDesignation,
            paymentId: line.paymentId,
            grossSalary: 0,
            netSalary: 0,
            deductions: [],
            settledAmount: 0,
          });
        }
        const emp = employeeMap.get(key);
        if (line.debitAmount > 0 && line.accountCode === "SALARY") {
          emp.grossSalary += line.debitAmount;
        } else if (line.creditAmount > 0 && line.accountCode === "OUTSTANDINGS") {
          emp.netSalary += line.creditAmount;
        } else if (line.creditAmount > 0 && line.accountCode !== "OUTSTANDINGS") {
          emp.deductions.push({
            accountCode: line.accountCode,
            accountName: line.accountName,
            amount: line.creditAmount,
          });
        } else if (line.debitAmount > 0 && line.accountCode === "OUTSTANDINGS") {
          emp.settledAmount += line.debitAmount;
        }
      }

      return {
        journalId: journal._id,
        journalNumber: journal.number,
        voucherType: journal.voucherType,
        sourceType: journal.sourceType,
        sourceId: journal.sourceId,
        date: journal.date,
        narration: journal.narration,
        totalAmount: journal.totalDebit || journal.totalCredit || 0,
        employees: Array.from(employeeMap.values()),
        lines: jLines,
      };
    });

    res.json({
      success: true,
      count: records.length,
      data: records,
    });
  } catch (error) {
    next(error);
  }
};

export const createSettlement = async (req, res, next) => {
  const { companyId, settlementType, bankAccountId, paymentDate, bankReference, allocations, eventId } = req.body || {};
  const payloadHash = getPayloadHash(req.body || {});
  try {
    if (!eventId || !companyId || !bankAccountId || !paymentDate || !String(bankReference || "").trim() || !Array.isArray(allocations) || !allocations.length) {
      return res.status(400).json({ success: false, message: "Company, event ID, bank, date, reference, and allocations are required" });
    }
    if (!["PAYROLL", "CLAIM"].includes(settlementType)) {
      return res.status(422).json({ success: false, message: "Invalid settlement type" });
    }
    const Config = await getHrmsIntegrationConfigModel();
    const config = await Config.findOne({ key: "HRMS", companyId, isActive: true }).lean();
    if (!config) return res.status(409).json({ success: false, message: "HRMS mappings are not configured for this company" });
    const date = assertDateOpen(config, paymentDate);
    const Account = await getAccountModel();
    const Journal = await getJournalModel();
    const JournalLine = await getJournalLineModel();
    const Payable = await getEmployeePayableModel();
    const Settlement = await getEmployeeSettlementModel();
    const existing = await Settlement.findOne({ eventId }).lean();
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return res.status(409).json({ success: false, code: "IDEMPOTENCY_CONFLICT", message: "Settlement event ID was reused with a different payload" });
      }
      return res.json({ success: true, status: "POSTED", journalId: existing.journalId, message: "Settlement already posted" });
    }
    const bankAccount = await accountById(Account, bankAccountId, companyId, "Bank account", "Asset");
    if (!(config.bankAccountIds || []).some((id) => String(id) === String(bankAccountId))) {
      return res.status(422).json({ success: false, message: "Select a bank ledger configured for this company" });
    }
    if (bankAccount.groupId?.nature !== "Asset") {
      return res.status(422).json({ success: false, message: "Settlement account must belong to an Asset group" });
    }
    const payableIds = [...new Set(allocations.map((item) => String(item.payableId || "")))];
    if (payableIds.length !== allocations.length || payableIds.some((id) => !id)) {
      return res.status(422).json({ success: false, message: "Settlement allocations must reference unique payable records" });
    }
    if (payableIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(422).json({ success: false, message: "One or more payable record IDs are invalid" });
    }
    const payables = await Payable.find({
      _id: { $in: payableIds },
      companyId,
      sourceType: settlementType,
      status: { $in: ["OPEN", "PARTIAL"] },
    }).lean();
    if (payables.length !== allocations.length) {
      return res.status(422).json({ success: false, message: "One or more selected payable items are not open for this company/type" });
    }
    const payableById = new Map(payables.map((item) => [String(item._id), item]));
    let totalMinorUnits = 0;
    const lines = [];
    const normalizedAllocations = [];
    for (const allocation of allocations) {
      const payable = payableById.get(String(allocation.payableId));
      const amount = toMinorUnits(allocation.amountMinorUnits, "Settlement allocation");
      const remaining = payable.originalAmountMinorUnits - payable.settledAmountMinorUnits;
      if (!amount || amount > remaining) throw integrationError(`Settlement exceeds remaining payable for ${payable.employeeName}`);
      totalMinorUnits += amount;
      lines.push(makeLine(
        await accountById(Account, payable.accountId, companyId, "Payable control account", "Liability"),
        {
          debit: amount,
          description: `Settlement ${bankReference} — ${payable.employeeName}`,
          employee: {
            employeeId: payable.employeeId,
            employeeCode: payable.employeeCode,
            employeeName: payable.employeeName,
          },
          sourceReference: payable.sourceId,
        }
      ));
      normalizedAllocations.push({ payable, amount });
    }
    lines.push(makeLine(bankAccount, {
      credit: totalMinorUnits,
      description: `Employee settlement ${String(bankReference).trim()}`,
      sourceReference: String(bankReference).trim(),
    }));
    assertJournalBalanced(lines);

    const db = getDatabase("accounting");
    const session = await db.startSession();
    let journal;
    try {
      await session.withTransaction(async () => {
        const number = `PAY-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const [created] = await Journal.create([{
          number,
          voucherType: "PAYMENT",
          date,
          referenceNumber: String(bankReference).trim(),
          paymentReference: String(bankReference).trim(),
          bankReference: String(bankReference).trim(),
          narration: `${settlementType === "PAYROLL" ? "Salary" : "Claim"} settlement`,
          companyId,
          sourceType: "HRMS_SETTLEMENT",
          sourceId: eventId,
          totalDebit: totalMinorUnits / 100,
          totalCredit: totalMinorUnits / 100,
          status: "Draft",
          approvalStatus: "Pending",
          createdBy: req.user?.id || req.user?._id?.toString() || "Accounting User",
        }], { session });
        const lineDocs = lines.map((line, index) => ({
          ...line,
          journalId: created._id,
          lineNumber: index + 1,
          transactionMode: "BANK",
          bankReference: String(bankReference).trim(),
        }));
        const savedLines = await JournalLine.insertMany(lineDocs, { session });
        const savedAllocations = [];
        for (let index = 0; index < normalizedAllocations.length; index += 1) {
          const { payable, amount } = normalizedAllocations[index];
          const updated = await Payable.findOneAndUpdate(
            {
              _id: payable._id,
              companyId,
              settledAmountMinorUnits: payable.settledAmountMinorUnits,
              originalAmountMinorUnits: { $gte: payable.settledAmountMinorUnits + amount },
            },
            {
              $inc: { settledAmountMinorUnits: amount },
              $set: {
                status: payable.settledAmountMinorUnits + amount === payable.originalAmountMinorUnits ? "SETTLED" : "PARTIAL",
              },
            },
            { new: true, session }
          );
          if (!updated) throw integrationError(`Payable changed during settlement for ${payable.employeeName}`, 409, "PAYABLE_CONCURRENTLY_CHANGED");
          savedAllocations.push({
            payableId: payable._id,
            amountMinorUnits: amount,
            journalLineId: savedLines[index]._id,
          });
        }
        const [savedSettlement] = await Settlement.create([{
          companyId,
          eventId,
          payloadHash,
          settlementType,
          journalId: created._id,
          bankAccountId,
          paymentDate: date,
          bankReference: String(bankReference).trim(),
          allocations: savedAllocations,
          createdBy: req.user?.id || req.user?._id?.toString() || "Accounting User",
        }], { session });
        created.status = "Posted";
        created.approvalStatus = "Approved";
        created.approvedBy = req.user?.id || req.user?._id?.toString() || "Accounting User";
        created.approvalDate = new Date();
        await created.save({ session });
        journal = { _id: created._id, number: created.number, settlementId: savedSettlement._id };
      });
    } finally {
      await session.endSession();
    }
    res.status(201).json({ success: true, status: "POSTED", data: journal });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    if (error?.code === 11000) {
      const Settlement = await getEmployeeSettlementModel();
      const existing = await Settlement.findOne({ eventId }).lean();
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return res.status(409).json({ success: false, code: "IDEMPOTENCY_CONFLICT", message: "Settlement event ID was reused with a different payload" });
        }
        return res.status(200).json({
          success: true,
          status: "POSTED",
          journalId: existing.journalId,
          message: "Settlement already posted",
        });
      }
    }
    next(error);
  }
};

export const getEmployeePayableReconciliation = async (req, res, next) => {
  try {
    const companyId = String(req.query.companyId || "");
    const Config = await getHrmsIntegrationConfigModel();
    const config = await Config.findOne({ key: "HRMS", companyId, isActive: true }).lean();
    if (!config) return res.status(409).json({ success: false, message: "HRMS mappings are not configured for this company" });
    const Account = await getAccountModel();
    const Journal = await getJournalModel();
    const JournalLine = await getJournalLineModel();
    const Payable = await getEmployeePayableModel();
    const accounts = await Account.find({
      _id: {
        $in: [
          config.payroll.outstandingSalaryAccountId,
          config.claims.payableAccountId,
        ],
      },
      companyId,
    }).select("_id code name openingBalance openingType").lean();
    const accountIds = accounts.map((account) => account._id);
    const [subledger, ledgerLines] = await Promise.all([
      Payable.aggregate([
        { $match: { companyId, accountId: { $in: accountIds } } },
        {
          $group: {
            _id: "$accountId",
            openMinorUnits: {
              $sum: { $subtract: ["$originalAmountMinorUnits", "$settledAmountMinorUnits"] },
            },
            itemCount: { $sum: 1 },
          },
        },
      ]),
      JournalLine.aggregate([
        { $match: { companyId, accountId: { $in: accountIds } } },
        {
          $lookup: {
            from: Journal.collection.name,
            localField: "journalId",
            foreignField: "_id",
            as: "journal",
          },
        },
        { $unwind: "$journal" },
        {
          $match: {
            "journal.status": { $in: ["Posted", "Approved"] },
            "journal.isDeleted": { $ne: true },
          },
        },
        {
          $group: {
            _id: "$accountId",
            debit: { $sum: "$debitAmount" },
            credit: { $sum: "$creditAmount" },
          },
        },
      ]),
    ]);
    const subledgerByAccount = new Map(subledger.map((item) => [String(item._id), item]));
    const ledgerByAccount = new Map(ledgerLines.map((item) => [String(item._id), item]));
    const data = accounts.map((account) => {
      const subledgerBalance = subledgerByAccount.get(String(account._id))?.openMinorUnits || 0;
      const activity = ledgerByAccount.get(String(account._id)) || { debit: 0, credit: 0 };
      const openingBalance = Number(account.openingBalance || 0) *
        (account.openingType === "credit" ? 1 : -1);
      const ledgerBalance = Math.round((openingBalance + activity.credit - activity.debit) * 100);
      return {
        accountId: account._id,
        accountCode: account.code,
        accountName: account.name,
        employeeSubledgerMinorUnits: subledgerBalance,
        generalLedgerMinorUnits: ledgerBalance,
        differenceMinorUnits: ledgerBalance - subledgerBalance,
        itemCount: subledgerByAccount.get(String(account._id))?.itemCount || 0,
      };
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const reverseSettlement = async (req, res, next) => {
  const { settlementId } = req.params;
  const { companyId, eventId, paymentDate, bankReference, allocations } = req.body || {};
  const payloadHash = getPayloadHash(req.body || {});
  try {
    if (
      !companyId ||
      !eventId ||
      !paymentDate ||
      !String(bankReference || "").trim() ||
      !Array.isArray(allocations) ||
      !allocations.length
    ) {
      return res.status(400).json({
        success: false,
        message: "Company, event ID, reversal date, bank reference, and payable allocations are required",
      });
    }
    if (!mongoose.Types.ObjectId.isValid(settlementId)) {
      return res.status(422).json({ success: false, message: "Invalid settlement ID" });
    }
    const Settlement = await getEmployeeSettlementModel();
    const priorReversal = await Settlement.findOne({ eventId }).lean();
    if (priorReversal) {
      if (priorReversal.payloadHash !== payloadHash) {
        return res.status(409).json({ success: false, code: "IDEMPOTENCY_CONFLICT", message: "Reversal event ID was reused with a different payload" });
      }
      return res.status(200).json({
        success: true,
        status: "POSTED",
        journalId: priorReversal.journalId,
        message: "Reversal already posted",
      });
    }
    const Config = await getHrmsIntegrationConfigModel();
    const config = await Config.findOne({ key: "HRMS", companyId, isActive: true }).lean();
    if (!config) return res.status(409).json({ success: false, message: "HRMS mappings are not configured for this company" });
    const date = assertDateOpen(config, paymentDate);
    const Account = await getAccountModel();
    const Journal = await getJournalModel();
    const JournalLine = await getJournalLineModel();
    const Payable = await getEmployeePayableModel();
    const db = getDatabase("accounting");
    const session = await db.startSession();
    let response;
    try {
      await session.withTransaction(async () => {
        const original = await Settlement.findOne({
          _id: settlementId,
          companyId,
          isReversal: { $ne: true },
        }).session(session);
        if (!original) throw integrationError("Original settlement was not found", 404, "SETTLEMENT_NOT_FOUND");
        const payableIds = [...new Set(allocations.map((item) => String(item.payableId || "")))];
        if (payableIds.length !== allocations.length || payableIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
          throw integrationError("Reversal allocations must reference unique valid employee payable records");
        }
        let totalMinorUnits = 0;
        const reverseLines = [];
        const allocationUpdates = [];
        for (const allocation of allocations) {
          const payableId = String(allocation.payableId);
          const originalAllocation = original.allocations.find(
            (item) => String(item.payableId) === payableId
          );
          if (!originalAllocation) {
            throw integrationError("A reversal can only reference payables from the original settlement");
          }
          const amount = toMinorUnits(allocation.amountMinorUnits, "Reversal allocation");
          const reversible = originalAllocation.amountMinorUnits -
            originalAllocation.reversedAmountMinorUnits;
          if (!amount || amount > reversible) {
            throw integrationError("Reversal amount exceeds the unsettled portion of the original payment");
          }
          const payable = await Payable.findOne({ _id: payableId, companyId }).session(session);
          if (!payable || payable.settledAmountMinorUnits < amount) {
            throw integrationError("Employee payable cannot be reversed by the requested amount", 409, "PAYABLE_REVERSAL_CONFLICT");
          }
          const payableAccount = await accountById(
            Account,
            payable.accountId,
            companyId,
            "Payable control account",
            "Liability"
          );
          totalMinorUnits += amount;
          reverseLines.push(makeLine(payableAccount, {
            credit: amount,
            description: `Settlement reversal ${String(bankReference).trim()} — ${payable.employeeName}`,
            employee: {
              employeeId: payable.employeeId,
              employeeCode: payable.employeeCode,
              employeeName: payable.employeeName,
            },
            sourceReference: payable.sourceId,
          }));
          allocationUpdates.push({ originalAllocation, payable, amount });
        }
        const bankAccount = await accountById(
          Account,
          original.bankAccountId,
          companyId,
          "Original settlement bank account",
          "Asset"
        );
        reverseLines.push(makeLine(bankAccount, {
          debit: totalMinorUnits,
          description: `Settlement reversal ${String(bankReference).trim()}`,
          sourceReference: String(bankReference).trim(),
        }));
        assertJournalBalanced(reverseLines);

        const number = `REV-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const [created] = await Journal.create([{
          number,
          voucherType: "JOURNAL",
          date,
          referenceNumber: String(bankReference).trim(),
          bankReference: String(bankReference).trim(),
          narration: `Reversal of employee settlement ${original.bankReference}`,
          companyId,
          sourceType: "REVERSAL",
          sourceId: eventId,
          totalDebit: totalMinorUnits / 100,
          totalCredit: totalMinorUnits / 100,
          status: "Draft",
          approvalStatus: "Pending",
          createdBy: req.user?.id || req.user?._id?.toString() || "Accounting User",
        }], { session });
        const savedLines = await JournalLine.insertMany(
          reverseLines.map((line, index) => ({
            ...line,
            journalId: created._id,
            lineNumber: index + 1,
          })),
          { session }
        );
        const reversalAllocations = [];
        for (let index = 0; index < allocationUpdates.length; index += 1) {
          const { originalAllocation, payable, amount } = allocationUpdates[index];
          const newSettledAmount = payable.settledAmountMinorUnits - amount;
          const updated = await Payable.findOneAndUpdate(
            {
              _id: payable._id,
              companyId,
              settledAmountMinorUnits: payable.settledAmountMinorUnits,
            },
            {
              $inc: { settledAmountMinorUnits: -amount },
              $set: { status: newSettledAmount === 0 ? "OPEN" : "PARTIAL" },
            },
            { new: true, session }
          );
          if (!updated) throw integrationError("Payable changed during reversal", 409, "PAYABLE_CONCURRENTLY_CHANGED");
          originalAllocation.reversedAmountMinorUnits += amount;
          reversalAllocations.push({
            payableId: payable._id,
            amountMinorUnits: amount,
            journalLineId: savedLines[index]._id,
          });
        }
        await original.save({ session });
        const [savedReversal] = await Settlement.create([{
          companyId,
          eventId,
          payloadHash,
          settlementType: original.settlementType,
          journalId: created._id,
          bankAccountId: original.bankAccountId,
          paymentDate: date,
          bankReference: String(bankReference).trim(),
          allocations: reversalAllocations,
          isReversal: true,
          reversesSettlementId: original._id,
          createdBy: req.user?.id || req.user?._id?.toString() || "Accounting User",
        }], { session });
        created.status = "Posted";
        created.approvalStatus = "Approved";
        created.approvedBy = req.user?.id || req.user?._id?.toString() || "Accounting User";
        created.approvalDate = new Date();
        await created.save({ session });
        response = { _id: created._id, number: created.number, reversalId: savedReversal._id };
      });
    } finally {
      await session.endSession();
    }
    res.status(201).json({ success: true, status: "POSTED", data: response });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    if (error?.code === 11000) {
      const Settlement = await getEmployeeSettlementModel();
      const existing = await Settlement.findOne({ eventId }).lean();
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return res.status(409).json({ success: false, code: "IDEMPOTENCY_CONFLICT", message: "Reversal event ID was reused with a different payload" });
        }
        return res.status(200).json({ success: true, status: "POSTED", journalId: existing.journalId });
      }
    }
    next(error);
  }
};

export const listEmployeeSettlements = async (req, res, next) => {
  try {
    const companyId = String(req.query.companyId || "");
    const Settlement = await getEmployeeSettlementModel();
    const Payable = await getEmployeePayableModel();
    const settlements = await Settlement.find({ companyId, isReversal: { $ne: true } })
      .sort({ paymentDate: -1 })
      .limit(100)
      .lean();
    const payableIds = [...new Set(settlements.flatMap((item) => item.allocations.map((allocation) => String(allocation.payableId))))];
    const payables = await Payable.find({ _id: { $in: payableIds }, companyId })
      .select("employeeId employeeCode employeeName sourceId")
      .lean();
    const payableById = new Map(payables.map((item) => [String(item._id), item]));
    res.json({
      success: true,
      data: settlements.map((settlement) => ({
        ...settlement,
        allocations: settlement.allocations.map((allocation) => ({
          ...allocation,
          employee: payableById.get(String(allocation.payableId)) || null,
        })),
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const listEmployeePayablesAdmin = async (req, res, next) => {
  try {
    const companyId = String(req.params.companyId || "");
    const Config = await getHrmsIntegrationConfigModel();
    const config = await Config.findOne({ key: "HRMS", companyId }).lean();
    if (!config) return res.json({ success: true, data: null });
    const Account = await getAccountModel();
    const accounts = await Account.find({ companyId, isActive: true })
      .select("code name type groupId groupName")
      .populate("groupId", "nature")
      .sort({ code: 1 })
      .lean();
    res.json({ success: true, data: { config, accounts } });
  } catch (error) {
    next(error);
  }
};
