import mongoose from "mongoose";
import ApiResponse from "../../../utils/ApiResponse.js";
import AppError from "../../../utils/AppError.js";
import { getInvoiceModel } from "../models/Invoice.js";

const normalizeName = (value = "") => value.toString().trim().toLowerCase();

const normalizeGstin = (value = "") => value.toString().trim().toUpperCase();

const toNumber = (value) => {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
};

const round2 = (value) => Number(toNumber(value).toFixed(2));

const buildRegex = (value = "") => {
  const sanitized = value.trim();
  return sanitized ? new RegExp(sanitized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
};

const getDefaultFinancialYearRange = () => {
  const today = new Date();
  const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return {
    startDate: new Date(year, 3, 1, 0, 0, 0, 0),
    endDate: new Date(year + 1, 2, 31, 23, 59, 59, 999),
    financialYear: `${year}-${String(year + 1).slice(-2)}`,
  };
};

const parseFinancialYear = (financialYear) => {
  if (!financialYear) {
    return getDefaultFinancialYearRange();
  }

  const match = String(financialYear).trim().match(/^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/);
  if (!match) {
    throw new AppError("Invalid financialYear format. Use YYYY-YY or YYYY-YYYY", 400, "parseFinancialYear");
  }

  const startYear = Number(match[1]);
  const suffix = match[2];
  const endYear = suffix.length === 2 ? Number(`${String(startYear).slice(0, 2)}${suffix}`) : Number(suffix);

  return {
    startDate: new Date(startYear, 3, 1, 0, 0, 0, 0),
    endDate: new Date(endYear, 2, 31, 23, 59, 59, 999),
    financialYear: `${startYear}-${String(endYear).slice(-2)}`,
  };
};

const resolveDateRange = ({ financialYear, fromDate, toDate, month }) => {
  if (fromDate || toDate) {
    const baseFinancialYear = parseFinancialYear(financialYear);
    return {
      startDate: fromDate ? new Date(`${fromDate}T00:00:00.000Z`) : baseFinancialYear.startDate,
      endDate: toDate ? new Date(`${toDate}T23:59:59.999Z`) : baseFinancialYear.endDate,
      financialYear: baseFinancialYear.financialYear,
    };
  }

  const financialYearRange = parseFinancialYear(financialYear);
  if (!month) {
    return financialYearRange;
  }

  const monthNumber = Number(month);
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new AppError("month must be between 1 and 12", 400, "resolveDateRange");
  }

  const startYear = financialYearRange.startDate.getFullYear();
  const endYear = financialYearRange.endDate.getFullYear();
  const calendarYear = monthNumber >= 4 ? startYear : endYear;

  return {
    startDate: new Date(calendarYear, monthNumber - 1, 1, 0, 0, 0, 0),
    endDate: new Date(calendarYear, monthNumber, 0, 23, 59, 59, 999),
    financialYear: financialYearRange.financialYear,
  };
};

const resolveCompanyObjectId = (companyId) => {
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
    throw new AppError("Valid companyId is required", 400, "resolveCompanyObjectId");
  }

  return new mongoose.Types.ObjectId(companyId);
};

const inferPoType = (invoice) => {
  const billTo = invoice.billTo || {};
  const poVendor = invoice.poVendor || {};
  const poDeliverTo = invoice.poDeliverTo || {};

  const billName = normalizeName(billTo.name);
  const billGstin = normalizeGstin(billTo.gstin);
  const vendorName = normalizeName(poVendor.name);
  const vendorGstin = normalizeGstin(poVendor.gstin);
  const deliverToName = normalizeName(poDeliverTo.name);
  const deliverToGstin = normalizeGstin(poDeliverTo.gstin);

  if ((billGstin && billGstin === vendorGstin) || (billName && billName === vendorName)) {
    return "Receivable";
  }

  if ((billGstin && billGstin === deliverToGstin) || (billName && billName === deliverToName)) {
    return "Payable";
  }

  return invoice.linkedPO ? "Receivable" : "Unlinked";
};

