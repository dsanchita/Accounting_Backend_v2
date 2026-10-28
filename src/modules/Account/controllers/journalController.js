import ApiResponse from "../../../utils/ApiResponse.js";
import AppError from "../../../utils/AppError.js";
import { createAuditLog } from "../../../utils/createAuditLog.js";
import {
  createJournalRepo,
  getJournalByIdRepo,
  getJournalsRepo,
  updateJournalRepo,
  deleteJournalRepo,
  getJournalStatsRepo,
  getJournalsByApprovalStatusRepo,
} from "../repos/journalRepo.js";
import { createMultipleJournalLinesRepo, deleteJournalLinesByJournalRepo } from "../repos/journalLineRepo.js";
import { getBankLedgerTransactionModel } from "../models/BankLedgerTransaction.js";
import { getBankReconciliationAllocationModel } from "../models/BankReconciliationAllocation.js";
import { BankReconciliationService } from "../services/bankReconciliationService.js";
import {
  createJournalApprovalRequestRepo,
  findPendingApprovalForJournalRepo,
  getJournalApprovalRequestByIdRepo,
  getJournalApprovalRequestsRepo,
  updateJournalApprovalRequestRepo,
} from "../repos/journalApprovalRequestRepo.js";
import { getAccountsRepo } from "../repos/accountRepo.js";
import { getJournalModel } from "../models/Journal.js";
import { getPaymentModel } from "../models/Payment.js";
import { getInvoiceByIdRepo, updateInvoiceRepo } from "../../Invoice/repos/invoiceRepo.js";
import { notifyCompanyAdmins, emitNotification } from "../../../utils/notificationEmitter.js";


const VALID_VOUCHER_TYPES = ["SALES", "PURCHASE", "PAYMENT", "RECEIPT", "CONTRA", "JOURNAL"];

const normalizeVoucherType = (value = "") => {
  const normalized = String(value).trim().toUpperCase();
  const mappedValue =
    {
      "JOURNAL ENTRY": "JOURNAL",
      JOURNAL: "JOURNAL",
      RECEIPT: "RECEIPT",
      PAYMENT: "PAYMENT",
      CONTRA: "CONTRA",
      SALES: "SALES",
      PURCHASE: "PURCHASE",
    }[normalized] || normalized;

  if (!VALID_VOUCHER_TYPES.includes(mappedValue)) {
    throw new AppError(
      `Invalid voucherType. Expected one of: ${VALID_VOUCHER_TYPES.join(", ")}`,
      400,
      "normalizeVoucherType"
    );
  }

  return mappedValue;
};

const normalizeJournalLines = (lines = []) =>
  lines.map((line, index) => ({
    ...line,
    accountId: line.accountId || line.account?._id || line.account,
    debitAmount: Number(line.debitAmount ?? line.debit ?? 0),
    creditAmount: Number(line.creditAmount ?? line.credit ?? 0),
    description: line.description || line.memo || "",
    lineNumber: Number(line.lineNumber || index + 1),
  }));

const validateJournalLines = (lines = []) => {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new AppError("At least 2 journal lines are required", 400, "validateJournalLines");
  }

  let totalDebit = 0;
  let totalCredit = 0;

  lines.forEach((line, index) => {
    if (!line.accountId) {
      throw new AppError(`Account is required for line ${index + 1}`, 400, "validateJournalLines");
    }
    if (line.debitAmount < 0 || line.creditAmount < 0) {
      throw new AppError(`Negative amounts are not allowed on line ${index + 1}`, 400, "validateJournalLines");
    }
    if (line.debitAmount === 0 && line.creditAmount === 0) {
      throw new AppError(
        `Either debit or credit amount is required on line ${index + 1}`,
        400,
        "validateJournalLines"
      );
    }
    if (line.debitAmount > 0 && line.creditAmount > 0) {
      throw new AppError(
        `A line cannot contain both debit and credit amounts on line ${index + 1}`,
        400,
        "validateJournalLines"
      );
    }

    totalDebit += line.debitAmount;
    totalCredit += line.creditAmount;
  });

  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new AppError("Journal entry is not balanced", 400, "validateJournalLines");
  }

  return { totalDebit, totalCredit };
};

