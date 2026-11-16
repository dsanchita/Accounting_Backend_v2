import mongoose from "mongoose";
import AppError from "../../../utils/AppError.js";
import { getInvoiceModel } from "../models/Invoice.js";
import { getPurchaseOrderModel } from "../models/PurchaseOrder.js";
import { getPaymentModel } from "../../Account/models/Payment.js";
import { getJournalModel } from "../../Account/models/Journal.js";
import { getAccountModel } from "../../Account/models/Account.js";

const ensureInvoicePopulateModels = async () => {
  // Populate uses model names from the same DB connection, so register
  // PurchaseOrder explicitly instead of relying on unrelated import order.
  await getPurchaseOrderModel();
  await getPaymentModel();
  await getJournalModel();
  await getAccountModel();
};

export const createInvoiceRepo = async (invoiceData) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoice = await Invoice.create(invoiceData);
    return invoice;
  } catch (error) {
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((el) => el.message);
      throw new AppError(messages.join(", "), 400, "createInvoiceRepo");
    }
    if (error.code === 11000) {
      throw new AppError("Invoice number already exists", 400, "createInvoiceRepo");
    }
    throw new AppError(error.message || "Failed to create invoice", 500, "createInvoiceRepo");
  }
};

export const getInvoiceByIdRepo = async (id) => {
  try {
    await ensureInvoicePopulateModels();
    const Invoice = await getInvoiceModel();
    const PurchaseOrder = await getPurchaseOrderModel();
    const Journal = await getJournalModel();
    const Account = await getAccountModel();
    const Payment = await getPaymentModel();

    const invoice = await Invoice.findById(id)
      .populate({ path: "linkedPO", select: "poNumber poDate vendor poreferencevalue paymentTerms deliveryDate", model: PurchaseOrder })
      .populate({ path: "salesJournalId", model: Journal })
      .populate({ path: "debtorAccountId", model: Account })
      .populate({ path: "revenueAccountId", model: Account })
      .populate({ path: "taxAccountId", model: Account })
      .populate({ path: "paymentIds", model: Payment })
      .lean();

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "getInvoiceByIdRepo");
    }
    return invoice;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    throw new AppError(error.message || "Error retrieving invoice", 500, "getInvoiceByIdRepo");
  }
};

export const getInvoicesRepo = async (filter = {}, options = {}) => {
  try {
    await ensureInvoicePopulateModels();
    const Invoice = await getInvoiceModel();
    const PurchaseOrder = await getPurchaseOrderModel();
    const { sort = { invoiceDate: -1 }, limit = 0, skip = 0 } = options;

    const invoices = await Invoice.find(filter)
      .populate({ path: "linkedPO", select: "poNumber poDate poreferencevalue", model: PurchaseOrder })
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .lean();

    return invoices;
  } catch (error) {
    throw new AppError(error.message || "Error retrieving invoices", 500, "getInvoicesRepo");
  }
};

export const countInvoicesRepo = async (filter = {}) => {
  try {
    const Invoice = await getInvoiceModel();
    const count = await Invoice.countDocuments(filter);
    return count;
  } catch (error) {
    throw new AppError(error.message || "Error counting invoices", 500, "countInvoicesRepo");
  }
};

export const getInvoiceByNumberRepo = async (invoiceNo, companyId) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoice = await Invoice.findOne({ invoiceNo, companyId }).lean();

    if (!invoice) {
      throw new AppError("Invoice not found with this number", 404, "getInvoiceByNumberRepo");
    }
    return invoice;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    throw new AppError(error.message || "Error retrieving invoice by number", 500, "getInvoiceByNumberRepo");
  }
};

export const updateInvoiceRepo = async (id, updateData) => {
  try {
    await ensureInvoicePopulateModels();
    const Invoice = await getInvoiceModel();
    const PurchaseOrder = await getPurchaseOrderModel();
    const Journal = await getJournalModel();
    const Account = await getAccountModel();

    const invoice = await Invoice.findByIdAndUpdate(id, updateData, { new: true })
      .populate({ path: "linkedPO", model: PurchaseOrder })
      .populate({ path: "salesJournalId", model: Journal })
      .populate({ path: "debtorAccountId", model: Account })
      .populate({ path: "revenueAccountId", model: Account })
      .populate({ path: "taxAccountId", model: Account });

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "updateInvoiceRepo");
    }
    return invoice;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((el) => el.message);
      throw new AppError(messages.join(", "), 400, "updateInvoiceRepo");
    }
    throw new AppError(error.message || "Failed to update invoice", 500, "updateInvoiceRepo");
  }
};

export const deleteInvoiceRepo = async (id) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoice = await Invoice.findByIdAndDelete(id);

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "deleteInvoiceRepo");
    }
    return invoice;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    throw new AppError(error.message || "Failed to delete invoice", 500, "deleteInvoiceRepo");
  }
};

