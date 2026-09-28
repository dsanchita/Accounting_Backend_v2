import crypto from "node:crypto";
import { getExpenseAuditIdentifierModel } from "../models/ExpenseAuditIdentifier.js";
import { getExpenseAuditTransactionModel } from "../models/ExpenseAuditTransaction.js";
import { getExpenseAuditCategoryModel } from "../models/ExpenseAuditCategory.js";
import { getExpenseAuditVersionModel } from "../models/ExpenseAuditVersion.js";

const normalize = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const getDuplicateKey = ({ transactionDate, description, debitAmount, creditAmount }) => {
  const date = transactionDate instanceof Date && !Number.isNaN(transactionDate.getTime())
    ? transactionDate.toISOString().slice(0, 10)
    : "";
  return [date, normalize(description), number(debitAmount).toFixed(2), number(creditAmount).toFixed(2)].join("|");
};
const number = (value) => {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value);
  const text = String(value).trim();
  const directValue = Number(
    text
      .replace(/[₹$€£,\s]/g, "")
      .replace(/[()]/g, "")
      .replace(/(?:CR|DR|CREDIT|DEBIT)$/i, ""),
  );
  if (Number.isFinite(directValue)) return Math.abs(directValue);
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : 0;
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
};
const getRange = (endingYear) => ({
  $gte: new Date(Number(endingYear) - 1, 3, 1),
  $lt: new Date(Number(endingYear), 3, 1),
});
const actor = (req) => {
  const user = req.user || {};
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = user.fullName || user.name || user.userName || fullName || user.email || user._id || user.id || "System";
  return String(displayName);
};
const sendError = (res, error) => res.status(error.statusCode || 500).json({ status: "error", message: error.message || "Expense audit request failed" });

const getIdentifierCatalog = async (companyId) => {
  const Identifier = await getExpenseAuditIdentifierModel();
  const Category = await getExpenseAuditCategoryModel();
  const [identifiers, categories] = await Promise.all([
    Identifier.find({ companyId, active: true }).sort({ normalizedName: -1 }).lean(),
    Category.find({ companyId, active: true }).lean(),
  ]);
  const categoriesById = new Map(categories.map((category) => [String(category._id), category]));
  return identifiers.flatMap((identifier) => {
    const category = identifier.categoryId ? categoriesById.get(String(identifier.categoryId)) || null : null;
    return String(identifier.name || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({
        ...identifier,
        name,
        normalizedName: normalize(name),
        category,
      }));
  }).sort((left, right) => right.normalizedName.length - left.normalizedName.length);
};

const getMatchFields = (match) => ({
  identifierId: match?._id || null,
  identifierName: match?.name || "",
  categoryId: match?.category?._id || null,
  categoryName: match?.category?.name || "",
  categorySource: match?.category ? "AUTO" : "",
  categorizedAt: match?.category ? new Date() : null,
  categorizedBy: null,
});

const findIdentifierMatch = (description, identifiers) => {
  const normalizedDescription = normalize(description);
  return identifiers.find((identifier) => identifier.normalizedName && normalizedDescription.includes(identifier.normalizedName)) || null;
};

const rematchTransactions = async (companyId) => {
  const Transaction = await getExpenseAuditTransactionModel();
  const identifiers = await getIdentifierCatalog(companyId);
  const transactions = await Transaction.find({ companyId }).select("_id description categorySource").lean();
  const operations = transactions.map((transaction) => {
    const fields = getMatchFields(findIdentifierMatch(transaction.description, identifiers));
    if (transaction.categorySource === "MANUAL") {
      delete fields.categoryId;
      delete fields.categoryName;
      delete fields.categorySource;
      delete fields.categorizedAt;
      delete fields.categorizedBy;
    }
    return { updateOne: { filter: { _id: transaction._id, companyId }, update: { $set: fields } } };
  });
  if (operations.length) await Transaction.bulkWrite(operations);
};