const normalizeInvoiceRow = (invoice) => {
  const invoiceAmount = round2(invoice.invoiceAmount || invoice.amountDue || invoice.netPayable);
  const paidAmount = round2(invoice.paidAmount);
  const recordedTdsAmount = round2(invoice.tdsAmount);
  const settledAmount = round2(paidAmount + recordedTdsAmount);
  const totalGST = round2(
    invoice.totalGSTAmount ||
      invoice.totalTaxAmount ||
      invoice.totalCGSTAmount + invoice.totalSGSTAmount + invoice.totalIGSTAmount
  );
  const settlementRatio = invoiceAmount > 0 ? Math.min(1, settledAmount / invoiceAmount) : 0;
  const totalIGST = round2(invoice.totalIGSTAmount);
  const totalCGST = round2(invoice.totalCGSTAmount);
  const totalSGST = round2(invoice.totalSGSTAmount);
  const gstPaid = round2(totalGST * settlementRatio);
  const pendingAmount = round2(Math.max(0, invoiceAmount - settledAmount));
  const invoiceDate = invoice.invoiceDate ? new Date(invoice.invoiceDate) : null;
  const clientName = invoice.billTo?.name || invoice.poVendor?.name || "Unassigned";
  const clientId = invoice.billTo?.clientId || invoice.poVendor?._id || null;
  const inferredSections = Array.isArray(invoice.payments)
    ? invoice.payments.reduce((acc, payment) => {
        if (!payment?.tdsSection) {
          return acc;
        }
        acc[payment.tdsSection] = round2((acc[payment.tdsSection] || 0) + toNumber(payment.tdsAmount ?? payment.tdsAdjusted));
        return acc;
      }, {})
    : {};

  return {
    invoiceId: String(invoice._id),
    invoiceNo: invoice.invoiceNo || "—",
    invoiceDate: invoiceDate ? invoiceDate.toISOString() : null,
    dueDate: invoice.dueDate ? new Date(invoice.dueDate).toISOString() : null,
    status: invoice.status || "PENDING_APPROVAL",
    currency: invoice.currency || "INR",
    clientId,
    clientName,
    clientGstin: invoice.billTo?.gstin || invoice.poVendor?.gstin || "",
    poId: invoice.linkedPO ? String(invoice.linkedPO) : null,
    poNumber: invoice.poNumber || invoice.linkedPoNumber || "Unlinked",
    poType: inferPoType(invoice),
    invoiceAmount,
    paidAmount,
    settledAmount,
    pendingAmount,
    gstGenerated: totalGST,
    gstPaid,
    gstPending: round2(Math.max(0, totalGST - gstPaid)),
    igstAmount: totalIGST,
    cgstAmount: totalCGST,
    sgstAmount: totalSGST,
    igstPaid: round2(totalIGST * settlementRatio),
    cgstPaid: round2(totalCGST * settlementRatio),
    sgstPaid: round2(totalSGST * settlementRatio),
    tdsDeducted: recordedTdsAmount,
    tdsPaid: recordedTdsAmount,
    tdsPending: 0,
    paymentInfo: {
      invoiceAmount,
      paidAmount: settledAmount,
      cashReceived: paidAmount,
      pendingAmount,
    },
    tdsSectionBreakdown: Object.entries(inferredSections).map(([section, amount]) => ({
      section,
      amount,
    })),
  };
};

const buildGlobalSummary = (rows) =>
  rows.reduce(
    (summary, row) => {
      summary.totalInvoiceAmount = round2(summary.totalInvoiceAmount + row.invoiceAmount);
      summary.totalSettledAmount = round2(summary.totalSettledAmount + row.settledAmount);
      summary.totalPendingAmount = round2(summary.totalPendingAmount + row.pendingAmount);
      summary.totalIGST = round2(summary.totalIGST + row.igstAmount);
      summary.totalCGST = round2(summary.totalCGST + row.cgstAmount);
      summary.totalSGST = round2(summary.totalSGST + row.sgstAmount);
      summary.totalGSTGenerated = round2(summary.totalGSTGenerated + row.gstGenerated);
      summary.totalGSTPaid = round2(summary.totalGSTPaid + row.gstPaid);
      summary.totalGSTPending = round2(summary.totalGSTPending + row.gstPending);
      summary.totalTDSDeducted = round2(summary.totalTDSDeducted + row.tdsDeducted);
      summary.totalTDSPaid = round2(summary.totalTDSPaid + row.tdsPaid);
      summary.totalTDSPending = round2(summary.totalTDSPending + row.tdsPending);
      summary.invoiceCount += 1;
      return summary;
    },
    {
      totalInvoiceAmount: 0,
      totalSettledAmount: 0,
      totalPendingAmount: 0,
      totalIGST: 0,
      totalCGST: 0,
      totalSGST: 0,
      totalGSTGenerated: 0,
      totalGSTPaid: 0,
      totalGSTPending: 0,
      totalTDSDeducted: 0,
      totalTDSPaid: 0,
      totalTDSPending: 0,
      invoiceCount: 0,
    }
  );

