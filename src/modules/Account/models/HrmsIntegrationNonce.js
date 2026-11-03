import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const nonceSchema = new mongoose.Schema(
  {
    nonce: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

export const getHrmsIntegrationNonceModel = async () => {
  const db = getDatabase("accounting");
  return db.models.HrmsIntegrationNonce ||
    db.model("HrmsIntegrationNonce", nonceSchema);
};