const syncVersionSnapshot = async ({ companyId, versionId, transactionId, updatedRow }) => {
  if (!versionId || !companyId) return;
  const Version = await getExpenseAuditVersionModel();
  const version = await Version.findOne({ _id: versionId, companyId }).lean();
  if (!version) return;
  const nextSnapshot = (Array.isArray(version.snapshot) ? version.snapshot : []).map((row) => {
    const rowId = String(row?._id || "");
    if (transactionId && rowId !== String(transactionId)) return row;
    if (!transactionId && !updatedRow) return row;
    if (updatedRow) return { ...row, ...updatedRow, _id: rowId || updatedRow._id };
    return row;
  });
  if (transactionId) {
    const existingRow = nextSnapshot.find((row) => String(row?._id || "") === String(transactionId));
    if (!existingRow && updatedRow) nextSnapshot.push({ ...updatedRow, _id: String(transactionId) });
  }
  await Version.updateOne({ _id: versionId, companyId }, { $set: { snapshot: nextSnapshot } });
};

export const listIdentifiers = async (req, res) => {
  try {
    const Identifier = await getExpenseAuditIdentifierModel();
    const data = await Identifier.find({ companyId: req.params.companyId, active: true }).sort({ name: 1 }).lean();
    return res.json({ status: "success", data, message: "Identifiers loaded" });
  } catch (error) { return sendError(res, error); }
};

export const createIdentifier = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!req.body.companyId || !name) return res.status(400).json({ status: "error", message: "Company and identifier name are required" });
    const Category = await getExpenseAuditCategoryModel();
    if (!req.body.categoryId) return res.status(400).json({ status: "error", message: "Category is required for an identifier" });
    const category = req.body.categoryId ? await Category.findOne({ _id: req.body.categoryId, companyId: req.body.companyId, active: true }).lean() : null;
    if (req.body.categoryId && !category) return res.status(404).json({ status: "error", message: "Category not found" });
    const Identifier = await getExpenseAuditIdentifierModel();
    const data = await Identifier.create({ companyId: req.body.companyId, name, normalizedName: normalize(name), categoryId: category?._id || null, description: req.body.description || "", createdBy: actor(req), updatedBy: actor(req) });
    await rematchTransactions(req.body.companyId);
    return res.status(201).json({ status: "success", data, message: "Identifier created" });
  } catch (error) { return sendError(res, error.code === 11000 ? Object.assign(new Error("This identifier already exists"), { statusCode: 409 }) : error); }
};

export const updateIdentifier = async (req, res) => {
  try {
    const Identifier = await getExpenseAuditIdentifierModel();
    const Category = await getExpenseAuditCategoryModel();
    if (!req.body.categoryId) return res.status(400).json({ status: "error", message: "Category is required for an identifier" });
    const category = req.body.categoryId ? await Category.findOne({ _id: req.body.categoryId, companyId: req.body.companyId, active: true }).lean() : null;
    if (req.body.categoryId && !category) return res.status(404).json({ status: "error", message: "Category not found" });
    const update = { categoryId: category?._id || null, description: req.body.description || "", updatedBy: actor(req) };
    if (req.body.name?.trim()) { update.name = req.body.name.trim(); update.normalizedName = normalize(update.name); }
    const data = await Identifier.findOneAndUpdate({ _id: req.params.id, companyId: req.body.companyId }, update, { new: true, runValidators: true }).lean();
    if (!data) return res.status(404).json({ status: "error", message: "Identifier not found" });
    await rematchTransactions(req.body.companyId);
    return res.json({ status: "success", data, message: "Identifier updated" });
  } catch (error) { return sendError(res, error); }
};

export const deleteIdentifier = async (req, res) => {
  try {
    const Identifier = await getExpenseAuditIdentifierModel();
    const data = await Identifier.findOneAndUpdate({ _id: req.params.id, companyId: req.query.companyId }, { active: false, updatedBy: actor(req) }, { new: true }).lean();
    if (!data) return res.status(404).json({ status: "error", message: "Identifier not found" });
    await rematchTransactions(req.query.companyId);
    return res.json({ status: "success", data, message: "Identifier deleted" });
  } catch (error) { return sendError(res, error); }
};