const accumulateTdsSections = (currentSections = [], invoiceSections = []) => {
  const bucket = new Map(currentSections.map((entry) => [entry.section, toNumber(entry.amount)]));
  invoiceSections.forEach((entry) => {
    bucket.set(entry.section, round2((bucket.get(entry.section) || 0) + toNumber(entry.amount)));
  });
  return Array.from(bucket.entries())
    .map(([section, amount]) => ({ section, amount }))
    .sort((a, b) => a.section.localeCompare(b.section));
};

const buildPoReport = (rows) =>
  Array.from(
    rows.reduce((map, row) => {
      const key = row.poId || `unlinked:${row.clientName}`;
      if (!map.has(key)) {
        map.set(key, {
          poId: row.poId,
          poNumber: row.poNumber,
          poType: row.poType,
          clientId: row.clientId,
          clientName: row.clientName,
          clientGstin: row.clientGstin,
          totalInvoiceAmount: 0,
          totalPaid: 0,
          pendingAmount: 0,
          gstGenerated: 0,
          gstPaid: 0,
          gstPending: 0,
          igstAmount: 0,
          cgstAmount: 0,
          sgstAmount: 0,
          tdsDeducted: 0,
          tdsPaid: 0,
          tdsPending: 0,
          invoiceCount: 0,
          invoices: [],
        });
      }

      const group = map.get(key);
      group.totalInvoiceAmount = round2(group.totalInvoiceAmount + row.invoiceAmount);
      group.totalPaid = round2(group.totalPaid + row.settledAmount);
      group.pendingAmount = round2(group.pendingAmount + row.pendingAmount);
      group.gstGenerated = round2(group.gstGenerated + row.gstGenerated);
      group.gstPaid = round2(group.gstPaid + row.gstPaid);
      group.gstPending = round2(group.gstPending + row.gstPending);
      group.igstAmount = round2(group.igstAmount + row.igstAmount);
      group.cgstAmount = round2(group.cgstAmount + row.cgstAmount);
      group.sgstAmount = round2(group.sgstAmount + row.sgstAmount);
      group.tdsDeducted = round2(group.tdsDeducted + row.tdsDeducted);
      group.tdsPaid = round2(group.tdsPaid + row.tdsPaid);
      group.tdsPending = round2(group.tdsPending + row.tdsPending);
      group.invoiceCount += 1;
      group.invoices.push(row);
      return map;
    }, new Map()).values()
  ).sort((a, b) => a.poNumber.localeCompare(b.poNumber));

