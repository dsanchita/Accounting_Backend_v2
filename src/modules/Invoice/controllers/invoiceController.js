import ApiResponse from "../../../utils/ApiResponse.js";
import AppError from "../../../utils/AppError.js";
import { createAuditLog } from "../../../utils/createAuditLog.js";
import { transactionManager } from "../../../utils/transactionManager.js";
import path from "path";
import {
  createInvoiceRepo,
  getInvoiceByIdRepo,
  getInvoicesRepo,
  getInvoiceByNumberRepo,
  updateInvoiceRepo,
  deleteInvoiceRepo,
  getInvoicesByPORepo,
  getInvoicesByStatusRepo,
  getInvoicesByDateRangeRepo,
  getInvoicePendingApprovalRepo,
  getInvoiceStatsRepo,
  updateInvoicePaymentRepo,
  updateInvoiceAccountingStatusRepo,
  countInvoicesRepo,
} from "../repos/invoiceRepo.js";
import { createJournalRepo } from "../../Account/repos/journalRepo.js";
import { getAccountsRepo } from "../../Account/repos/accountRepo.js";
import { createMultipleJournalLinesRepo } from "../../Account/repos/journalLineRepo.js";
import { getPurchaseOrderByIdRepo, syncPurchaseOrderFromInvoicesRepo } from "../repos/purchaseOrderRepo.js";
import { findCompanyByIdRepo } from "../../company/repos/companyRepo.js";
import { exportInvoice, exportInvoiceList, prepareInvoiceData } from "../services/invoiceExportService.js";
import {
  generateWordDocument,
  generatePdfFromWord,
  sendDocumentResponse,
} from "../../../utils/documentGenerator.js";
import {
  sendInvoiceCreatedNotification,
  sendInvoiceApprovedNotification,
  sendInvoiceRejectedNotification,
  sendPaymentRecordedNotification,
} from "../services/notificationService.js";
import { notifyCompanyAdmins, emitNotification } from "../../../utils/notificationEmitter.js";
import {
  buildTaxMeta,
  normalizeLineItemTax,
  round2,
} from "../utils/taxNormalization.js";
import { postSalesJournalForInvoice } from "./invoiceAccountingController.js";

const toMongoId = (value) => value?._id || value || null;

const validateInvoiceItemQuantities = (items, origin) => {
  const invalidIndex = items.findIndex((item) => {
    const quantity = item?.quantity;
    return (
      quantity === undefined ||
      quantity === null ||
      String(quantity).trim() === "" ||
      !Number.isFinite(Number(quantity)) ||
      Number(quantity) <= 0
    );
  });

  if (invalidIndex !== -1) {
    throw new AppError(
      `Item ${invalidIndex + 1}: quantity is required and must be greater than 0`,
      400,
      origin
    );
  }
};

const toPlainObject = (doc) => JSON.parse(JSON.stringify(doc || {}));

const getChangedFields = (oldDoc = {}, nextData = {}) =>
  Object.keys(nextData)
    .filter((key) => !["updateHistory", "approvalHistory", "rejectionHistory"].includes(key))
    .filter((key) => JSON.stringify(oldDoc?.[key]) !== JSON.stringify(nextData?.[key]))
    .map((key) => ({
      field: key,
      oldValue: oldDoc?.[key],
      newValue: nextData?.[key],
    }));

import { getInvoiceModel } from "../models/Invoice.js";

const generateInvoiceNumber = async (companyId, invoiceDate = new Date()) => {
  try {
    const date = new Date(invoiceDate);
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const dateStr = `${yy}${mm}${dd}`;

    const Invoice = await getInvoiceModel();
    const count = await Invoice.countDocuments({ companyId });
    const counter = 51438 + count;

    let invoiceNo = `INV-${dateStr}-${counter}`;

    // Ensure uniqueness in case of race condition or existing invoice
    let exists = await Invoice.findOne({ invoiceNo, companyId });
    let attempts = 0;
    while (exists && attempts < 100) {
      attempts++;
      invoiceNo = `INV-${dateStr}-${counter + attempts}`;
      exists = await Invoice.findOne({ invoiceNo, companyId });
    }

    return invoiceNo;
  } catch (error) {
    console.error("Error generating invoice number:", error);
    const date = new Date();
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `INV-${yy}${mm}${dd}-${Date.now().toString().slice(-5)}`;
  }
};

const generateJournalNumber = (companyId) => {
  const timestamp = Date.now();
  return `JRN-${companyId.toString().slice(-4)}-${timestamp}`;
};

const normalizeStateCode = (value = "") => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "";
  const digitMatch = normalized.match(/^(\d{2})/);
  if (digitMatch) return digitMatch[1];
  const alphaMatch = normalized.match(/^([A-Z]{2})/);
  return alphaMatch ? alphaMatch[1] : normalized;
};

const getGstSplit = (fromAddress = {}, toAddress = {}) => {
  const fromStateCode = normalizeStateCode(fromAddress?.stateCode);
  const toStateCode = normalizeStateCode(toAddress?.stateCode);

  if (!fromStateCode || !toStateCode) return undefined;
  return fromStateCode === toStateCode ? "INTRA" : "INTER";
};

const getCompanyStateCode = (company = {}) =>
  normalizeStateCode(company?.taxDetails?.gstin || company?.registeredAddress?.stateCode);

const getPartyStateCode = (party = {}) =>
  normalizeStateCode(party?.stateCode || party?.gstStateCode || party?.GSTIN || party?.gstin);

const getCompanyBasedGstSplit = (company = {}, party = {}) => {
  const companyStateCode = getCompanyStateCode(company);
  const partyStateCode = getPartyStateCode(party);

  if (!companyStateCode || !partyStateCode) return undefined;
  return companyStateCode === partyStateCode ? "INTRA" : "INTER";
};