export const listCategories = async (req, res) => {
  try {
    const Category = await getExpenseAuditCategoryModel();
    const data = await Category.find({ companyId: req.params.companyId, active: true }).sort({ name: 1 }).lean();
    return res.json({ status: "success", data, message: "Categories loaded" });
  } catch (error) { return sendError(res, error); }
};

export const createCategory = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!req.body.companyId || !name) return res.status(400).json({ status: "error", message: "Company and category name are required" });
    const Category = await getExpenseAuditCategoryModel();
    const data = await Category.create({ companyId: req.body.companyId, name, normalizedName: normalize(name), description: req.body.description || "", createdBy: actor(req), updatedBy: actor(req) });
    return res.status(201).json({ status: "success", data, message: "Category created" });
  } catch (error) { return sendError(res, error.code === 11000 ? Object.assign(new Error("This category already exists"), { statusCode: 409 }) : error); }
};

export const updateCategory = async (req, res) => {
  try {
    const Category = await getExpenseAuditCategoryModel();
    const update = { description: req.body.description || "", updatedBy: actor(req) };
    if (req.body.name?.trim()) { update.name = req.body.name.trim(); update.normalizedName = normalize(update.name); }
    const data = await Category.findOneAndUpdate({ _id: req.params.id, companyId: req.body.companyId }, update, { new: true, runValidators: true }).lean();
    if (!data) return res.status(404).json({ status: "error", message: "Category not found" });
    await rematchTransactions(req.body.companyId);
    await (await getExpenseAuditTransactionModel()).updateMany({ companyId: req.body.companyId, categoryId: data._id }, { $set: { categoryName: data.name } });
    return res.json({ status: "success", data, message: "Category updated" });
  } catch (error) { return sendError(res, error); }
};

export const deleteCategory = async (req, res) => {
  try {
    const Category = await getExpenseAuditCategoryModel();
    const data = await Category.findOneAndUpdate({ _id: req.params.id, companyId: req.query.companyId }, { active: false, updatedBy: actor(req) }, { new: true }).lean();
    if (!data) return res.status(404).json({ status: "error", message: "Category not found" });
    await (await getExpenseAuditIdentifierModel()).updateMany({ companyId: req.query.companyId, categoryId: data._id }, { $set: { categoryId: null } });
    await (await getExpenseAuditTransactionModel()).updateMany({ companyId: req.query.companyId, categoryId: data._id }, { $set: { categoryId: null, categoryName: "", categorySource: "", categorizedAt: null, categorizedBy: null } });
    await rematchTransactions(req.query.companyId);
    return res.json({ status: "success", data, message: "Category deleted" });
  } catch (error) { return sendError(res, error); }
};

export const updateTransactionCategory = async (req, res) => {
  try {
    const { companyId, categoryId = null, versionId = null } = req.body;
    const Transaction = await getExpenseAuditTransactionModel();
    const Category = await getExpenseAuditCategoryModel();
    const category = categoryId ? await Category.findOne({ _id: categoryId, companyId, active: true }).lean() : null;
    if (categoryId && !category) return res.status(404).json({ status: "error", message: "Category not found" });
    const filter = versionId ? { _id: req.params.id, companyId, versionId } : { _id: req.params.id, companyId };
    const data = await Transaction.findOneAndUpdate(filter, { $set: { categoryId: category?._id || null, categoryName: category?.name || "", categorySource: category ? "MANUAL" : "", categorizedAt: category ? new Date() : null, categorizedBy: category ? actor(req) : null } }, { new: true }).lean();
    if (!data) return res.status(404).json({ status: "error", message: "Audit transaction not found for the current version" });
    await syncVersionSnapshot({ companyId, versionId: data.versionId, transactionId: data._id, updatedRow: { ...data, _id: data._id.toString() } });
    return res.json({ status: "success", data, message: category ? "Transaction categorized" : "Category removed" });
  } catch (error) { return sendError(res, error); }
};

