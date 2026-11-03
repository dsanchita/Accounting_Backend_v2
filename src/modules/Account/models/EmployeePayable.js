import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const employeePayableSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    sourceType: { type: String, enum: ["PAYROLL", "CLAIM"], required: true },
    sourceId: { type: String, required: true, index: true },
    employeeId: { type: String, required: true, index: true },
    employeeCode: { type: String, default: "" },
    employeeName: { type: String, required: true },
    currency: { type: String, required: true },
    originalAmountMinorUnits: { type: Number, required: true, min: 0 },
    settledAmountMinorUnits: { type: Number, default: 0, min: 0 },
    journalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    journalLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ["OPEN", "PARTIAL", "SETTLED"], default: "OPEN" },
  },
  { timestamps: true }
);

employeePayableSchema.index(
  { companyId: 1, sourceType: 1, sourceId: 1, employeeId: 1 },
  { unique: true }
);

export const getEmployeePayableModel = async () => {
  const db = getDatabase("accounting");
  return db.models.EmployeePayable || db.model("EmployeePayable", employeePayableSchema);
};

const settlementAllocationSchema = new mongoose.Schema(
  {
    payableId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    amountMinorUnits: { type: Number, required: true, min: 1 },
    reversedAmountMinorUnits: { type: Number, default: 0, min: 0 },
    journalLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const employeeSettlementSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, index: true },
    eventId: { type: String, required: true, unique: true },
    payloadHash: { type: String, default: "" },
    settlementType: { type: String, enum: ["PAYROLL", "CLAIM"], required: true },
    journalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    bankAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    paymentDate: { type: Date, required: true },
    bankReference: { type: String, required: true, trim: true },
    allocations: { type: [settlementAllocationSchema], required: true },
    isReversal: { type: Boolean, default: false },
    reversesSettlementId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true }
);

export const getEmployeeSettlementModel = async () => {
  const db = getDatabase("accounting");
  return db.models.EmployeeSettlement ||
    db.model("EmployeeSettlement", employeeSettlementSchema);
};
