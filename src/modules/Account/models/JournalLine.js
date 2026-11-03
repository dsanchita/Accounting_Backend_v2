import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const journalLineSchema = new mongoose.Schema(
  {
    journalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Journal",
      required: [true, "Journal ID is required"],
      indexed: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: [true, "Account ID is required"],
      indexed: true,
    },
    accountCode: String,
    accountName: String,
    companyId: {
      type: String,
      required: [true, "Company ID is required"],
      indexed: true,
    },
    debitAmount: {
      type: Number,
      default: 0,
    },
    creditAmount: {
      type: Number,
      default: 0,
    },
    description: String,
    bankReference: { type: String, default: "" },
    paymentReference: { type: String, default: "" },
    instrumentNo: { type: String, default: "" },
    transactionMode: { type: String, default: "" },
    counterpartyName: { type: String, default: "" },
    reconciliationKeywords: { type: [String], default: [] },
    searchableText: { type: String, default: "", index: true },
    linkedToClientId: {
      type: String,
    },
    linkedToVendorId: {
      type: String,
    },
    employeeId: { type: String, default: null, index: true },
    employeeCode: { type: String, default: "" },
    employeeName: { type: String, default: "" },
    employeeDepartment: { type: String, default: "" },
    employeeDesignation: { type: String, default: "" },
    employeeEmail: { type: String, default: "" },
    employeePan: { type: String, default: "" },
    paymentId: { type: String, default: "", index: true },
    sourceReference: { type: String, default: "" },
    lineNumber: Number,
    isReconciled: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

journalLineSchema.index({ journalId: 1, accountId: 1 });
journalLineSchema.index({ companyId: 1, accountId: 1 });

export const getJournalLineModel = async () => {
  const db = getDatabase("accounting");
  return db.models.JournalLine || db.model("JournalLine", journalLineSchema);
};
