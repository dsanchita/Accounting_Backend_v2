import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const claimCategoryMappingSchema = new mongoose.Schema(
  {
    categoryId: { type: String, required: true, trim: true },
    categoryName: { type: String, required: true, trim: true },
    expenseAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const payrollDeductionMappingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const integrationConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "HRMS", unique: true },
    companyId: { type: String, required: true, index: true },
    currency: { type: String, default: "INR", required: true },
    bankAccountIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId }],
      default: [],
    },
    closedThroughDate: { type: Date, default: null },
    payroll: {
      salaryExpenseAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
      outstandingSalaryAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
      deductions: { type: [payrollDeductionMappingSchema], default: [] },
      benefits: {
        epfExpenseAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
        epfPayableAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
        mediclaimExpenseAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
        mediclaimPayableAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
        gratuityExpenseAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
        gratuityPayableAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
      },
    },
    claims: {
      payableAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
      categoryMappings: { type: [claimCategoryMappingSchema], default: [] },
    },
    updatedBy: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const getHrmsIntegrationConfigModel = async () => {
  const db = getDatabase("accounting");
  return db.models.HrmsIntegrationConfig ||
    db.model("HrmsIntegrationConfig", integrationConfigSchema);
};
