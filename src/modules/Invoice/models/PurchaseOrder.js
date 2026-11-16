import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

// ─── Line Item Schema ────────────────────────────────────────────
// hsnId stored as plain String — HSN lives in a different database,
// so we cannot use ObjectId ref across DB connections.
// The full hsnSac code and gstRate are stored directly on the item.
const taxBreakdownSchema = new mongoose.Schema(
  {
    taxType: { type: String, default: "GST" },
    label: { type: String, default: "GST" },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const poLineItemSchema = new mongoose.Schema(
  {
    itemId: { type: String },
    description: { type: String, required: true },
    hsnSac: { type: String },   // HSN/SAC code string e.g. "998314"
    hsnId: { type: String },   // ID from HSN module — stored as String, no ref
    quantity: { type: Number, required: true, min: 0 },
    unit: { 
      type: String, 
      enum: ["each", "hour"],
      default: "each"
    },   // Unit of measurement — can be "each" or "hour"
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
    invoicedQuantity: { type: Number, default: 0, min: 0 },
    invoicedAmount: { type: Number, default: 0, min: 0 },
  }
);

// ─── Address Schema ──────────────────────────────────────────────
// Stored inline — client lives in a different DB so no ObjectId ref.
// We store _id as a plain String for lookup purposes only.
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

// ─── Milestone Schema ────────────────────────────────────────────
const poMilestoneSchema = new mongoose.Schema(
  {
    milestoneNo: { type: Number },
    title: { type: String,  },
    description: { type: String },
    dueDate: { type: Date },
    targetDate: { type: Date },
    deliveryDate: { type: Date },
    percentage: { type: Number, default: 0 },
    amount: { type: Number, required: true, min: 0 },
    invoicedAmount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: [
        "pending", "in_progress", "completed", "verified",
        "Pending", "In Progress", "Completed", "Verified",
      ],
      default: "pending",
    },
    remarks: { type: String },
  }
);

// ─── Resource Schema ─────────────────────────────────────────────
const resourceSchema = new mongoose.Schema(
  {
    resourceId: { type: String },
    name: { type: String },
    resourceName: { type: String },
    role: { type: String },
    designation: { type: String },
    startDate: { type: Date },
    endDate: { type: Date },
    ratePerDay: { type: Number, default: 0, min: 0 },
    ratePerHour: { type: Number, default: 0, min: 0 },
    ratePerMonth: { type: Number, default: 0, min: 0 },
    dailyRate: { type: Number, default: 0, min: 0 },
    billableHoursPerDay: { type: Number, default: 8, min: 0 },
    status: {
      type: String,
      enum: ["Active", "On Leave", "Inactive"],
      default: "Active",
    },
  }
);

// ─── Attendance Schema ───────────────────────────────────────────
const attendanceRecordSchema = new mongoose.Schema(
  {
    resourceId: { type: String },
    date: { type: Date, required: true },
    hoursWorked: { type: Number, required: true, min: 0 },
    description: { type: String },
    approved: { type: Boolean, default: false },
    approvedBy: { type: String },
    approvalDate: { type: Date },
  }
);

const workflowHistorySchema = new mongoose.Schema(
  {
    status: { type: String },
    action: { type: String },
    reason: { type: String },
    comments: { type: String },
    performedBy: { type: String },
    performedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const updateHistorySchema = new mongoose.Schema(
  {
    snapshot: { type: mongoose.Schema.Types.Mixed },
    changes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    updatedBy: { type: String },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ─── Main Purchase Order Schema ──────────────────────────────────
const purchaseOrderSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    poNumber: { type: String, unique: true, required: true },
    poDate: { type: Date, required: true },
    deliveryDate: { type: Date, required: true },
    referenceDate: { type: Date },
    poreferencevalue: { type: String },
    currency: { type: String, default: "INR" },

    direction: {
      type: String,
      enum: ["receivable", "payable"],
      default: "receivable",
    },

    poCategory: {
      type: String,
      enum: ["general", "project", "staffing", "retainer"],
      default: "general",
    },

    billingModel: {
      type: String,
      enum: ["fixed", "milestone", "daily", "monthly", "hourly", "headcount"],
      default: "fixed",
    },

    paymentTerms: {
      type: String,
      enum: [
        "milestone", "monthly", "hourly","weekly",
        "advance", "immediate",
        "net-15", "net-30", "net-45", "net-60", "net-90",
        "on_milestone", "on_delivery", "cod",
      ],
      default: "monthly",
    },

    paymentSchedule: { type: String },
    distributionSchedule: { type: [mongoose.Schema.Types.Mixed], default: [] },
    staffingConfig: { type: mongoose.Schema.Types.Mixed },

    vendor: { type: addressSchema, required: true },
    deliverTo: { type: addressSchema, required: true },

    items: { type: [poLineItemSchema], default: [] },
    milestones: { type: [poMilestoneSchema], default: [] },
    resources: { type: [resourceSchema], default: [] },
    attendanceRecords: { type: [attendanceRecordSchema], default: [] },

    totalTaxableValue: { type: Number, required: true, min: 0 },
    taxType: { type: String, default: "GST" },
    taxLabel: { type: String, default: "GST" },
    taxSummary: { type: [taxBreakdownSchema], default: [] },
    totalTaxAmount: { type: Number, default: 0, min: 0 },
    totalGSTAmount: { type: Number, default: 0, min: 0 },
    totalCGSTAmount: { type: Number, default: 0, min: 0 },
    totalSGSTAmount: { type: Number, default: 0, min: 0 },
    totalIGSTAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    valueInWords: { type: String },
    totalInvoicedAmount: { type: Number, default: 0, min: 0 },
    remainingInvoicableAmount: { type: Number, default: 0, min: 0 },
    totalPaidAmount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["OPEN", "PARTIALLY_INVOICED", "FULLY_INVOICED", "CLOSED"],
      default: "OPEN",
    },
    invoiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Invoice" }],

    notes: { type: String },
    withSignature: { type: Boolean, default: false },

    // Approval
    approvalStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
    approvedBy: { type: String }, // Stored as string to match createdBy/updatedBy
    approvalDate: { type: Date },
    approvalComments: { type: String },
    rejectionReason: { type: String },
    rejectedBy: { type: String },
    rejectedAt: { type: Date },
    rejectionHistory: { type: [workflowHistorySchema], default: [] },
    approvalHistory: { type: [workflowHistorySchema], default: [] },
    updateHistory: { type: [updateHistorySchema], default: [] },
    actionType: {
      type: String,
      enum: ["create", "update", "delete"],
      default: "create",
    },

    // Stored as String — User lives in a different DB, no ObjectId ref
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// ─── Indexes ─────────────────────────────────────────────────────
purchaseOrderSchema.index({ companyId: 1, poNumber: 1 });
purchaseOrderSchema.index({ companyId: 1, status: 1 });
purchaseOrderSchema.index({ companyId: 1, poDate: -1 });
purchaseOrderSchema.index({ companyId: 1, direction: 1 });
purchaseOrderSchema.index({ companyId: 1, paymentTerms: 1 });

// ─── Model Factory ───────────────────────────────────────────────
// No pre-save hooks — they are unreliable with dynamically fetched
// DB connections via getDatabase(). All defaulting (e.g. milestoneNo)
// is handled in the controller before the document is saved.
export const getPurchaseOrderModel = async () => {
  const db = getDatabase("invoice");
  return db.models.PurchaseOrder || db.model("PurchaseOrder", purchaseOrderSchema);
};