export const getInvoicesByPORepo = async (purchaseOrderId) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoices = await Invoice.find({ linkedPO: purchaseOrderId })
      .sort({ invoiceDate: -1 })
      .lean();

    return invoices;
  } catch (error) {
    throw new AppError(error.message || "Error retrieving invoices for PO", 500, "getInvoicesByPORepo");
  }
};

export const getInvoicesByStatusRepo = async (companyId, status, options = {}) => {
  try {
    await ensureInvoicePopulateModels();
    const Invoice = await getInvoiceModel();
    const PurchaseOrder = await getPurchaseOrderModel();
    const { sort = { invoiceDate: -1 }, limit = 0, skip = 0 } = options;

    const invoices = await Invoice.find({ companyId, status })
      .populate({ path: "linkedPO", select: "poNumber", model: PurchaseOrder })
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .lean();

    return invoices;
  } catch (error) {
    throw new AppError(error.message || "Error retrieving invoices by status", 500, "getInvoicesByStatusRepo");
  }
};

export const getInvoicesByDateRangeRepo = async (companyId, startDate, endDate) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoices = await Invoice.find({
      companyId,
      invoiceDate: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    })
      .sort({ invoiceDate: -1 })
      .lean();

    return invoices;
  } catch (error) {
    throw new AppError(error.message || "Error retrieving invoices by date range", 500, "getInvoicesByDateRangeRepo");
  }
};

export const getInvoicePendingApprovalRepo = async (companyId) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoices = await Invoice.find({
      companyId,
      approvalStatus: "Pending",
    })
      .sort({ invoiceDate: -1 })
      .lean();

    return invoices;
  } catch (error) {
    throw new AppError(
      error.message || "Error retrieving pending invoices",
      500,
      "getInvoicePendingApprovalRepo"
    );
  }
};

export const getInvoiceStatsRepo = async (companyId) => {
  try {
    const Invoice = await getInvoiceModel();
    const stats = await Invoice.aggregate([
      { $match: { companyId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$invoiceAmount" },
          totalPaid: { $sum: "$paidAmount" },
          totalDue: { $sum: "$remainingAmount" },
        },
      },
    ]);

    return stats;
  } catch (error) {
    throw new AppError(error.message || "Error retrieving invoice stats", 500, "getInvoiceStatsRepo");
  }
};

export const updateInvoicePaymentRepo = async (invoiceId, paidAmount, tdsAmount) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "updateInvoicePaymentRepo");
    }

    invoice.paidAmount = (invoice.paidAmount || 0) + paidAmount;
    invoice.tdsAmount = (invoice.tdsAmount || 0) + tdsAmount;
    invoice.remainingAmount = Math.max(
      0,
      Number(invoice.invoiceAmount || 0) - Number(invoice.paidAmount || 0) - Number(invoice.tdsAmount || 0)
    );

    // Update status
    if (invoice.remainingAmount === 0) {
      invoice.status = "PAID";
      invoice.isFullyPaid = true;
    } else if ((invoice.paidAmount || 0) > 0 || (invoice.tdsAmount || 0) > 0) {
      invoice.status = "PARTIALLY_PAID";
    }

    await invoice.save();
    return invoice;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    throw new AppError(
      error.message || "Failed to update invoice payment",
      500,
      "updateInvoicePaymentRepo"
    );
  }
};

export const updateInvoiceAccountingStatusRepo = async (invoiceId, journalId, status) => {
  try {
    const Invoice = await getInvoiceModel();
    const invoice = await Invoice.findByIdAndUpdate(
      invoiceId,
      {
        salesJournalId: journalId,
        accountingStatus: status || "journal_posted",
        approvalStatus: "Approved",
      },
      { new: true }
    );

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "updateInvoiceAccountingStatusRepo");
    }
    return invoice;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    throw new AppError(
      error.message || "Failed to update invoice accounting status",
      500,
      "updateInvoiceAccountingStatusRepo"
    );
  }
};

export const getInvoicesWithTDSRepo = async (companyId, fromDate, toDate) => {
  try {
    const Invoice = await getInvoiceModel();
    const query = {
      companyId: new mongoose.Types.ObjectId(companyId),
      $or: [
        { tdsAmount: { $gt: 0 } },
        { totalTDSAmount: { $gt: 0 } }
      ]
    };
    if (fromDate || toDate) {
      query.invoiceDate = {};
      if (fromDate) query.invoiceDate.$gte = new Date(fromDate);
      if (toDate) query.invoiceDate.$lte = new Date(toDate);
    }

    return await Invoice.find(query).sort({ invoiceDate: -1 }).lean();
  } catch (error) {
    throw new AppError(error.message || "Error retrieving invoices with TDS", 500, "getInvoicesWithTDSRepo");
  }
};