export const updateTransaction = async (req, res) => {
  try {
    const { companyId, versionId = null } = req.body;
    const Transaction = await getExpenseAuditTransactionModel();
    const update = {};
    if (req.body.description !== undefined) update.description = String(req.body.description || "").trim();
    if (req.body.transactionDate !== undefined) update.transactionDate = new Date(req.body.transactionDate);
    if (update.transactionDate && Number.isNaN(update.transactionDate.getTime())) return res.status(400).json({ status: "error", message: "Invalid transaction date" });
    if (update.description !== undefined) {
      const identifiers = await getIdentifierCatalog(companyId);
      Object.assign(update, getMatchFields(findIdentifierMatch(update.description, identifiers)));
    }
    const filter = versionId ? { _id: req.params.id, companyId, versionId } : { _id: req.params.id, companyId };
    const data = await Transaction.findOneAndUpdate(filter, { $set: update }, { new: true }).lean();
    if (!data) return res.status(404).json({ status: "error", message: "Audit transaction not found for the current version" });
    await syncVersionSnapshot({ companyId, versionId: data.versionId, transactionId: data._id, updatedRow: { ...data, _id: data._id.toString() } });
    return res.json({ status: "success", data, message: "Transaction updated" });
  } catch (error) { return sendError(res, error); }
};

export const uploadTransactions = async (req, res) => {
  try {
    const { companyId, transactions, fileName = "", label = "", replaceExistingFile = true, financialYearEnding } = req.body;
    if (!companyId || !Array.isArray(transactions) || !transactions.length) return res.status(400).json({ status: "error", message: "Company and transaction rows are required" });

    const validIncomingRows = transactions.filter((row) => {
      const description = String(row?.description || "").trim();
      const debitAmount = number(row?.debitAmount);
      const creditAmount = number(row?.creditAmount);
      const transactionDate = new Date(row?.transactionDate);
      return description && !Number.isNaN(transactionDate.getTime()) && (debitAmount > 0 || creditAmount > 0);
    });
    if (!validIncomingRows.length) return res.status(400).json({ status: "error", message: "No valid transaction rows were found in the uploaded file" });

    const Transaction = await getExpenseAuditTransactionModel();
    const Version = await getExpenseAuditVersionModel();
    const identifiers = await getIdentifierCatalog(companyId);
    const batchId = crypto.randomUUID();
    const year = Number(financialYearEnding || req.body.financialYearEnding || 0);

    if (replaceExistingFile && Number.isInteger(year) && year >= 2000) {
      await Transaction.deleteMany({ companyId, transactionDate: getRange(year) });
    }

    const batchKeys = new Set();
    const duplicateRows = [];
    const docs = validIncomingRows.map((row, index) => {
      const debitAmount = number(row.debitAmount);
      const creditAmount = number(row.creditAmount);
      const description = String(row.description || "").trim();
      const transactionDate = new Date(row.transactionDate);
      const duplicateKey = getDuplicateKey({ transactionDate, description, debitAmount, creditAmount });
      if (batchKeys.has(duplicateKey)) {
        duplicateRows.push({ rowNumber: row.rowNumber || index + 2, description, reason: "Duplicate row within the uploaded file" });
        return null;
      }
      batchKeys.add(duplicateKey);
      const match = findIdentifierMatch(description, identifiers);
      return { companyId, transactionDate, description, debitAmount, creditAmount, amount: debitAmount || creditAmount, direction: debitAmount ? "DEBIT" : creditAmount ? "CREDIT" : "", ...getMatchFields(match), rowNumber: row.rowNumber || null, fileName, importBatchId: batchId, duplicateKey, originalRowData: row.originalRowData || null };
    });
    const validDocs = docs.filter(Boolean);
    if (validDocs.length) await Transaction.insertMany(validDocs);

    if (Number.isInteger(year) && year >= 2000) {
      const versions = await Version.find({ companyId, financialYearEnding: year }).sort({ versionNumber: 1 }).lean();
      const nextVersionNumber = versions.length ? Math.max(...versions.map((item) => Number(item.versionNumber || 0))) + 1 : 1;
      const versionLabel = String(label || "").trim() || `Upload ${nextVersionNumber}`;
      const versionDoc = await Version.create({
        companyId,
        financialYearEnding: year,
        versionNumber: nextVersionNumber,
        label: versionLabel,
        fileName,
        snapshot: [],
        active: true,
        summary: {
          importedCount: validDocs.length,
          duplicateCount: duplicateRows.length,
          identifiedCount: validDocs.filter((row) => row.identifierId).length,
          totalRows: validDocs.length,
        },
        createdBy: actor(req),
      });
      const insertedRows = await Transaction.find({ companyId, importBatchId: batchId }).sort({ transactionDate: 1, rowNumber: 1 }).lean();
      const snapshotRows = insertedRows.map((row) => ({ ...row, _id: row._id.toString(), versionId: versionDoc._id }));
      await Transaction.updateMany({ companyId, importBatchId: batchId }, { $set: { versionId: versionDoc._id } });
      await Version.updateOne({ _id: versionDoc._id }, { $set: { snapshot: snapshotRows } });
      await Version.updateMany({ companyId, financialYearEnding: year, _id: { $ne: versionDoc._id } }, { $set: { active: false } });
    }

    return res.status(201).json({
      status: "success",
      data: {
        importBatchId: batchId,
        importedCount: validDocs.length,
        skippedDuplicateCount: duplicateRows.length,
        skippedInvalidCount: transactions.length - validIncomingRows.length,
        duplicates: duplicateRows,
        identifiedCount: validDocs.filter((row) => row.identifierId).length,
        replacedExistingInstance: Boolean(replaceExistingFile),
      },
      message: duplicateRows.length || transactions.length - validIncomingRows.length
        ? `${validDocs.length} rows imported; ${duplicateRows.length} duplicates skipped; ${transactions.length - validIncomingRows.length} invalid rows ignored`
        : `${validDocs.length} transaction rows imported`,
    });
  } catch (error) { return sendError(res, error); }
};

