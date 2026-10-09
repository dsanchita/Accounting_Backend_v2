import mongoose from "mongoose";
import { getDatabase } from "../../../config/databases.js";

const accountSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Account code is required"],
      trim: true,
      indexed: true,
    },
    name: {
      type: String,
      required: [true, "Account name is required"],
      trim: true,
    },
    type: {
      type: String,
      enum: ["balanceSheet", "revenueAccount"],
      required: [true, "Account type is required"],
    },
    // FIXED: subType for balance sheet classification
    subType: {
      type: String,
      enum: ["current", "nonCurrent"],
      default: null,
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: [true, "Group ID is required"],
    },
    // FIXED: groupName should be actual group name, not enum
    groupName: {
      type: String,
      required: [true, "Group name is required"],
      trim: true,
    },
    companyId: {
      type: String,
      required: [true, "Company ID is required"],
      indexed: true,
    },
    openingBalance: {
      type: Number,
      default: 0,
    },
    openingType: {
      type: String,
      enum: ["debit", "credit"],
      required: [true, "Opening type is required"],
    },
    // FIXED: Add scheduleMapping for reporting
    scheduleMapping: {
      scheduleMainHead: {
        type: String,
        enum: ["Assets", "Equity and Liabilities", "P&L", null],
        default: null,
      },
      scheduleGroup: {
        type: String,
        trim: true,
        default: null,
      },
      scheduleLineItem: {
        type: String,
        trim: true,
        default: null,
      },
      noteNo: {
        type: String,
        trim: true,
        default: null,
      },
      reportType: {
        type: String,
        enum: ["balance_sheet", "profit_and_loss", null],
        default: null,
      },
    },
    // Linking to clients/vendors for ledger accounts
    linkedClientId: {
      type: String,
      default: null,
    },
    linkedVendorId: {
      type: String,
      default: null,
    },
    // Denormalized party info for reporting efficiency
    linkedPartyType: {
      type: String,
      enum: ["client", "vendor", null],
      default: null,
    },
    partyName: {
      type: String,
      default: null,
    },
    partyCode: {
      type: String,
      default: null,
    },
    description: String,
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: String,
      required: true,
    },
    updatedBy: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index on code + companyId
accountSchema.index({ code: 1, companyId: 1 }, { unique: true });

// Only linked-party accounts participate in uniqueness; ordinary accounts store null here.
accountSchema.index(
  { linkedClientId: 1, companyId: 1 },
  {
    name: "uniq_linkedClientId_companyId_nonnull",
    unique: true,
    partialFilterExpression: { linkedClientId: { $type: "string" } },
  }
);
accountSchema.index(
  { linkedVendorId: 1, companyId: 1 },
  {
    name: "uniq_linkedVendorId_companyId_nonnull",
    unique: true,
    partialFilterExpression: { linkedVendorId: { $type: "string" } },
  }
);

export const getAccountModel = async () => {
  const db = getDatabase("accounting");
  return db.models.Account || db.model("Account", accountSchema);
};