const enrichJournalLines = async (lines = [], companyId) => {
  const accountIds = [...new Set(lines.map((line) => String(line.accountId || "")).filter(Boolean))];
  const accounts = await getAccountsRepo({
    companyId,
    _id: { $in: accountIds },
  });

  const accountMap = new Map(accounts.map((account) => [String(account._id), account]));

  return lines.map((line, index) => {
    const account = accountMap.get(String(line.accountId));
    if (!account) {
      throw new AppError(`Account not found for line ${index + 1}`, 400, "enrichJournalLines");
    }

    return {
      ...line,
      accountId: account._id,
      accountCode: line.accountCode || account.code,
      accountName: line.accountName || account.name,
    };
  });
};

const applyJournalUpdate = async (id, payload, userId) => {
  const oldJournal = await getJournalByIdRepo(id);
  if (!oldJournal) {
    throw new AppError("Journal not found", 404, "applyJournalUpdate");
  }

  const companyId = payload.companyId || oldJournal.companyId;
  const updateData = {
    updatedBy: userId,
  };

  if (payload.voucherType !== undefined) updateData.voucherType = normalizeVoucherType(payload.voucherType);
  if (payload.date !== undefined) updateData.date = new Date(payload.date);
  if (payload.referenceNumber !== undefined) updateData.referenceNumber = payload.referenceNumber;
  if (payload.externalDocNo !== undefined) updateData.externalDocNo = payload.externalDocNo;
  if (payload.narration !== undefined) updateData.narration = payload.narration;
  if (payload.sourceType !== undefined) updateData.sourceType = payload.sourceType;
  if (payload.sourceId !== undefined) updateData.sourceId = payload.sourceId;
  if (payload.partyName !== undefined) updateData.partyName = payload.partyName;

  if (payload.lines !== undefined) {
    const BankLedgerTransaction = await getBankLedgerTransactionModel();
    const Allocation = await getBankReconciliationAllocationModel();
    const normalizedLines = normalizeJournalLines(payload.lines);
    const enrichedLines = await enrichJournalLines(normalizedLines, companyId);
    const { totalDebit, totalCredit } = validateJournalLines(enrichedLines);

    updateData.totalDebit = totalDebit;
    updateData.totalCredit = totalCredit;

    const existingBankLedgerTransactions = await BankLedgerTransaction.find({
      companyId,
      journalId: id,
    }).lean();
    const existingBankLedgerTransactionIds = existingBankLedgerTransactions.map((item) => item._id);
    const relatedAllocations = existingBankLedgerTransactionIds.length
      ? await Allocation.find({
        companyId,
        bankLedgerTransactionId: { $in: existingBankLedgerTransactionIds },
      }).lean()
      : [];
    const affectedBankTransactionIds = [
      ...new Set(relatedAllocations.map((item) => String(item.bankTransactionId)).filter(Boolean)),
    ];

    if (existingBankLedgerTransactionIds.length > 0) {
      await Allocation.deleteMany({
        companyId,
        bankLedgerTransactionId: { $in: existingBankLedgerTransactionIds },
      });
      await BankLedgerTransaction.deleteMany({
        companyId,
        journalId: id,
      });
    }

    await deleteJournalLinesByJournalRepo(id);
    await createMultipleJournalLinesRepo(
      enrichedLines.map((line) => ({
        journalId: id,
        accountId: line.accountId,
        accountCode: line.accountCode,
        accountName: line.accountName,
        companyId,
        debitAmount: line.debitAmount || 0,
        creditAmount: line.creditAmount || 0,
        description: line.description,
        linkedToClientId: line.linkedToClientId || null,
        linkedToVendorId: line.linkedToVendorId || null,
        lineNumber: line.lineNumber,
      }))
    );

    for (const bankTransactionId of affectedBankTransactionIds) {
      await BankReconciliationService.syncAllocationStatus(bankTransactionId, null);
    }
  }

  await updateJournalRepo(id, updateData);
  const updatedJournal = await getJournalByIdRepo(id);

  return { updatedJournal, updateData, oldJournal };
};

