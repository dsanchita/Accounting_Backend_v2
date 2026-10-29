import AppError from "../../../utils/AppError.js";
import mongoose from "mongoose";
import { getJournalModel } from "../models/Journal.js";
import { getJournalLineModel } from "../models/JournalLine.js";
import { getAccountModel } from "../models/Account.js";

const attachLinesToJournals = async (journals = []) => {
  if (!journals.length) return journals;

  const JournalLine = await getJournalLineModel();
  // Ensure Account model is registered on the DB connection before populate
  await getAccountModel();
  const journalIds = journals.map((journal) => journal._id);
  const lines = await JournalLine.find({ journalId: { $in: journalIds } })
    .populate({ path: "accountId", select: "name code" })
    .sort({ lineNumber: 1, createdAt: 1 })
    .lean();

  const linesByJournalId = new Map();
  for (const line of lines) {
    const key = line.journalId?.toString();
    if (!linesByJournalId.has(key)) {
      linesByJournalId.set(key, []);
    }
    // Resolve account name/code: prefer denormalized fields, fallback to populated accountId
    const populatedAccount = line.accountId && typeof line.accountId === "object" ? line.accountId : null;
    const accountId = populatedAccount?._id || line.accountId;
    const accountName = line.accountName || populatedAccount?.name || null;
    const accountCode = line.accountCode || populatedAccount?.code || null;

    linesByJournalId.get(key).push({
      ...line,
      accountId: accountId,
      debit: Number(line.debitAmount || 0),
      credit: Number(line.creditAmount || 0),
      account: {
        _id: accountId,
        name: accountName,
        code: accountCode,
      },
    });
  }

  return journals.map((journal) => ({
    ...journal,
    lines: linesByJournalId.get(journal._id.toString()) || [],
  }));
};

const attachUsersToJournals = async (journals = []) => {
  if (!journals.length) return journals;

  try {
    const { getUserModel } = await import("../../user/models/User.js");
    const User = await getUserModel();

    const rawUserIds = journals
      .flatMap((j) => [j.createdBy, j.updatedBy, j.approvedBy])
      .filter(Boolean)
      .map((id) => (typeof id === "object" ? id._id || id.id : id))
      .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
      .map(String);

    const userIds = [...new Set(rawUserIds)];

    let userMap = new Map();
    if (userIds.length > 0) {
      const users = await User.find({ _id: { $in: userIds } })
        .select("name email role")
        .lean();
      userMap = new Map(users.map((u) => [String(u._id), u]));
    }

    const resolveUser = (val) => {
      if (!val) return null;
      if (typeof val === "object" && val.name) return val;
      const idStr = String(typeof val === "object" ? val._id || val.id || "" : val);
      if (userMap.has(idStr)) return userMap.get(idStr);
      if (typeof val === "object") return val;
      if (!mongoose.Types.ObjectId.isValid(val)) return { name: val };
      return { _id: val, name: "System" };
    };

    return journals.map((j) => ({
      ...j,
      createdBy: resolveUser(j.createdBy),
      updatedBy: resolveUser(j.updatedBy),
      approvedBy: resolveUser(j.approvedBy),
    }));
  } catch (error) {
    console.error("Error attaching users to journals:", error);
    return journals;
  }
};


export const createJournalRepo = async (journalData) => {
  try {
    const Journal = await getJournalModel();
    const journal = await Journal.create(journalData);
    return journal;
  } catch (error) {
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((el) => el.message);
      throw new AppError(messages.join(", "), 400, "createJournalRepo");
    }
    throw new AppError(error.message || "Failed to create journal", 500, "createJournalRepo");
  }
};

export const getJournalByIdRepo = async (id) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid journal ID", 400, "getJournalByIdRepo");
    }
    const Journal = await getJournalModel();
    const journal = await Journal.findById(id).lean();
    if (!journal) return null;
    const [journalWithLines] = await attachLinesToJournals([journal]);
    const [journalWithUsers] = await attachUsersToJournals([journalWithLines]);
    return journalWithUsers;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(error.message || "Error finding journal", 500, "getJournalByIdRepo");
  }
};

export const getJournalsRepo = async (filter = {}) => {
  try {
    const Journal = await getJournalModel();
    const journals = await Journal.find(filter).sort({ date: -1 }).lean();
    const withLines = await attachLinesToJournals(journals);
    return await attachUsersToJournals(withLines);
  } catch (error) {
    throw new AppError(error.message || "Error retrieving journals", 500, "getJournalsRepo");
  }
};

export const updateJournalRepo = async (id, updateData) => {
  try {
    const Journal = await getJournalModel();
    const journal = await Journal.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });
    return journal;
  } catch (error) {
    throw new AppError(error.message || "Failed to update journal", 500, "updateJournalRepo");
  }
};

export const deleteJournalRepo = async (id) => {
  try {
    const Journal = await getJournalModel();
    await Journal.findByIdAndDelete(id);
    return { success: true };
  } catch (error) {
    throw new AppError(error.message || "Failed to delete journal", 500, "deleteJournalRepo");
  }
};

export const getJournalStatsRepo = async (companyId) => {
  try {
    const Journal = await getJournalModel();
    const stats = await Journal.aggregate([
      { $match: { companyId: companyId, isDeleted: false } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalDebit: { $sum: "$totalDebit" },
          totalCredit: { $sum: "$totalCredit" },
        },
      },
    ]);
    return stats;
  } catch (error) {
    throw new AppError(
      error.message || "Error retrieving journal stats",
      500,
      "getJournalStatsRepo"
    );
  }
};

export const getJournalsByApprovalStatusRepo = async (companyId, status) => {
  try {
    const Journal = await getJournalModel();
    const journals = await Journal.find({
      companyId,
      approvalStatus: status,
      sourceType: "MANUAL",
    })
      .sort({ createdAt: -1 })
      .lean();
    const withLines = await attachLinesToJournals(journals);
    return await attachUsersToJournals(withLines);
  } catch (error) {
    throw new AppError(
      error.message || "Error retrieving journals by approval status",
      500,
      "getJournalsByApprovalStatusRepo"
    );
  }
};