const getInvoiceGstSplit = (company = {}, billTo = {}, shipTo = {}) => {
  // Ship-to is the editable place-of-supply address in the invoice UI. Prefer
  // it over bill-to/linked PO data so backend persistence matches the preview.
  return (
    getCompanyBasedGstSplit(company, shipTo) ||
    getCompanyBasedGstSplit(company, billTo) ||
    getGstSplit(billTo, shipTo)
  );
};

const findTaxPayableAccount = (accounts = [], preferredType = "GST") => {
  const normalizedType = String(preferredType || "GST").trim().toUpperCase();
  const desiredName = `${normalizedType.toLowerCase()} payable`;

  return (
    accounts.find((acc) => acc.name?.toLowerCase() === desiredName) ||
    accounts.find((acc) => acc.name?.toLowerCase().includes(desiredName)) ||
    accounts.find((acc) => acc.name?.toLowerCase().includes(`${normalizedType.toLowerCase()} output`)) ||
    accounts.find((acc) => acc.name?.toLowerCase().includes("gst payable")) ||
    accounts.find((acc) => acc.name?.toLowerCase().includes("output gst")) ||
    accounts.find((acc) => acc.name?.toLowerCase() === "gst") ||
    null
  );
};

const getMatchedPoItem = (po, item = {}) => {
  const poItems = Array.isArray(po?.items) ? po.items : [];
  const requestedKeys = [
    item.poItemId,
    item.itemId,
    item._id?.toString?.(),
    item.description,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  return (
    poItems.find((poItem) => {
      const poKeys = [
        poItem.itemId,
        poItem._id?.toString?.(),
        poItem.description,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase());

      return requestedKeys.some((key) => poKeys.includes(key));
    }) || null
  );
};

const ensureSalesJournalForInvoice = async (invoice, userId) => {
  if (!invoice || invoice.salesJournalId) {
    return invoice?.salesJournalId || null;
  }

  // 1. Fetch Company-specific Accounts to find the correct ledgers
  const accounts = await getAccountsRepo({ companyId: String(invoice.companyId) });
  
  // Find Client Account (Accounts Receivable)
  // We try to match by linkedClientId if available, or by name as a fallback
  const clientAccount = accounts.find(acc => 
    (acc.linkedClientId && String(acc.linkedClientId) === String(invoice.billTo?._id)) || 
    (acc.partyName && acc.partyName.toLowerCase() === invoice.billTo?.name?.toLowerCase()) ||
    (acc.name && acc.name.toLowerCase() === invoice.billTo?.name?.toLowerCase())
  );
  
  // Find Sales Account
  const salesAccount = accounts.find(acc => acc.name.toLowerCase().includes("sales"));

  // Find TDS Receivable Account
  const tdsAccount = accounts.find(acc => 
    acc.name.toLowerCase().includes("tds receivable") || 
    acc.name.toLowerCase().includes("tds on sale") ||
    acc.name.toLowerCase() === "tds"
  );

  // If critical accounts are missing, we log but continue (or we could throw error)
  // For now, we proceed if we have at least client and sales
  if (!clientAccount || !salesAccount) {
    console.warn(`[ensureSalesJournalForInvoice] Missing critical accounts for invoice ${invoice.invoiceNo}. Client Account: ${!!clientAccount}, Sales Account: ${!!salesAccount}`);
  }

  const taxableValue = Number(invoice.totalTaxableValue || 0);
  const totalGST = Number(invoice.totalGSTAmount || 0);
  const totalCGST = Number(invoice.totalCGSTAmount || 0);
  const totalSGST = Number(invoice.totalSGSTAmount || 0);
  const totalIGST = Number(invoice.totalIGSTAmount || 0);
  const tdsAmount = Number(invoice.tdsAmount || 0);
  // Net Receivable = Taxable + GST - TDS
  const netReceivable = taxableValue + totalGST - tdsAmount;

  const journalNumber = generateJournalNumber(invoice.companyId);

  // 3. Create Journal Header
  const journalData = {
    number: journalNumber,
    voucherType: "SALES",
    date: invoice.invoiceDate || new Date(),
    referenceNumber: invoice.invoiceNo,
    externalDocNo: invoice.poNumber || invoice.linkedPO?.poNumber || "",
    narration: `Sales posting for invoice ${invoice.invoiceNo}`,
    companyId: String(invoice.companyId),
    sourceType: "INVOICE",
    sourceId: String(invoice._id),
    partyName: invoice.billTo?.name || "",
    totalDebit: taxableValue + totalGST, // Total debits (Receivable + TDS)
    totalCredit: taxableValue + totalGST, // Total credits (Sales + GST)
    status: "Approved",
    approvalStatus: "Approved",
    approvedBy: userId,
    approvalDate: new Date(),
    createdBy: userId,
    updatedBy: userId,
  };

  const journal = await createJournalRepo(journalData);

  if (journal) {
    // 4. Prepare Journal Lines
    const journalLines = [];
    let lineNumber = 1;

    // Dr. Accounts Receivable (Net Amount)
    if (clientAccount) {
      journalLines.push({
        journalId: journal._id,
        accountId: clientAccount._id,
        accountCode: clientAccount.code,
        accountName: clientAccount.name,
        companyId: String(invoice.companyId),
        debitAmount: netReceivable,
        creditAmount: 0,
        description: `Receivable for INV ${invoice.invoiceNo} from ${invoice.billTo?.name}`,
        lineNumber: lineNumber++,
      });
    }

    // Dr. TDS Receivable
    if (tdsAmount > 0 && tdsAccount) {
      journalLines.push({
        journalId: journal._id,
        accountId: tdsAccount._id,
        accountCode: tdsAccount.code,
        accountName: tdsAccount.name,
        companyId: String(invoice.companyId),
        debitAmount: tdsAmount,
        creditAmount: 0,
        description: `TDS deducted on INV ${invoice.invoiceNo}`,
        lineNumber: lineNumber++,
      });
    }

    // Cr. Sales (Taxable Value)
    if (salesAccount) {
      journalLines.push({
        journalId: journal._id,
        accountId: salesAccount._id,
        accountCode: salesAccount.code,
        accountName: salesAccount.name,
        companyId: String(invoice.companyId),
        debitAmount: 0,
        creditAmount: taxableValue,
        description: `Sales revenue from INV ${invoice.invoiceNo}`,
        lineNumber: lineNumber++,
      });
    }

    const taxLines = [
      { type: "CGST", amount: totalCGST },
      { type: "SGST", amount: totalSGST },
      { type: "IGST", amount: totalIGST },
    ].filter((entry) => entry.amount > 0);

    if (taxLines.length === 0 && totalGST > 0) {
      taxLines.push({ type: "GST", amount: totalGST });
    }

    for (const taxLine of taxLines) {
      const gstAccount = findTaxPayableAccount(accounts, taxLine.type);
      if (!gstAccount) continue;
      journalLines.push({
        journalId: journal._id,
        accountId: gstAccount._id,
        accountCode: gstAccount.code,
        accountName: gstAccount.name,
        companyId: String(invoice.companyId),
        debitAmount: 0,
        creditAmount: taxLine.amount,
        description: `${taxLine.type} payable on INV ${invoice.invoiceNo}`,
        lineNumber: lineNumber++,
      });
    }

    if (journalLines.length > 0) {
      await createMultipleJournalLinesRepo(journalLines);
    }
  }

  return journal?._id || null;
};

export const createInvoice = async (req, res, next) => {
  try {
    const {
      linkedPO,
      invoiceDate,
      dueDate,
      billTo,
      shipTo,
      items,
      companyId,
      notes,
      totalTaxableValue: bodyTaxableValue,
      totalCGSTAmount: bodyCGST,
      totalSGSTAmount: bodySGST,
      totalIGSTAmount: bodyIGST,
      totalGSTAmount: bodyGST,
      totalTaxAmount: bodyTotalTaxAmount,
      taxType: bodyTaxType,
      taxLabel: bodyTaxLabel,
      taxSummary: bodyTaxSummary,
      invoiceAmount: bodyInvoiceAmount,
      tdsAmount: bodyTDS,
      netPayable: bodyNetPayable,
      valueInWords: bodyValueInWords,
      milestones,
      deliveryMilestones,
      contractWorklog,
      paymentSchedules,
      monthlyBillingInfo,
    } = req.body;

    if (!invoiceDate || !dueDate || !billTo || !shipTo || !items || items.length === 0 || !companyId) {
      throw new AppError(
        "Missing required fields: invoiceDate, dueDate, billTo, shipTo, items, companyId",
        400,
        "createInvoice"
      );
    }

    if (!Array.isArray(items)) {
      throw new AppError("Invoice items must be an array", 400, "createInvoice");
    }
    validateInvoiceItemQuantities(items, "createInvoice");

    const [linkedPOData, company] = await Promise.all([
      linkedPO ? getPurchaseOrderByIdRepo(linkedPO) : Promise.resolve(null),
      companyId ? findCompanyByIdRepo(companyId) : Promise.resolve(null),
    ]);

    if (linkedPO && linkedPOData?.approvalStatus !== "Approved") {
      throw new AppError("Invoice can be created only for approved purchase orders", 400, "createInvoice");
    }
    const effectiveBillTo = billTo || linkedPOData?.vendor;
    const effectiveShipTo = shipTo || linkedPOData?.deliverTo;
    const gstSplit = getInvoiceGstSplit(company, effectiveBillTo, effectiveShipTo);

    let totalTaxableValue = 0;
    let invoiceAmount = 0;
    const normalizedItems = items.map((item) => {
      const matchedPOItem = getMatchedPoItem(linkedPOData, item);
      const sourceItem = {
        ...(matchedPOItem || {}),
        ...item,
      };
      const normalizedTax = normalizeLineItemTax(sourceItem, {
        taxType: bodyTaxType || linkedPOData?.taxType || matchedPOItem?.taxType || item.taxType || "GST",
        taxLabel: bodyTaxLabel || linkedPOData?.taxLabel || matchedPOItem?.taxLabel || item.taxLabel || "GST",
        taxRate: matchedPOItem?.taxRate ?? matchedPOItem?.gstRate ?? item.gstRate ?? item.taxRate,
        taxAmount: matchedPOItem?.taxAmount ?? matchedPOItem?.gstAmount ?? item.gstAmount ?? item.taxAmount,
        gstRate: matchedPOItem?.gstRate ?? item.gstRate,
        gstAmount: matchedPOItem?.gstAmount ?? item.gstAmount,
        amount: matchedPOItem?.taxAmount ?? matchedPOItem?.gstAmount ?? item.gstAmount ?? item.taxAmount,
        rate: matchedPOItem?.taxRate ?? matchedPOItem?.gstRate ?? item.gstRate ?? item.taxRate,
        gstSplit,
      });
      const taxableValue = Number(item.taxableValue ?? matchedPOItem?.taxableValue ?? 0);
      const lineTotalAmount =
        Number(item.totalAmount || item.total || 0) ||
        round2(taxableValue + Number(normalizedTax.taxAmount || 0));

      totalTaxableValue += taxableValue;
      invoiceAmount += lineTotalAmount;
      return {
        ...sourceItem,
        poItemId: item.poItemId || item.itemId || matchedPOItem?.itemId || matchedPOItem?._id,
        totalAmount: lineTotalAmount,
        taxableValue,
        ...normalizedTax,
      };
    });
    const taxMeta = buildTaxMeta({
      taxType: bodyTaxType || linkedPOData?.taxType,
      taxLabel: bodyTaxLabel || linkedPOData?.taxLabel,
      taxSummary: undefined,
      totalTaxAmount: undefined,
      items: normalizedItems,
    });

    const invoiceNumber = await generateInvoiceNumber(companyId, invoiceDate);
    const normalizedMilestones = Array.isArray(milestones)
      ? milestones.map((milestone, index) => ({
        ...milestone,
        milestoneId: milestone.milestoneId || milestone._id,
        milestoneIndex: Number(milestone.milestoneIndex ?? index),
        milestoneNo: Number(
          milestone.milestoneNo ??
          (Number(milestone.milestoneIndex ?? index) + 1)
        ),
        description: milestone.description || milestone.title || `Milestone ${index + 1}`,
        targetAmount: Number(
          milestone.targetAmount ??
          milestone.originalAmount ??
          milestone.remainingAmountBefore ??
          milestone.amount ??
          0
        ),
        invoiceAmount: Number(
          milestone.invoiceAmount ??
          milestone.invoicedAmount ??
          milestone.amount ??
          0
        ),
        amount: Number(milestone.amount ?? milestone.invoiceAmount ?? 0),
        invoicedAmount: Number(milestone.invoicedAmount ?? milestone.invoiceAmount ?? milestone.amount ?? 0),
      }))
      : [];

    const invoiceData = {
      companyId,
      invoiceNo: invoiceNumber,
      linkedPO: linkedPO ? toMongoId(linkedPO) : null,
      poNumber: req.body.poNumber || linkedPOData?.poNumber || req.body.linkedPORef || req.body.poreferencevalue || "",
      invoiceDate: new Date(invoiceDate),
      dueDate: new Date(dueDate),
      billTo,
      shipTo,
      items: normalizedItems,
      totalTaxableValue: bodyTaxableValue ?? round2(totalTaxableValue),
      taxType: taxMeta.taxType,
      taxLabel: taxMeta.taxLabel,
      taxSummary: taxMeta.taxSummary,
      totalTaxAmount: taxMeta.totalTaxAmount,
      totalCGSTAmount: taxMeta.totalCGSTAmount,
      totalSGSTAmount: taxMeta.totalSGSTAmount,
      totalIGSTAmount: taxMeta.totalIGSTAmount,
      totalGSTAmount: taxMeta.totalGSTAmount,
      invoiceAmount: bodyInvoiceAmount ?? round2(invoiceAmount),
      amountDue: bodyInvoiceAmount ?? round2(invoiceAmount),
      netPayable: bodyNetPayable ?? round2(invoiceAmount),
      remainingAmount: bodyInvoiceAmount ?? round2(invoiceAmount),
      tdsAmount: bodyTDS || 0,
      valueInWords: bodyValueInWords || `${invoiceAmount} only`,
      milestones: normalizedMilestones,
      deliveryMilestones: Array.isArray(deliveryMilestones) ? deliveryMilestones : [],
      contractWorklog: Array.isArray(contractWorklog) ? contractWorklog : [],
      paymentSchedules: Array.isArray(paymentSchedules) ? paymentSchedules : [],
      ...(monthlyBillingInfo && { monthlyBillingInfo }),
      notes,
      actionType: "create",
      createdBy: req.user?.id,
      updatedBy: req.user?.id,
    };

    const invoice = await createInvoiceRepo(invoiceData);

    // If linked to PO, update PO with invoice reference
    if (invoiceData.linkedPO) {
      await syncPurchaseOrderFromInvoicesRepo(invoiceData.linkedPO, req.user?.id);
    }

    await createAuditLog({
      companyId,
      entityType: "Invoice",
      entityId: invoice._id,
      action: "CREATE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: invoiceData,
      module: "INVOICE",
      description: `Invoice created: ${invoice.invoiceNo}`,
    });
    
    // IN-APP NOTIFICATION: Notify company admins about new invoice
    const userName = req.user?.name || "System User";
    notifyCompanyAdmins({
      companyId: invoiceData.companyId,
      title: "New Invoice Created",
      message: `Invoice ${invoice.invoiceNo} has been created by ${userName} and is pending approval.`,
      type: "APPROVAL_REQUEST",
      relatedEntity: {
        entityType: "INVOICE",
        entityId: invoice._id.toString()
      },
      senderName: userName
    });

    new ApiResponse({
      statusCode: 201,
      data: invoice,
      message: "Invoice created successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getAllInvoices = async (req, res, next) => {
  try {
    const {
      companyId,
      status,
      approvalStatus,
      startDate,
      endDate,
      invoiceDateFrom,
      invoiceDateTo,
      invoiceNo,
      clientName,
      paymentStatus,
      journalPosted,
      createdBy,
      createdAtFrom,
      createdAtTo,
      salesJournalPostedAtFrom,
      salesJournalPostedAtTo,
      page,
      limit,
    } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getAllInvoices");
    }

    const filter = { companyId };
    if (status) filter.status = status;
    if (approvalStatus) {
      if (approvalStatus.includes(",")) {
        filter.approvalStatus = { $in: approvalStatus.split(",").map((s) => s.trim()) };
      } else {
        filter.approvalStatus = approvalStatus;
      }
    }

    // Advanced Filters
    if (invoiceNo) filter.invoiceNo = { $regex: invoiceNo, $options: "i" };
    if (clientName) filter["billTo.name"] = { $regex: clientName, $options: "i" };
    if (createdBy) filter.createdBy = createdBy;

    if (paymentStatus) {
      if (paymentStatus === "fully_paid") filter.status = { $in: ["PAID", "RECONCILED"] };
      else if (paymentStatus === "partially_paid") filter.status = "PARTIALLY_PAID";
      else if (paymentStatus === "unpaid") filter.status = "POSTED";
    }

    if (journalPosted === "yes") filter.salesJournalId = { $exists: true, $ne: null };
    else if (journalPosted === "no") filter.salesJournalId = null;

    // Date Range Filters
    const applyDateRange = (field, from, to) => {
      if (from || to) {
        if (!filter[field]) filter[field] = {};
        if (from) filter[field].$gte = new Date(from);
        if (to) filter[field].$lte = new Date(to);
      }
    };

    // Use specific range if available, fallback to generic startDate/endDate for invoiceDate
    applyDateRange("invoiceDate", invoiceDateFrom || startDate, invoiceDateTo || endDate);
    applyDateRange("createdAt", createdAtFrom, createdAtTo);
    applyDateRange("approvalDate", salesJournalPostedAtFrom, salesJournalPostedAtTo);


    const pageNo = Math.max(1, Number(page || 1));
    const pageLimit = Math.max(0, Number(limit || 0));

    const [invoices, total] = await Promise.all([
      getInvoicesRepo(filter, {
        limit: pageLimit,
        skip: pageLimit > 0 ? (pageNo - 1) * pageLimit : 0,
        sort: { createdAt: -1 }, // Ensure newest first
      }),
      countInvoicesRepo(filter),
    ]);

    new ApiResponse({
      statusCode: 200,
      data: invoices,
      meta: {
        total,
        page: pageNo,
        limit: pageLimit,
        totalPages: pageLimit > 0 ? Math.ceil(total / pageLimit) : 1,
      },
      message: "Invoices retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getInvoiceById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "getInvoiceById");
    }

    const invoice = await getInvoiceByIdRepo(id);

    new ApiResponse({
      statusCode: 200,
      data: invoice,
      message: "Invoice retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const updateInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "updateInvoice");
    }

    const oldInvoice = await getInvoiceByIdRepo(id);
    const [linkedPOData, company] = await Promise.all([
      oldInvoice?.linkedPO ? getPurchaseOrderByIdRepo(oldInvoice.linkedPO) : Promise.resolve(null),
      oldInvoice?.companyId ? findCompanyByIdRepo(oldInvoice.companyId) : Promise.resolve(null),
    ]);

    let normalizedUpdateData = { ...updateData };
    if (normalizedUpdateData.linkedPO !== undefined) {
      normalizedUpdateData.linkedPO = normalizedUpdateData.linkedPO ? toMongoId(normalizedUpdateData.linkedPO) : null;
    }
    if (Array.isArray(normalizedUpdateData.items) || Array.isArray(normalizedUpdateData.taxSummary)) {
      if (Array.isArray(normalizedUpdateData.items)) {
        const effectiveBillTo = normalizedUpdateData.billTo || oldInvoice.billTo || linkedPOData?.vendor;
        const effectiveShipTo = normalizedUpdateData.shipTo || oldInvoice.shipTo || linkedPOData?.deliverTo;
        const gstSplit = getInvoiceGstSplit(company, effectiveBillTo, effectiveShipTo);
        normalizedUpdateData.items = normalizedUpdateData.items.map((item) => ({
          ...item,
          totalAmount: Number(item.totalAmount || item.total || 0),
          ...normalizeLineItemTax(item, {
            taxType: normalizedUpdateData.taxType || oldInvoice.taxType,
            taxLabel: normalizedUpdateData.taxLabel || oldInvoice.taxLabel,
            gstSplit,
          }),
        }));
      }
      const hasUpdatedItems = Array.isArray(normalizedUpdateData.items);
      const taxMeta = buildTaxMeta({
        taxType: normalizedUpdateData.taxType || oldInvoice.taxType,
        taxLabel: normalizedUpdateData.taxLabel || oldInvoice.taxLabel,
        taxSummary: hasUpdatedItems ? undefined : normalizedUpdateData.taxSummary,
        totalTaxAmount: hasUpdatedItems ? undefined : normalizedUpdateData.totalTaxAmount,
        items: normalizedUpdateData.items || oldInvoice.items || [],
      });
      normalizedUpdateData = {
        ...normalizedUpdateData,
        taxType: taxMeta.taxType,
        taxLabel: taxMeta.taxLabel,
        taxSummary: taxMeta.taxSummary,
        totalTaxAmount: taxMeta.totalTaxAmount,
        totalGSTAmount: taxMeta.totalGSTAmount,
        totalCGSTAmount: taxMeta.totalCGSTAmount,
        totalSGSTAmount: taxMeta.totalSGSTAmount,
        totalIGSTAmount: taxMeta.totalIGSTAmount,
      };
    }

    const updatedInvoice = await updateInvoiceRepo(id, {
      ...normalizedUpdateData,
      actionType: "update",
      approvalStatus: "Pending",
      approvedBy: null,
      approvalDate: null,
      rejectionReason: null,
      rejectedBy: null,
      rejectedAt: null,
      updateHistory: [
        ...(oldInvoice.updateHistory || []),
        {
          snapshot: toPlainObject(oldInvoice),
          changes: getChangedFields(oldInvoice, normalizedUpdateData),
          updatedBy: req.user?.id,
          updatedAt: new Date(),
        },
      ],
      approvalHistory: [
        ...(oldInvoice.approvalHistory || []),
        {
          status: "Pending",
          action: oldInvoice.approvalStatus === "Rejected" ? "RESUBMIT" : "UPDATE_SUBMIT",
          comments:
            oldInvoice.approvalStatus === "Rejected"
              ? "Rejected invoice edited and resubmitted for approval"
              : "Invoice update submitted for approval",
          performedBy: req.user?.id,
          performedAt: new Date(),
        },
      ],
      updatedBy: req.user?.id,
    });

    const poIdsToSync = new Set(
      [oldInvoice?.linkedPO, updatedInvoice?.linkedPO]
        .filter(Boolean)
        .map((poId) => String(poId?._id || poId))
    );
    for (const poId of poIdsToSync) {
      await syncPurchaseOrderFromInvoicesRepo(poId, req.user?.id);
    }

    await createAuditLog({
      companyId: oldInvoice.companyId,
      entityType: "Invoice",
      entityId: id,
      action: "UPDATE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: normalizedUpdateData,
      oldValues: oldInvoice,
      module: "INVOICE",
      description: `Invoice updated: ${oldInvoice.invoiceNo}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: updatedInvoice,
      message: "Invoice updated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const deleteInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "deleteInvoice");
    }

    const invoice = await getInvoiceByIdRepo(id);

    await deleteInvoiceRepo(id);

    // Update PO to remove invoice reference
    if (invoice.linkedPO) {
      await syncPurchaseOrderFromInvoicesRepo(invoice.linkedPO, req.user?.id);
    }

    await createAuditLog({
      companyId: invoice.companyId,
      entityType: "Invoice",
      entityId: id,
      action: "DELETE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: invoice,
      module: "INVOICE",
      description: `Invoice deleted: ${invoice.invoiceNo}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: null,
      message: "Invoice deleted successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getInvoiceByNumber = async (req, res, next) => {
  try {
    const { invoiceNo, companyId } = req.query;

    if (!invoiceNo || !companyId) {
      throw new AppError("invoiceNo and companyId are required", 400, "getInvoiceByNumber");
    }

    const invoice = await getInvoiceByNumberRepo(invoiceNo, companyId);

    new ApiResponse({
      statusCode: 200,
      data: invoice,
      message: "Invoice retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getInvoicesByPO = async (req, res, next) => {
  try {
    const { poId } = req.params;

    if (!poId) {
      throw new AppError("Purchase Order ID is required", 400, "getInvoicesByPO");
    }

    const invoices = await getInvoicesByPORepo(poId);

    new ApiResponse({
      statusCode: 200,
      data: invoices,
      message: "Invoices for Purchase Order retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getInvoiceStats = async (req, res, next) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getInvoiceStats");
    }

    const stats = await getInvoiceStatsRepo(companyId);

    new ApiResponse({
      statusCode: 200,
      data: stats,
      message: "Invoice statistics retrieved successfully",
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

    const invoices = await getInvoicePendingApprovalRepo(companyId);

    new ApiResponse({
      statusCode: 200,
      data: invoices,
      message: "Pending invoices retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const approveInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { approvalComments } = req.body;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "approveInvoice");
    }

    const invoice = await getInvoiceByIdRepo(id);
    const accountingResult = await postSalesJournalForInvoice(
      id,
      req.user?.id,
      req.user || {},
      { allowPendingApproval: true }
    );
    const salesJournalId =
      toMongoId(accountingResult?.journal) ||
      toMongoId(accountingResult?.invoice?.salesJournalId) ||
      toMongoId(invoice.salesJournalId);

    const updateData = {
      approvalStatus: "Approved",
      status: "POSTED",
      salesJournalId,
      debtorAccountId: toMongoId(accountingResult?.ledger) || toMongoId(invoice.debtorAccountId),
      revenueAccountId:
        toMongoId(accountingResult?.invoice?.revenueAccountId) ||
        toMongoId(invoice.revenueAccountId),
      taxAccountId:
        toMongoId(accountingResult?.invoice?.taxAccountId) ||
        toMongoId(invoice.taxAccountId),
      accountingStatus: salesJournalId ? "completed" : invoice.accountingStatus || "pending",
      approvedBy: req.user?.id,
      approvalDate: new Date(),
      approvalComments,
      rejectionReason: null,
      rejectedBy: null,
      rejectedAt: null,
      approvalHistory: [
        ...(invoice.approvalHistory || []),
        {
          status: "Approved",
          action: "APPROVE",
          comments: approvalComments,
          performedBy: req.user?.id,
          performedAt: new Date(),
        },
      ],
      updatedBy: req.user?.id,
    };

    const approvedInvoice = await updateInvoiceRepo(id, updateData);

    await createAuditLog({
      companyId: invoice.companyId,
      entityType: "Invoice",
      entityId: id,
      action: "APPROVE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: updateData,
      module: "INVOICE",
      description: `Invoice approved: ${invoice.invoiceNo}`,
    });
    
    // IN-APP NOTIFICATION: Notify the original creator
    const userName = req.user?.name || "System User";
    if (invoice.createdBy) {
      emitNotification({
        companyId: invoice.companyId || req.companyId || req.user?.company?._id || req.user?.companyId,
        recipientId: invoice.createdBy.toString(),
        title: "Invoice Approved",
        message: `Your invoice ${invoice.invoiceNo} has been approved by ${userName}.`,
        type: "APPROVED",
        relatedEntity: {
          entityType: "INVOICE",
          entityId: invoice._id.toString()
        },
        senderName: userName
      });
    }

    new ApiResponse({
      statusCode: 200,
      data: approvedInvoice,
      message: "Invoice approved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const rejectInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { approvalComments, rejectionReason } = req.body;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "rejectInvoice");
    }

    const reason = String(rejectionReason || approvalComments || "").trim();
    if (!reason) {
      throw new AppError("Rejection reason is required", 400, "rejectInvoice");
    }

    const invoice = await getInvoiceByIdRepo(id);

    const updateData = {
      approvalStatus: "Rejected",
      status: "PENDING_APPROVAL",
      approvedBy: req.user?.id,
      approvalDate: new Date(),
      approvalComments: reason,
      rejectionReason: reason,
      rejectedBy: req.user?.id,
      rejectedAt: new Date(),
      approvalHistory: [
        ...(invoice.approvalHistory || []),
        {
          status: "Rejected",
          action: "REJECT",
          reason,
          comments: reason,
          performedBy: req.user?.id,
          performedAt: new Date(),
        },
      ],
      rejectionHistory: [
        ...(invoice.rejectionHistory || []),
        {
          status: "Rejected",
          action: "REJECT",
          reason,
          comments: reason,
          performedBy: req.user?.id,
          performedAt: new Date(),
        },
      ],
      updatedBy: req.user?.id,
    };

    const rejectedInvoice = await updateInvoiceRepo(id, updateData);

    await createAuditLog({
      companyId: invoice.companyId,
      entityType: "Invoice",
      entityId: id,
      action: "REJECT",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: updateData,
      module: "INVOICE",
      description: `Invoice rejected: ${invoice.invoiceNo}`,
    });
    
    // IN-APP NOTIFICATION: Notify the original creator
    const userName = req.user?.name || "System User";
    if (invoice.createdBy) {
      emitNotification({
        companyId: invoice.companyId || req.companyId || req.user?.company?._id || req.user?.companyId,
        recipientId: invoice.createdBy.toString(),
        title: "Invoice Rejected",
        message: `Your invoice ${invoice.invoiceNo} has been rejected by ${userName}. Reason: ${reason}`,
        type: "REJECTED",
        relatedEntity: {
          entityType: "INVOICE",
          entityId: invoice._id.toString()
        },
        senderName: userName
      });
    }

    new ApiResponse({
      statusCode: 200,
      data: rejectedInvoice,
      message: "Invoice rejected successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const recordPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { paidAmount, tdsAmount, paymentDate, reference } = req.body;

    const normalizedPaidAmount = Number(paidAmount || 0);
    const normalizedTdsAmount = Number(tdsAmount || 0);

    if (!id || (normalizedPaidAmount <= 0 && normalizedTdsAmount <= 0)) {
      throw new AppError("Invoice ID and payment amount or TDS amount are required", 400, "recordPayment");
    }

    const invoice = await getInvoiceByIdRepo(id);

    const updatedInvoice = await updateInvoicePaymentRepo(id, normalizedPaidAmount, normalizedTdsAmount);

    await createAuditLog({
      companyId: invoice.companyId,
      entityType: "Invoice",
      entityId: id,
      action: "UPDATE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: {
        paidAmount,
        tdsAmount: normalizedTdsAmount,
        paymentDate,
        reference,
      },
      module: "INVOICE",
      description: `Payment recorded on Invoice: ${invoice.invoiceNo}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: updatedInvoice,
      message: "Payment recorded successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const postSalesJournal = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "postSalesJournal");
    }

    const result = await postSalesJournalForInvoice(id, req.user?.id, req.user || {});

    new ApiResponse({
      statusCode: 200,
      data: result.invoice,
      message: result.alreadyPosted
        ? "Sales journal already posted for this invoice"
        : "Sales journal posted successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const exportInvoiceById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { format = "pdf" } = req.query;

    if (!["pdf", "word", "both"].includes(format)) {
      throw new AppError("Invalid export format. Use: pdf, word, both", 400, "exportInvoiceById");
    }

    const invoice = await getInvoiceByIdRepo(id);
    if (!invoice) {
      throw new AppError("Invoice not found", 404, "exportInvoiceById");
    }

    const result = await exportInvoice(invoice, format, "./uploads/exports");

    // Audit log
    await createAuditLog({
      companyId: invoice.companyId,
      entityType: "Invoice",
      entityId: invoice._id,
      action: "EXPORT",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { format },
      module: "INVOICE",
      description: `Invoice ${invoice.invoiceNo} exported as ${format}`,
    });

    if (format === "pdf" && result?.files?.pdfPath) {
      return res.download(
        path.resolve(result.files.pdfPath),
        result.files.pdfFileName,
      );
    }

    if (format === "word" && result?.files?.wordPath) {
      return res.download(
        path.resolve(result.files.wordPath),
        result.files.wordFileName,
      );
    }

    new ApiResponse({
      statusCode: 200,
      data: result,
      message: `Invoice exported successfully as ${format}`,
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const exportInvoiceListEndpoint = async (req, res, next) => {
  try {
    const { companyId } = req.query;
    const { format = "csv" } = req.query;

    if (!companyId) {
      throw new AppError("Company ID is required", 400, "exportInvoiceListEndpoint");
    }

    if (!["csv", "pdf"].includes(format)) {
      throw new AppError("Invalid export format. Use: csv, pdf", 400, "exportInvoiceListEndpoint");
    }

    const invoices = await getInvoicesRepo(companyId);

    if (!invoices || invoices.length === 0) {
      throw new AppError("No invoices found to export", 404, "exportInvoiceListEndpoint");
    }

    const result = await exportInvoiceList(invoices, format, "./uploads/exports");

    // Audit log
    await createAuditLog({
      companyId,
      entityType: "Invoice",
      action: "EXPORT",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: { format, count: invoices.length },
      description: `Exported ${invoices.length} invoices as ${format}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: result,
      message: `${invoices.length} invoices exported successfully`,
    }).send(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Create invoice with automatic journal entry using cross-database transaction
 * Ensures ACID compliance across invoice_db and accounting_db
 */
export const createInvoiceWithJournal = async (req, res, next) => {
  try {
    const {
      linkedPO,
      invoiceDate,
      dueDate,
      billTo,
      shipTo,
      items,
      companyId,
      notes,
      createJournalEntry = false,
      journalDescription,
      monthlyBillingInfo,
    } = req.body;

    if (!invoiceDate || !dueDate || !billTo || !shipTo || !items || items.length === 0 || !companyId) {
      throw new AppError(
        "Missing required fields: invoiceDate, dueDate, billTo, shipTo, items, companyId",
        400,
        "createInvoiceWithJournal"
      );
    }

    if (!Array.isArray(items)) {
      throw new AppError("Invoice items must be an array", 400, "createInvoiceWithJournal");
    }
    validateInvoiceItemQuantities(items, "createInvoiceWithJournal");

    if (linkedPO) {
      const linkedPOData = await getPurchaseOrderByIdRepo(linkedPO);
      if (linkedPOData?.approvalStatus !== "Approved") {
        throw new AppError("Invoice can be created only for approved purchase orders", 400, "createInvoiceWithJournal");
      }
    }

    // Calculate totals
    let totalTaxableValue = 0;
    let totalCGSTAmount = 0;
    let totalSGSTAmount = 0;
    let totalIGSTAmount = 0;
    let totalGSTAmount = 0;
    let invoiceAmount = 0;

    items.forEach((item) => {
      totalTaxableValue += item.taxableValue || 0;
      totalCGSTAmount += item.cgstAmount || 0;
      totalSGSTAmount += item.sgstAmount || 0;
      totalIGSTAmount += item.igstAmount || 0;
      totalGSTAmount += item.gstAmount || 0;
      invoiceAmount += item.totalAmount || 0;
    });

    const invoiceNumber = await generateInvoiceNumber(companyId);

    const invoiceData = {
      companyId,
      invoiceNo: invoiceNumber,
      linkedPO: linkedPO ? toMongoId(linkedPO) : null,
      poNumber: req.body.poNumber || req.body.linkedPORef || req.body.poreferencevalue || "",
      invoiceDate: new Date(invoiceDate),
      dueDate: new Date(dueDate),
      billTo,
      shipTo,
      items,
      totalTaxableValue,
      totalCGSTAmount,
      totalSGSTAmount,
      totalIGSTAmount,
      totalGSTAmount,
      invoiceAmount,
      amountDue: invoiceAmount,
      netPayable: invoiceAmount,
      remainingAmount: invoiceAmount,
      valueInWords: `${invoiceAmount} only`,
      ...(monthlyBillingInfo && { monthlyBillingInfo }),
      notes,
      createdBy: req.user?.id,
      updatedBy: req.user?.id,
    };

    // If journal entry is requested, use transaction manager for atomic operations
    if (createJournalEntry) {
      const result = await transactionManager.createInvoiceWithJournal(
        async (data) => {
          // Step 1: Create invoice
          const invoice = await createInvoiceRepo(data);
          return invoice;
        },
        async (invoiceId, data) => {
          // Step 2: Create journal entry
          const journalData = {
            companyId,
            date: new Date(invoiceDate),
            journalNumber: `JNL-${invoiceNumber}`,
            description: journalDescription || `Auto-generated from Invoice ${invoiceNumber}`,
            reference: {
              type: "Invoice",
              id: invoiceId,
              number: invoiceNumber,
            },
            debitAmount: invoiceAmount,
            creditAmount: 0,
            status: "draft",
            createdBy: req.user?.id,
            updatedBy: req.user?.id,
          };

          const journal = await createJournalRepo(journalData);
          return journal;
        },
        async (invoiceId, journalId) => {
          // Step 3: Update invoice with journal reference
          await updateInvoiceRepo(invoiceId, {
            salesJournalId: journalId,
            accountingStatus: "journal_posted",
            updatedBy: req.user?.id,
          });
        },
        invoiceData
      );

      // Get the created invoice
      const createdInvoice = await getInvoiceByIdRepo(result.executedSteps[0].result._id);
      if (linkedPO) {
        await syncPurchaseOrderFromInvoicesRepo(linkedPO, req.user?.id);
      }

      // Audit log for transaction
      await createAuditLog({
        companyId,
        entityType: "Invoice",
        entityId: createdInvoice._id,
        action: "CREATE_WITH_JOURNAL",
        userId: req.user?.id,
        userEmail: req.user?.email,
        userRole: req.user?.role,
        changes: { invoiceData, transactionId: result.transactionId },
        description: `Invoice created with automatic journal entry: ${createdInvoice.invoiceNo}`,
      });

      new ApiResponse({
        statusCode: 201,
        data: {
          invoice: createdInvoice,
          transactionId: result.transactionId,
          transaction: result,
        },
        message: "Invoice created with journal entry successfully (transactional)",
      }).send(res);
    } else {
      // Regular invoice creation without transaction
      const invoice = await createInvoiceRepo(invoiceData);

      // Update PO if linked
      if (linkedPO) {
        await syncPurchaseOrderFromInvoicesRepo(linkedPO, req.user?.id);
      }

      await createAuditLog({
        companyId,
        entityType: "Invoice",
        entityId: invoice._id,
        action: "CREATE",
        userId: req.user?.id,
        userEmail: req.user?.email,
        userRole: req.user?.role,
        changes: invoiceData,
        description: `Invoice created: ${invoice.invoiceNo}`,
      });

      new ApiResponse({
        statusCode: 201,
        data: invoice,
        message: "Invoice created successfully",
      }).send(res);
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Download Invoice as Word document
 */
export const downloadWordInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "downloadWordInvoice");
    }

    const invoice = await getInvoiceByIdRepo(id);

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "downloadWordInvoice");
    }
    if (invoice.approvalStatus !== "Approved") {
      throw new AppError("Only approved invoices can be downloaded", 400, "downloadWordInvoice");
    }

    const templateName = invoice.withSignature
      ? "Invoice-Template With Signeture.docx"
      : "Invoice-Template without signeture.docx";

    const templateData = prepareInvoiceData(invoice);
    const buffer = await generateWordDocument(templateName, templateData);

    sendDocumentResponse(
      res,
      buffer,
      `Invoice_${invoice.invoiceNo}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Download Invoice as PDF document
 */
export const downloadPdfInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Invoice ID is required", 400, "downloadPdfInvoice");
    }

    const invoice = await getInvoiceByIdRepo(id);

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "downloadPdfInvoice");
    }
    if (invoice.approvalStatus !== "Approved") {
      throw new AppError("Only approved invoices can be downloaded", 400, "downloadPdfInvoice");
    }

    const templateName = invoice.withSignature
      ? "Invoice-Template With Signeture.docx"
      : "Invoice-Template without signeture.docx";

    const templateData = prepareInvoiceData(invoice);
    const wordBuffer = await generateWordDocument(templateName, templateData);
    const pdfBuffer = await generatePdfFromWord(wordBuffer);

    sendDocumentResponse(
      res,
      pdfBuffer,
      `Invoice_${invoice.invoiceNo}.pdf`,
      "application/pdf"
    );
  } catch (error) {
    next(error);
  }
};