const buildClientReport = (rows) =>
  Array.from(
    rows.reduce((map, row) => {
      const key = row.clientId || row.clientName;
      if (!map.has(key)) {
        map.set(key, {
          clientId: row.clientId,
          clientName: row.clientName,
          clientGstin: row.clientGstin,
          totalInvoiceAmount: 0,
          totalGST: 0,
          totalIGST: 0,
          totalCGST: 0,
          totalSGST: 0,
          totalTDS: 0,
          totalReceived: 0,
          pendingAmount: 0,
          invoiceCount: 0,
          poCount: 0,
          tdsSectionBreakdown: [],
          poGroups: [],
        });
      }

      const clientGroup = map.get(key);
      clientGroup.totalInvoiceAmount = round2(clientGroup.totalInvoiceAmount + row.invoiceAmount);
      clientGroup.totalGST = round2(clientGroup.totalGST + row.gstGenerated);
      clientGroup.totalIGST = round2(clientGroup.totalIGST + row.igstAmount);
      clientGroup.totalCGST = round2(clientGroup.totalCGST + row.cgstAmount);
      clientGroup.totalSGST = round2(clientGroup.totalSGST + row.sgstAmount);
      clientGroup.totalTDS = round2(clientGroup.totalTDS + row.tdsDeducted);
      clientGroup.totalReceived = round2(clientGroup.totalReceived + row.settledAmount);
      clientGroup.pendingAmount = round2(clientGroup.pendingAmount + row.pendingAmount);
      clientGroup.invoiceCount += 1;
      clientGroup.tdsSectionBreakdown = accumulateTdsSections(clientGroup.tdsSectionBreakdown, row.tdsSectionBreakdown);

      let poGroup = clientGroup.poGroups.find((entry) => entry.poId === row.poId && entry.poNumber === row.poNumber);
      if (!poGroup) {
        poGroup = {
          poId: row.poId,
          poNumber: row.poNumber,
          poType: row.poType,
          totalInvoiceAmount: 0,
          totalPaid: 0,
          pendingAmount: 0,
          totalGST: 0,
          totalTDS: 0,
          invoices: [],
        };
        clientGroup.poGroups.push(poGroup);
      }

      poGroup.totalInvoiceAmount = round2(poGroup.totalInvoiceAmount + row.invoiceAmount);
      poGroup.totalPaid = round2(poGroup.totalPaid + row.settledAmount);
      poGroup.pendingAmount = round2(poGroup.pendingAmount + row.pendingAmount);
      poGroup.totalGST = round2(poGroup.totalGST + row.gstGenerated);
      poGroup.totalTDS = round2(poGroup.totalTDS + row.tdsDeducted);
      poGroup.invoices.push(row);

      return map;
    }, new Map()).values()
  )
    .map((entry) => ({
      ...entry,
      poCount: entry.poGroups.length,
      poGroups: entry.poGroups.sort((a, b) => a.poNumber.localeCompare(b.poNumber)),
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

const getNormalizedTaxRows = async (query) => {
  const companyObjectId = resolveCompanyObjectId(query.companyId);
  const { startDate, endDate, financialYear } = resolveDateRange(query);
  const Invoice = await getInvoiceModel();

  const matchStage = {
    companyId: companyObjectId,
    invoiceDate: { $gte: startDate, $lte: endDate },
  };

  if (query.poId) {
    if (!mongoose.Types.ObjectId.isValid(query.poId)) {
      throw new AppError("Invalid poId", 400, "getNormalizedTaxRows");
    }
    matchStage.linkedPO = new mongoose.Types.ObjectId(query.poId);
  }

  const clientRegex = buildRegex(query.clientName || query.partyName || "");
  const rawInvoices = await Invoice.aggregate([
    { $match: matchStage },
    {
      $lookup: {
        from: "purchaseorders",
        localField: "linkedPO",
        foreignField: "_id",
        as: "poLookup",
      },
    },
    {
      $addFields: {
        poDoc: { $first: "$poLookup" },
      },
    },
    {
      $project: {
        _id: 1,
        invoiceNo: 1,
        invoiceDate: 1,
        dueDate: 1,
        status: 1,
        currency: 1,
        linkedPO: 1,
        poNumber: 1,
        billTo: 1,
        shipTo: 1,
        payments: 1,
        totalIGSTAmount: 1,
        totalCGSTAmount: 1,
        totalSGSTAmount: 1,
        totalGSTAmount: 1,
        invoiceAmount: 1,
        amountDue: 1,
        netPayable: 1,
        paidAmount: 1,
        remainingAmount: 1,
        tdsAmount: 1,
        linkedPoNumber: "$poDoc.poNumber",
        poVendor: "$poDoc.vendor",
        poDeliverTo: "$poDoc.deliverTo",
      },
    },
  ]);

  let filteredInvoices = rawInvoices;

  if (query.clientId) {
    filteredInvoices = filteredInvoices.filter(
      (invoice) =>
        String(invoice.billTo?.clientId || "") === String(query.clientId) ||
        String(invoice.shipTo?.clientId || "") === String(query.clientId)
    );
  }

  if (clientRegex) {
    filteredInvoices = filteredInvoices.filter((invoice) =>
      [
        invoice.billTo?.name,
        invoice.shipTo?.name,
        invoice.poVendor?.name,
        invoice.poDeliverTo?.name,
      ]
        .filter(Boolean)
        .some((value) => clientRegex.test(value))
    );
  }

  const normalizedRows = filteredInvoices
    .map(normalizeInvoiceRow)
    .sort((a, b) => new Date(b.invoiceDate || 0) - new Date(a.invoiceDate || 0));

  return {
    rows: normalizedRows,
    meta: {
      financialYear,
      fromDate: startDate.toISOString(),
      toDate: endDate.toISOString(),
      taxPaidMethod: "GST paid is proportionally inferred from invoice settlement because payment-side GST splits are not stored in the invoice module.",
      tdsMethod: "TDS totals are derived only from invoice-side recorded deduction/settlement data available inside the invoice module.",
    },
  };
};

export const getPOTaxReport = async (req, res, next) => {
  try {
    const { rows, meta } = await getNormalizedTaxRows(req.query);

    new ApiResponse({
      statusCode: 200,
      data: {
        summary: buildGlobalSummary(rows),
        items: buildPoReport(rows),
      },
      meta,
      message: "PO tax report retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getClientTaxReport = async (req, res, next) => {
  try {
    const { rows, meta } = await getNormalizedTaxRows(req.query);

    new ApiResponse({
      statusCode: 200,
      data: {
        summary: buildGlobalSummary(rows),
        items: buildClientReport(rows),
      },
      meta,
      message: "Client tax report retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getTaxSummary = async (req, res, next) => {
  try {
    const { rows, meta } = await getNormalizedTaxRows(req.query);

    new ApiResponse({
      statusCode: 200,
      data: buildGlobalSummary(rows),
      meta,
      message: "Tax summary retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};