const generateJournalNumber = async (companyId, voucherType) => {
  try {
    const Journal = await getJournalModel();
    const date = new Date();
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear()).substring(2); // YY
    const dateStr = `${day}${month}${year}`;

    const prefix = String(voucherType || "JOURNAL")
      .substring(0, 3)
      .toUpperCase();

    // Find journals for this company and date to get the serial
    const count = await Journal.countDocuments({
      companyId,
      number: { $regex: new RegExp(`^${prefix}${dateStr}-`) },
    });

    const serial = String(count + 1).padStart(2, "0");
    return `${prefix}-${dateStr}-${serial}`;
  } catch (error) {
    console.error("Error generating journal number:", error);
    // Fallback to timestamp if something goes wrong
    return `${String(voucherType || "JOURNAL")
      .substring(0, 3)
      .toUpperCase()}-${Date.now()}`;
  }
};

export const createJournal = async (req, res, next) => {
  try {
    const { voucherType, date, referenceNumber, externalDocNo, narration, companyId, sourceType, sourceId, partyName, lines } =
      req.body;

    if (!voucherType || !date || !companyId || !lines || lines.length === 0) {
      throw new AppError("Missing required fields: voucherType, date, companyId, lines", 400, "createJournal");
    }

    const normalizedVoucherType = normalizeVoucherType(voucherType);
    const normalizedLines = await enrichJournalLines(normalizeJournalLines(lines), companyId);
    const journalNumber = await generateJournalNumber(companyId, normalizedVoucherType);
    const { totalDebit, totalCredit } = validateJournalLines(normalizedLines);

    const journalData = {
      number: journalNumber,
      voucherType: normalizedVoucherType,
      date: new Date(date),
      referenceNumber,
      externalDocNo,
      narration,
      companyId,
      sourceType: sourceType || "MANUAL",
      sourceId,
      partyName,
      totalDebit,
      totalCredit,
      status: "Posted",
      approvalStatus: "Approved",
      createdBy: req.user?.id || req.user?._id?.toString() || req.body?.createdBy,
    };

    const journal = await createJournalRepo(journalData);

    const journalLinesData = normalizedLines.map((line) => ({
      journalId: journal._id,
      accountId: line.accountId,
      accountCode: line.accountCode,
      accountName: line.accountName,
      companyId,
      debitAmount: line.debitAmount || 0,
      creditAmount: line.creditAmount || 0,
      description: line.description,
      linkedToClientId: line.linkedToClientId,
      linkedToVendorId: line.linkedToVendorId,
      lineNumber: line.lineNumber,
    }));

    await createMultipleJournalLinesRepo(journalLinesData);

    await createAuditLog({
      userId: req.user?.id,
      entityType: "Journal",
      entityId: journal._id,
      action: "CREATE",
      changes: journalData,
      companyId,
    });

    const createdJournal = await getJournalByIdRepo(journal._id);
    
    // IN-APP NOTIFICATION: Notify company admins about new journal
    const userName = req.user?.name || "System User";
    notifyCompanyAdmins({
      companyId: companyId,
      title: "New Journal Created",
      message: `Journal ${journal.number} has been created by ${userName} and is pending approval.`,
      type: "APPROVAL_REQUEST",
      relatedEntity: {
        entityType: "JOURNAL",
        entityId: journal._id.toString()
      },
      senderName: userName
    });

    new ApiResponse({
      statusCode: 201,
      data: createdJournal,
      message: "Journal created successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getAllJournals = async (req, res, next) => {
  try {
    const { companyId, status, approvalStatus, startDate, endDate } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getAllJournals");
    }

    const filter = { companyId };
    if (status) filter.status = status;
    if (approvalStatus) filter.approvalStatus = approvalStatus;

    if (startDate && endDate) {
      filter.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    const journals = await getJournalsRepo(filter);

    new ApiResponse({
      statusCode: 200,
      data: journals,
      message: "Journals retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getJournalById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Journal ID is required", 400, "getJournalById");
    }

    const journal = await getJournalByIdRepo(id);

    new ApiResponse({
      statusCode: 200,
      data: journal,
      message: "Journal retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const updateJournal = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new AppError("Journal ID is required", 400, "updateJournal");
    }

    const { updatedJournal, updateData, oldJournal } = await applyJournalUpdate(id, req.body, req.user?.id);

    await createAuditLog({
      userId: req.user?.id,
      entityType: "Journal",
      entityId: id,
      action: "UPDATE",
      changes: updateData,
      oldValues: oldJournal,
      companyId: oldJournal.companyId,
    });

    new ApiResponse({
      statusCode: 200,
      data: updatedJournal,
      message: "Journal updated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const deleteJournal = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Journal ID is required", 400, "deleteJournal");
    }

    const journal = await getJournalByIdRepo(id);

    await deleteJournalLinesByJournalRepo(id);
    await deleteJournalRepo(id);

    await createAuditLog({
      userId: req.user?.id,
      entityType: "Journal",
      entityId: id,
      action: "DELETE",
      changes: journal,
      companyId: journal.companyId,
    });

    new ApiResponse({
      statusCode: 200,
      data: null,
      message: "Journal deleted successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getJournalStats = async (req, res, next) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getJournalStats");
    }

    const stats = await getJournalStatsRepo(companyId);

    new ApiResponse({
      statusCode: 200,
      data: stats,
      message: "Journal stats retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const approveJournal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { approvalComments } = req.body;

    if (!id) {
      throw new AppError("Journal ID is required", 400, "approveJournal");
    }

    const journal = await getJournalByIdRepo(id);

    const updateData = {
      approvalStatus: "Approved",
      status: "Posted",
      approvedBy: req.user?.id,
      approvalDate: new Date(),
      approvalComments,
    };

    const approvedJournal = await updateJournalRepo(id, updateData);

    await createAuditLog({
      userId: req.user?.id,
      entityType: "Journal",
      entityId: id,
      action: "APPROVE",
      changes: updateData,
      companyId: journal.companyId,
    });
    
    // IN-APP NOTIFICATION: Notify the original creator
    const userName = req.user?.name || "System User";
    if (journal.createdBy) {
      emitNotification({
        companyId: journal.companyId,
        recipientId: journal.createdBy.toString(),
        title: "Journal Approved",
        message: `Your journal ${journal.number} has been approved by ${userName}.`,
        type: "APPROVED",
        relatedEntity: {
          entityType: "JOURNAL",
          entityId: journal._id.toString()
        },
        senderName: userName
      });
    }

    new ApiResponse({
      statusCode: 200,
      data: approvedJournal,
      message: "Journal approved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const rejectJournal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { approvalComments } = req.body;

    if (!id) {
      throw new AppError("Journal ID is required", 400, "rejectJournal");
    }

    const journal = await getJournalByIdRepo(id);

    const updateData = {
      approvalStatus: "Rejected",
      status: "Draft",
      approvedBy: req.user?.id,
      approvalDate: new Date(),
      approvalComments,
    };

    const rejectedJournal = await updateJournalRepo(id, updateData);

    await createAuditLog({
      userId: req.user?.id,
      entityType: "Journal",
      entityId: id,
      action: "REJECT",
      changes: updateData,
      companyId: journal.companyId,
    });
    
    // IN-APP NOTIFICATION: Notify the original creator
    const userName = req.user?.name || "System User";
    if (journal.createdBy) {
      emitNotification({
        companyId: journal.companyId,
        recipientId: journal.createdBy.toString(),
        title: "Journal Rejected",
        message: `Your journal ${journal.number} has been rejected by ${userName}. Reason: ${approvalComments}`,
        type: "REJECTED",
        relatedEntity: {
          entityType: "JOURNAL",
          entityId: journal._id.toString()
        },
        senderName: userName
      });
    }

    new ApiResponse({
      statusCode: 200,
      data: rejectedJournal,
      message: "Journal rejected successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getPendingApprovals = async (req, res, next) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getPendingApprovals");
    }

    const journals = await getJournalsByApprovalStatusRepo(companyId, "Pending");

    new ApiResponse({
      statusCode: 200,
      data: journals,
      message: "Pending approvals retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getJournalApprovalRequests = async (req, res, next) => {
  try {
    const companyId = req.query.companyId;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getJournalApprovalRequests");
    }

    const requests = await getJournalApprovalRequestsRepo({ companyId });

    new ApiResponse({
      statusCode: 200,
      data: requests,
      message: "Journal approval requests retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const requestJournalEditApproval = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { companyId, requestComment = "" } = req.body;

    if (!id || !companyId) {
      throw new AppError("journalId and companyId are required", 400, "requestJournalEditApproval");
    }

    const journal = await getJournalByIdRepo(id);
    if (!journal || String(journal.companyId) !== String(companyId)) {
      throw new AppError("Journal not found", 404, "requestJournalEditApproval");
    }

    const pending = await findPendingApprovalForJournalRepo(companyId, id, "edit");
    if (pending) {
      throw new AppError("An edit approval request is already pending for this journal", 400, "requestJournalEditApproval");
    }

    const request = await createJournalApprovalRequestRepo({
      companyId,
      journalId: id,
      journalNumber: journal.number,
      type: "edit",
      requestedBy: req.user?.id,
      requestComment,
      requestedPayload: req.body,
    });
    
    // IN-APP NOTIFICATION: Notify company admins about edit request
    const userName = req.user?.name || "System User";
    notifyCompanyAdmins({
      companyId: companyId,
      title: "Journal Edit Request",
      message: `User ${userName} has requested to edit Journal ${journal.number}.`,
      type: "APPROVAL_REQUEST",
      relatedEntity: {
        entityType: "JOURNAL",
        entityId: journal._id.toString()
      },
      senderName: userName
    });

    new ApiResponse({
      statusCode: 201,
      data: request,
      message: "Journal edit approval request created successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const requestJournalDeleteApproval = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { companyId, requestComment = "" } = req.body;

    if (!id || !companyId) {
      throw new AppError("journalId and companyId are required", 400, "requestJournalDeleteApproval");
    }

    const journal = await getJournalByIdRepo(id);
    if (!journal || String(journal.companyId) !== String(companyId)) {
      throw new AppError("Journal not found", 404, "requestJournalDeleteApproval");
    }

    const pending = await findPendingApprovalForJournalRepo(companyId, id, "delete");
    if (pending) {
      throw new AppError("A delete approval request is already pending for this journal", 400, "requestJournalDeleteApproval");
    }

    const request = await createJournalApprovalRequestRepo({
      companyId,
      journalId: id,
      journalNumber: journal.number,
      type: "delete",
      requestedBy: req.user?.id,
      requestComment,
      requestedPayload: null,
    });
    
    // IN-APP NOTIFICATION: Notify company admins about delete request
    const userName = req.user?.name || "System User";
    notifyCompanyAdmins({
      companyId: companyId,
      title: "Journal Delete Request",
      message: `User ${userName} has requested to delete Journal ${journal.number}.`,
      type: "APPROVAL_REQUEST",
      relatedEntity: {
        entityType: "JOURNAL",
        entityId: journal._id.toString()
      },
      senderName: userName
    });

    new ApiResponse({
      statusCode: 201,
      data: request,
      message: "Journal delete approval request created successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const updateJournalApprovalRequest = async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;

    if (!requestId || !status) {
      throw new AppError("requestId and status are required", 400, "updateJournalApprovalRequest");
    }

    if (!["approved", "rejected"].includes(status)) {
      throw new AppError("Invalid approval status", 400, "updateJournalApprovalRequest");
    }

    const approvalRequest = await getJournalApprovalRequestByIdRepo(requestId);
    if (!approvalRequest) {
      throw new AppError("Approval request not found", 404, "updateJournalApprovalRequest");
    }

    if (approvalRequest.status !== "pending") {
      throw new AppError("Approval request has already been processed", 400, "updateJournalApprovalRequest");
    }

    if (status === "approved") {
      if (approvalRequest.type === "delete") {
        await deleteJournalLinesByJournalRepo(approvalRequest.journalId);
        await deleteJournalRepo(approvalRequest.journalId);
      } else if (approvalRequest.type === "edit" && approvalRequest.requestedPayload) {
        const payload = { ...approvalRequest.requestedPayload };
        delete payload.companyId;
        delete payload.requestComment;
        await updateJournalRepo(approvalRequest.journalId, payload);
      }
    }

    const updatedRequest = await updateJournalApprovalRequestRepo(requestId, {
      status: status === "approved" ? "completed" : "rejected",
      ...(status === "approved"
        ? { approvedBy: req.user?.id, approvedAt: new Date(), completedAt: new Date() }
        : { rejectedBy: req.user?.id, rejectedAt: new Date() }),
    });

    new ApiResponse({
      statusCode: 200,
      data: updatedRequest,
      message: `Journal approval request ${status} successfully`,
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const reverseJournal = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new AppError("Journal ID is required", 400, "reverseJournal");
    }

    const originalJournal = await getJournalByIdRepo(id);
    if (!originalJournal) {
      throw new AppError("Original journal not found", 404, "reverseJournal");
    }

    if (originalJournal.isReversed) {
      throw new AppError("This journal has already been reversed", 400, "reverseJournal");
    }

    // Block reversal if it's an INVOICE journal with active payments
    if (originalJournal.sourceType === "INVOICE") {
      const Payment = await getPaymentModel();
      const activePayments = await Payment.countDocuments({
        invoiceId: originalJournal.sourceId,
        isReversed: false,
      });

      if (activePayments > 0) {
        throw new AppError(
          "Cannot reverse sales journal because the invoice has associated active payments. Reverse the payments first.",
          400,
          "reverseJournal"
        );
      }
    }

    // Prepare reversal data
    const reversalNumber = `REV-${originalJournal.number}`;

    const reversalData = {
      number: reversalNumber,
      voucherType: originalJournal.voucherType,
      date: new Date(), // Reversal happens now
      referenceNumber: originalJournal.number, // Link back to original
      externalDocNo: originalJournal.externalDocNo,
      narration: `Reversal of journal ${originalJournal.number}. ${originalJournal.narration || ""}`,
      companyId: originalJournal.companyId,
      sourceType: "REVERSAL",
      sourceId: originalJournal._id,
      partyName: originalJournal.partyName,
      totalDebit: originalJournal.totalCredit,
      totalCredit: originalJournal.totalDebit,
      status: "Posted",
      approvalStatus: "Approved",
      createdBy: req.user?.id,
    };

    const reversedJournal = await createJournalRepo(reversalData);

    const reversedLinesData = (originalJournal.lines || []).map((line) => ({
      journalId: reversedJournal._id,
      accountId: line.account?._id || line.accountId,
      accountCode: line.accountCode,
      accountName: line.accountName,
      companyId: originalJournal.companyId,
      debitAmount: line.creditAmount || 0,
      creditAmount: line.debitAmount || 0,
      description: `Reversal: ${line.description || ""}`,
      linkedToClientId: line.linkedToClientId,
      linkedToVendorId: line.linkedToVendorId,
      lineNumber: line.lineNumber,
    }));

    await createMultipleJournalLinesRepo(reversedLinesData);

    await createAuditLog({
      userId: req.user?.id,
      entityType: "Journal",
      entityId: reversedJournal._id,
      action: "REVERSE",
      changes: reversalData,
      companyId: originalJournal.companyId,
    });

    // Mark original as reversed
    await updateJournalRepo(id, { isReversed: true });

    // Handle Invoice Payment Reversal if sourceType is PAYMENT
    if (originalJournal.sourceType === "PAYMENT") {
      try {
        const Payment = await getPaymentModel();
        const payment = await Payment.findOne({ journalId: id }).lean();

        if (payment) {
          const invoice = await getInvoiceByIdRepo(payment.invoiceId);
          if (invoice) {
            // Roll back invoice paidAmount / remainingAmount / status
            const settledAmount = Number(payment.originalAmount || payment.amountPaid || 0);
            const tdsReversed = Number(payment.tdsAmount || 0);
            const newPaidAmount = Math.max(0, Number(invoice.paidAmount || 0) - settledAmount);
            const newTdsAmount = Math.max(0, Number(invoice.tdsAmount || 0) - tdsReversed);

            const invoiceSettlement = Number(invoice.invoiceAmount || invoice.amountDue || 0) - Number(invoice.tdsAmount || invoice.totalTDSAmount || 0);
            const newRemaining = Math.max(0, invoiceSettlement - newPaidAmount);

            let newStatus = invoice.status;
            if (newPaidAmount <= 0) {
              newStatus = "POSTED";
            } else if (newRemaining > 0.01) {
              newStatus = "PARTIALLY_PAID";
            } else {
              newStatus = "PAID";
            }

            // Update Invoice
            await updateInvoiceRepo(invoice._id, {
              paidAmount: newPaidAmount,
              tdsAmount: newTdsAmount,
              remainingAmount: newRemaining,
              status: newStatus,
              isFullyPaid: newRemaining < 0.01,
              updatedBy: req.user?.id,
            });

            // Update Payment Record
            await Payment.findByIdAndUpdate(payment._id, {
              isReversed: true,
              reversalJournalId: reversedJournal._id,
              status: "CANCELLED",
              updatedBy: req.user?.id,
            });

            // Audit Log for Payment Reversal
            await createAuditLog({
              companyId: originalJournal.companyId,
              entityType: "Payment",
              entityId: String(payment._id),
              action: "REVERSE_PAYMENT",
              userId: req.user?.id,
              changes: {
                reversalJournalId: reversedJournal._id,
                settledAmount,
                newPaidAmount,
                newStatus,
              },
              description: `Payment reversed via journal reversal for invoice ${invoice.invoiceNo}`,
            });
          }
        }
      } catch (err) {
        console.error("Error updating invoice/payment during journal reversal:", err);
        // We don't throw here to ensure the journal reversal itself is considered successful
        // as the journal entry has already been created.
      }
    }

    // Handle Invoice Sales Journal Reversal if sourceType is INVOICE
    if (originalJournal.sourceType === "INVOICE") {
      try {
        const invoice = await getInvoiceByIdRepo(originalJournal.sourceId);
        if (invoice) {
          // Update Invoice: Clear salesJournalId and set accountingStatus to pending
          await updateInvoiceRepo(invoice._id, {
            salesJournalId: null,
            accountingStatus: "pending",
            updatedBy: req.user?.id,
          });

          // Audit Log for Invoice Journal Reversal
          await createAuditLog({
            companyId: originalJournal.companyId,
            entityType: "Invoice",
            entityId: String(invoice._id),
            action: "REVERSE_SALES_JOURNAL",
            userId: req.user?.id,
            changes: {
              salesJournalId: null,
              accountingStatus: "pending",
              reversalJournalId: reversedJournal._id,
            },
            description: `Sales journal reversed for invoice ${invoice.invoiceNo}`,
          });
        }
      } catch (err) {
        console.error("Error updating invoice during sales journal reversal:", err);
      }
    }

    const finalJournal = await getJournalByIdRepo(reversedJournal._id);

    new ApiResponse({
      statusCode: 201,
      data: finalJournal,
      message: "Journal reversed successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