export const listVersions = async (req, res) => {
  try {
    const Version = await getExpenseAuditVersionModel();
    const companyId = req.params.companyId || req.query.companyId;
    const financialYearEnding = Number(req.params.financialYearEnding || req.query.financialYearEnding || 0);
    const data = await Version.find({ companyId, financialYearEnding }).sort({ versionNumber: 1 }).lean();
    return res.json({ status: "success", data, message: "Audit versions loaded" });
  } catch (error) { return sendError(res, error); }
};

export const checkoutVersion = async (req, res) => {
  try {
    const companyId = req.params.companyId || req.body.companyId;
    const financialYearEnding = Number(req.params.financialYearEnding || req.body.financialYearEnding || 0);
    const Version = await getExpenseAuditVersionModel();
    const version = await Version.findOne({ _id: req.params.versionId || req.body.versionId, companyId, financialYearEnding }).lean();
    if (!version) return res.status(404).json({ status: "error", message: "Version not found" });
    const Transaction = await getExpenseAuditTransactionModel();
    const snapshotRows = Array.isArray(version.snapshot) ? version.snapshot : [];
    await Transaction.deleteMany({ companyId, transactionDate: getRange(financialYearEnding) });
    const restoreDocs = snapshotRows.map((row) => {
      const { _id, ...rest } = row;
      return { ...rest, companyId, versionId: version._id, transactionDate: new Date(rest.transactionDate) };
    });
    if (restoreDocs.length) await Transaction.insertMany(restoreDocs);
    await Version.updateMany({ companyId, financialYearEnding }, { $set: { active: false } });
    await Version.findByIdAndUpdate(version._id, { $set: { active: true } }, { new: true });
    return res.json({ status: "success", data: { ...version, active: true }, message: "Checked out selected upload state" });
  } catch (error) { return sendError(res, error); }
};

