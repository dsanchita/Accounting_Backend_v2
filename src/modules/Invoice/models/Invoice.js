import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const taxBreakdownSchema = new mongoose.Schema(
  {
    taxType: { type: String, default: "GST" },
    label: { type: String, default: "GST" },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const invoiceLineItemSchema = new mongoose.Schema({
  itemId: { type: String },
  poItemId: { type: String },
  sourceType: { type: String },
  sourceId: { type: String },
  milestoneTitle: { type: String },
  milestoneIndex: { type: Number },
  description: { type: String, required: true },
  hsnSac: { type: String },
  quantity: {
    type: Number,
    required: true,
    validate: {
      validator: (value) => value > 0,
      message: "Quantity must be greater than 0",
    },
  },
  rate: { type: Number, required: true, min: 0 },
  taxableValue: { type: Number, required: true, min: 0 },
  taxType: { type: String, default: "GST" },
  taxLabel: { type: String, default: "GST" },
  taxRate: { type: Number, default: 0, min: 0 },
  taxAmount: { type: Number, default: 0, min: 0 },
  combinedTaxRate: { type: Number, default: 0, min: 0 },
  taxBreakdown: { type: [taxBreakdownSchema], default: [] },
  gstRate: { type: Number, default: 0, min: 0 },
  gstAmount: { type: Number, default: 0, min: 0 },
  cgstAmount: { type: Number, default: 0, min: 0 },
  sgstAmount: { type: Number, default: 0, min: 0 },
  igstAmount: { type: Number, default: 0, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
});

const addressSchema = new mongoose.Schema(
  {
    _id: { type: String },
    name: { type: String, required: true },
    address: { type: String },
    line1: { type: String },
    line2: { type: String },
    city: { type: String },
    state: { type: String },
    stateCode: { type: String },
    gstStateCode: { type: String },
    country: { type: String },
    pinCode: { type: String },
    GSTIN: { type: String },
    gstin: { type: String },
    gstNumber: { type: String },
    taxIdentifierType: { type: String },
    taxIdentifierNumber: { type: String },
    taxDetails: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false }
);

// Milestone schema for milestone-based invoicing
const invoiceMilestoneSchema = new mongoose.Schema({
  milestoneId: { type: String },
  milestoneIndex: { type: Number, default: 0 },
  milestoneNo: { type: Number, default: 1 },
  title: { type: String },
  description: { type: String, default: "" },
  dueDate: { type: Date },
  percentage: { type: Number, default: 0, min: 0 },
  originalPercentage: { type: Number, default: 0, min: 0 },
  originalAmount: { type: Number, default: 0, min: 0 },
  alreadyInvoicedAmount: { type: Number, default: 0, min: 0 },
  remainingAmountBefore: { type: Number, default: 0, min: 0 },
  remainingAmountAfter: { type: Number, default: 0, min: 0 },
  amount: { type: Number, default: 0, min: 0 },
  invoicedAmount: { type: Number, default: 0, min: 0 },
  hsnSac: { type: String },
  gstRate: { type: Number, default: 0, min: 0 },
  gstAmount: { type: Number, default: 0, min: 0 },
  total: { type: Number, default: 0, min: 0 },
  targetAmount: { type: Number, default: 0, min: 0 },
  invoiceAmount: { type: Number, default: 0, min: 0 },
  invoiceDate: { type: Date },
  approvalStatus: {
    type: String,
    enum: ["Pending", "Approved", "Rejected"],
    default: "Pending",
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  approvalDate: { type: Date },
  remarks: { type: String },
});

// Contract worklog schema for time-tracked invoicing
const contractWorklogSchema = new mongoose.Schema({
  workDate: { type: Date, required: true },
  description: { type: String, required: true },
  hours: { type: Number, required: true, min: 0 },
  rate: { type: Number, required: true, min: 0 },
  amount: { type: Number, required: true, min: 0 },
  resourceId: { type: mongoose.Schema.Types.ObjectId, ref: "Resource" },
  approvalStatus: {
    type: String,
    enum: ["Pending", "Approved", "Rejected"],
    default: "Pending",
  },
});

// Delivery milestone schema
const deliveryMilestoneSchema = new mongoose.Schema({
  milestoneNo: { type: Number, required: true },
  description: { type: String, required: true },
  dueDate: { type: Date, required: true },
  deliveryDate: { type: Date },
  status: {
    type: String,
    enum: ["Pending", "Delivered", "Verified"],
    default: "Pending",
  },
  remarks: { type: String },
});

// Payment schedule schema
const paymentScheduleSchema = new mongoose.Schema({
  scheduleNo: { type: Number, required: true },
  dueDate: { type: Date, required: true },
  paymentPercentage: { type: Number, required: true, min: 0, max: 100 },
  amountDue: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ["Pending", "Paid", "Partially Paid", "Overdue"],
    default: "Pending",
  },
  paidDate: { type: Date },
  paidAmount: { type: Number, default: 0, min: 0 },
});

const workflowHistorySchema = new mongoose.Schema(
  {
    status: { type: String },
    action: { type: String },
    reason: { type: String },
    comments: { type: String },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    performedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const updateHistorySchema = new mongoose.Schema(
  {
    snapshot: { type: mongoose.Schema.Types.Mixed },
    changes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    invoiceNo: { type: String, unique: true, required: true },
    linkedPO: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      index: true,
    },
    poNumber: { type: String },

    invoiceDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    paymentDueDate: { type: Date },
    referenceDate: { type: Date },
    currency: { type: String, default: "INR" },

    // Parties
    billTo: { type: addressSchema, required: true },
    shipTo: { type: addressSchema, required: true },

    // Line Items
    items: { type: [invoiceLineItemSchema], required: true },

    // Financial Totals
    totalTaxableValue: { type: Number, required: true, min: 0 },
    taxType: { type: String, default: "GST" },
    taxLabel: { type: String, default: "GST" },
    taxSummary: { type: [taxBreakdownSchema], default: [] },
    totalTaxAmount: { type: Number, default: 0, min: 0 },
    totalCGSTAmount: { type: Number, default: 0, min: 0 },
    totalSGSTAmount: { type: Number, default: 0, min: 0 },
    totalIGSTAmount: { type: Number, default: 0, min: 0 },
    totalGSTAmount: { type: Number, default: 0, min: 0 },
    invoiceAmount: { type: Number, required: true, min: 0 },
    valueInWords: { type: String },

    // Payment Tracking
    amountDue: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    remainingAmount: { type: Number, default: 0, min: 0 },
    tdsAmount: { type: Number, default: 0, min: 0 },
    netPayable: { type: Number, required: true, min: 0 },

    // Status
    status: {
      type: String,
      enum: ["PENDING_APPROVAL", "POSTED", "PARTIALLY_PAID", "PAID", "RECONCILED"],
      default: "PENDING_APPROVAL",
    },

    // Accounting Linkage
    accountingStatus: {
      type: String,
      enum: ["pending", "journal_posted", "completed"],
      default: "pending",
    },
    salesJournalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Journal",
    },
    debtorAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
    },
    revenueAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
    },
    taxAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
    },

    // Payment References
    paymentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Payment" }],
    isFullyPaid: { type: Boolean, default: false },
    isFullyReconciled: { type: Boolean, default: false },

    // PO Consumption
    poConsumption: {
      consumedAmount: { type: Number, default: 0, min: 0 },
      remainingPoAmount: { type: Number, default: 0, min: 0 },
      items: [
        {
          poItemId: { type: String },
          invoicedQuantity: { type: Number, default: 0, min: 0 },
          remainingQuantity: { type: Number, default: 0, min: 0 },
        },
      ],
    },

    // Milestone-based invoicing
    milestones: [invoiceMilestoneSchema],
    deliveryMilestones: [deliveryMilestoneSchema],

    // Contract worklog
    contractWorklog: [contractWorklogSchema],

    // Payment schedules
    paymentSchedules: [paymentScheduleSchema],

    // Approval
    approvalStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvalDate: { type: Date },
    approvalComments: { type: String },
    rejectionReason: { type: String },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedAt: { type: Date },
    rejectionHistory: { type: [workflowHistorySchema], default: [] },
    approvalHistory: { type: [workflowHistorySchema], default: [] },
    updateHistory: { type: [updateHistorySchema], default: [] },
    actionType: {
      type: String,
      enum: ["create", "update", "delete"],
      default: "create",
    },

    notes: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Indexes
invoiceSchema.index({ companyId: 1, invoiceNo: 1 });
invoiceSchema.index({ companyId: 1, status: 1 });
invoiceSchema.index({ companyId: 1, invoiceDate: -1 });
invoiceSchema.index({ linkedPO: 1, status: 1 });

// Pre-save hook to calculate remainingAmount
invoiceSchema.pre("save", function () {
  this.remainingAmount = Math.max(
    0,
    (this.invoiceAmount || 0) - (this.paidAmount || 0) - (this.tdsAmount || 0)
  );
  this.isFullyPaid = this.remainingAmount === 0;
  this.updatedAt = new Date();
});

export const getInvoiceModel = async () => {
  const db = getDatabase("invoice");
  return db.models.Invoice || db.model("Invoice", invoiceSchema);
};
