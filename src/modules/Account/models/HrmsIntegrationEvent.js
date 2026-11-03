import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const integrationEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: {
      type: String,
      enum: ["PAYROLL_ACCRUAL", "CLAIM_ACCRUAL"],
      required: true,
    },
    payloadHash: { type: String, required: true },
    companyId: { type: String, required: true, index: true },
    sourceId: { type: String, required: true },
    status: {
      type: String,
      enum: ["PROCESSING", "POSTED", "REJECTED", "FAILED"],
      default: "PROCESSING",
      index: true,
    },
    journalId: { type: mongoose.Schema.Types.ObjectId, default: null },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    attemptCount: { type: Number, default: 1 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

integrationEventSchema.index(
  { companyId: 1, eventType: 1, sourceId: 1 },
  { unique: true }
);

export const getHrmsIntegrationEventModel = async () => {
  const db = getDatabase("accounting");
  return db.models.HrmsIntegrationEvent ||
    db.model("HrmsIntegrationEvent", integrationEventSchema);
};
