import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const auditLogSchema = new mongoose.Schema({
  // Company & Scope
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required: true,
    index: true,
  },

  // Entity Information
  entityType: {
    type: String,
    enum: [
      "Invoice",
      "PurchaseOrder",
      "Payment",
      "Journal",
      "Account",
      "Group",
      "User",
      "Company",
      "Client",
      "Vendor",
      "Config",
      "Entity",
    ],
    required: true,
    index: true,
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },

  // Action Information
  action: {
    type: String,
    enum: [
      "CREATE",
      "UPDATE",
      "DELETE",
      "APPROVE",
      "REJECT",
      "STATUS_CHANGE",
      "EXPORT",
      "IMPORT",
      "POST_SALES_JOURNAL",
      "CREATE_APPROVE",
      "UPDATE_APPROVE",
    ],
    required: true,
    index: true,
  },

  // User Information
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  performedByEmail: String,
  performedByRole: String,

  // Change Details
  changes: mongoose.Schema.Types.Mixed,
  oldValues: mongoose.Schema.Types.Mixed,
  newValues: mongoose.Schema.Types.Mixed,

  // Request Details
  ipAddress: String,
  userAgent: String,

  // Metadata
  status: {
    type: String,
    enum: ["SUCCESS", "FAILED", "PARTIAL"],
    default: "SUCCESS",
  },
  errorMessage: String,

  // Timestamps
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },

  // Additional Context
  module: String,
  description: String,
  relatedEntities: [
    {
      entityType: String,
      entityId: mongoose.Schema.Types.ObjectId,
    },
  ],
});

// Text index for searching
auditLogSchema.index({ entityType: 1, companyId: 1, timestamp: -1 });
auditLogSchema.index({ performedBy: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

export const getAuditLogModel = async () => {
  const db = getDatabase("audit");
  return db.models.AuditLog || db.model("AuditLog", auditLogSchema);
};