export const deleteVersion = async (req, res) => {
  try {
    const companyId = req.params.companyId || req.body.companyId;
    const financialYearEnding = Number(req.params.financialYearEnding || req.body.financialYearEnding || 0);
    const Version = await getExpenseAuditVersionModel();
    const Transaction = await getExpenseAuditTransactionModel();
    const version = await Version.findOne({ _id: req.params.versionId || req.body.versionId, companyId, financialYearEnding }).lean();
    if (!version) return res.status(404).json({ status: "error", message: "Version not found" });

    const remainingVersions = await Version.find({ companyId, financialYearEnding, _id: { $ne: version._id } }).sort({ versionNumber: 1 }).lean();
    const shouldReassignActive = Boolean(version.active);

    await Transaction.deleteMany({ companyId, versionId: version._id });
    await Version.deleteOne({ _id: version._id, companyId, financialYearEnding });

    if (shouldReassignActive) {
      await Version.updateMany({ companyId, financialYearEnding }, { $set: { active: false } });
      if (remainingVersions.length) {
        const fallbackVersion = remainingVersions[remainingVersions.length - 1];
        await Version.updateOne({ _id: fallbackVersion._id, companyId, financialYearEnding }, { $set: { active: true } });
      }
    }

    return res.json({ status: "success", data: { deletedVersionId: String(version._id), remainingVersions: remainingVersions.length }, message: "Upload instance deleted" });
  } catch (error) { return sendError(res, error); }
};

export const getOverview = async (req, res) => {
  try {
    const endingYear = Number(req.query.financialYearEnding);
    const versionId = req.query.versionId || req.body?.versionId || null;
    if (!Number.isInteger(endingYear) || endingYear < 2000 || endingYear > 2200) return res.status(400).json({ status: "error", message: "A valid financial year is required" });
    const Transaction = await getExpenseAuditTransactionModel();
    const filter = { companyId: req.params.companyId, transactionDate: getRange(endingYear) };
    if (versionId) filter.versionId = versionId;
    const rows = await Transaction.find(filter).sort({ transactionDate: -1, rowNumber: 1 }).lean();
    const identifiers = await getIdentifierCatalog(req.params.companyId);
    rows.forEach((row) => {
      if (row.categorySource === "MANUAL") return;
      Object.assign(row, getMatchFields(findIdentifierMatch(row.description, identifiers)));
    });
    const groups = new Map();
    rows.filter((row) => row.identifierId).forEach((row) => {
      const key = String(row.identifierId);
      if (!groups.has(key)) groups.set(key, { identifierId: key, identifierName: row.identifierName, debit: { count: 0, total: 0 }, credit: { count: 0, total: 0 } });
      const group = groups.get(key);
      const bucket = row.direction === "DEBIT" ? group.debit : group.credit;
      bucket.count += 1;
      bucket.total += number(row.amount);
    });
    const identifiedRows = rows.filter((row) => row.identifierId).length;
    const debitTotal = rows.reduce((sum, row) => sum + number(row.debitAmount), 0);
    const creditTotal = rows.reduce((sum, row) => sum + number(row.creditAmount), 0);
    const categoryGroups = new Map();
    rows.filter((row) => row.categoryId).forEach((row) => {
      const key = String(row.categoryId);
      if (!categoryGroups.has(key)) categoryGroups.set(key, { categoryId: key, categoryName: row.categoryName, debit: { count: 0, total: 0 }, credit: { count: 0, total: 0 } });
      const group = categoryGroups.get(key);
      const bucket = row.direction === "DEBIT" ? group.debit : group.credit;
      bucket.count += 1;
      bucket.total += number(row.amount);
    });
    return res.json({ status: "success", data: { rows, groups: [...groups.values()].sort((a, b) => a.identifierName.localeCompare(b.identifierName)), categoryGroups: [...categoryGroups.values()].sort((a, b) => a.categoryName.localeCompare(b.categoryName)), unmatched: rows.filter((row) => !row.categoryId), summary: { totalRows: rows.length, identifiedRows: rows.filter((row) => row.categoryId).length, unmatchedRows: rows.filter((row) => !row.categoryId).length, debitTotal, creditTotal, netAmount: creditTotal - debitTotal } }, message: "Expense audit overview loaded" });
  } catch (error) { return sendError(res, error); }
};
