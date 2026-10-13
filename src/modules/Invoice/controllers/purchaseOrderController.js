import ApiResponse from "../../../utils/ApiResponse.js";
import AppError from "../../../utils/AppError.js";
import { createAuditLog } from "../../../utils/createAuditLog.js";
import { notifyCompanyAdmins, emitNotification } from "../../../utils/notificationEmitter.js";
import {
  generateWordDocument,
  generatePdfFromWord,
  formatDate,
  sendDocumentResponse,
} from "../../../utils/documentGenerator.js";
import {
  buildTaxMeta,
  normalizeLineItemTax,
  round2,
  deriveLegacyGstTotals,
} from "../utils/taxNormalization.js";
import {
  createPurchaseOrderRepo,
  getPurchaseOrderByIdRepo,
  getPurchaseOrdersRepo,
  getPurchaseOrderByNumberRepo,
  updatePurchaseOrderRepo,
  deletePurchaseOrderRepo,
  getPOsByStatusRepo,
  getPOsWithInvoiceProgressRepo,
} from "../repos/purchaseOrderRepo.js";
import { getInvoicesByPORepo } from "../repos/invoiceRepo.js";
import { findCompanyByIdRepo } from "../../company/repos/companyRepo.js";
import { getPurchaseOrderModel } from "../models/PurchaseOrder.js";

/**
 * Extract first 3-4 letters from vendor name
 * @param {string} vendorName - Full vendor name
 * @returns {string} - 3-4 letter code (uppercase)
 */
const extractClientCode = (vendorName = "") => {
  const cleaned = String(vendorName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  // Return first 4 letters/numbers, or at least 3 if available
  return cleaned.substring(0, 4) || "CLIE";
};

/**
 * Generate unique PO number with format: PO-YYYYMMDD-CLIENT-XXXXX
 * @param {string} companyId - Company ID
 * @param {string} vendorName - Vendor/Client name
 * @param {Date} poDate - Purchase order date
 * @returns {string} - Generated PO number
 */
const generatePONumber = async (companyId, vendorName = "", poDate = new Date()) => {
  try {
    // Format date as YYYYMMDD
    const date = new Date(poDate);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}${month}${day}`;

    // Extract client code (first 3-4 letters)
    const clientCode = extractClientCode(vendorName);

    // Get TOTAL count of all POs for this vendor across ALL time to generate unique number
    const PurchaseOrder = await getPurchaseOrderModel();

    const countForVendor = await PurchaseOrder.countDocuments({
      companyId: companyId,
      "vendor.name": vendorName,
    });

    // Sequential number: counter starts from 10002
    const baseCounter = 10002 + countForVendor;
    let sequenceNumber = String(baseCounter);
    let poNumber = `PO-${dateStr}-${clientCode}-${sequenceNumber}`;

    // Ensure uniqueness in case of race condition or existing PO
    let exists = await PurchaseOrder.findOne({ poNumber, companyId });
    let attempts = 0;
    while (exists && attempts < 100) {
      attempts++;
      sequenceNumber = String(baseCounter + attempts);
      poNumber = `PO-${dateStr}-${clientCode}-${sequenceNumber}`;
      exists = await PurchaseOrder.findOne({ poNumber, companyId });
    }

    return poNumber;
  } catch (error) {
    console.error("Error generating PO number:", error);
    // Fallback to timestamp-based format
    const timestamp = Date.now();
    return `PO-${companyId.toString().slice(-4)}-${timestamp}`;
  }
};

// Map the new paymentTerms value to the legacy billingModel field
const billingModelMap = {
  milestone: "milestone",
  monthly: "fixed",
  hourly: "hourly",
};

const normalizeStateCode = (value = "") => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "";
  const digitMatch = normalized.match(/^(\d{2})/);
  if (digitMatch) return digitMatch[1];
  const alphaMatch = normalized.match(/^([A-Z]{2})/);
  return alphaMatch ? alphaMatch[1] : normalized;
};

const getGstSplit = (fromAddress = {}, toAddress = {}) => {
  const fromStateCode = normalizeStateCode(fromAddress?.stateCode);
  const toStateCode = normalizeStateCode(toAddress?.stateCode);

  if (!fromStateCode || !toStateCode) return undefined;
  return fromStateCode === toStateCode ? "INTRA" : "INTER";
};

const getCompanyStateCode = (company = {}) =>
  normalizeStateCode(
    company?.registeredAddress?.stateCode ||
    company?.taxDetails?.gstin
  );
const getPartyStateCode = (party = {}) =>
  normalizeStateCode(party?.stateCode || party?.gstStateCode || party?.GSTIN || party?.gstin);

const getCompanyBasedGstSplit = (company = {}, party = {}) => {
  const companyStateCode = getCompanyStateCode(company);
  const partyStateCode = getPartyStateCode(party);

  if (!companyStateCode || !partyStateCode) return undefined;
  return companyStateCode === partyStateCode ? "INTRA" : "INTER";
};

const getPoGstSplit = (company = {}, vendor = {}, deliverTo = {}) => {
  // For Indian GST, the tax split should follow the delivery/place-of-supply
  // address when it is available. The frontend recalculates from deliverTo, so
  // the backend must use the same source instead of falling back to vendor.
  return (
    getCompanyBasedGstSplit(company, deliverTo) ||
    getCompanyBasedGstSplit(company, vendor) ||
    getGstSplit(vendor, deliverTo)
  );
};

const toPlainObject = (doc) => JSON.parse(JSON.stringify(doc || {}));

const getChangedFields = (oldDoc = {}, nextData = {}) =>
  Object.keys(nextData)
    .filter((key) => !["updateHistory", "approvalHistory", "rejectionHistory"].includes(key))
    .filter((key) => JSON.stringify(oldDoc?.[key]) !== JSON.stringify(nextData?.[key]))
    .map((key) => ({
      field: key,
      oldValue: oldDoc?.[key],
      newValue: nextData?.[key],
    }));

export const createPurchaseOrder = async (req, res, next) => {
  try {
    const {
      poDate,
      deliveryDate,
      poCategory,
      billingModel,
      direction,
      paymentTerms,
      vendor,
      deliverTo,
      items,
      companyId,
      notes,
      milestones,
      resources,
      poreferencevalue,
      paymentSchedule,
      staffingConfig,
      withSignature,
    } = req.body;

    const company = companyId ? await findCompanyByIdRepo(companyId) : null;

    // ── Totals ────────────────────────────────────────────────────
    let totalTaxableValue = 0;
    let totalAmount = 0;

    // INTRA = CGST+SGST, INTER = IGST. Prefer deliverTo because users can
    // change it independently of the party master.
    const gstSplit = getPoGstSplit(company, vendor, deliverTo);

    const normalizedItems = Array.isArray(items)
      ? items.map((item) => {
        const normalizedTax = normalizeLineItemTax(item, {
          taxType: req.body.taxType,
          taxLabel: req.body.taxLabel,
          gstSplit,
        });
        const taxableValue = Number(item.taxableValue) || 0;
        const totalAmountValue =
          Number(item.totalAmount) ||
          Number(item.total) ||
          taxableValue + Number(normalizedTax.taxAmount || normalizedTax.gstAmount || 0) ||
          0;

        totalTaxableValue += taxableValue;
        totalAmount += totalAmountValue;

        return {
          ...item,
          hsnId: item.hsnId ? String(item.hsnId) : undefined,
          hsnSac: item.hsnSac || "",
          unit: item.unit || "each",
          quantity: Number(item.quantity) || 0,
          rate: Number(item.rate) || 0,
          taxableValue,
          totalAmount: totalAmountValue,
          ...normalizedTax,
          // CRITICAL: Ensure all tax fields are aligned with recalculated normalized values
          taxRate: normalizedTax.taxRate,
          taxAmount: normalizedTax.taxAmount,
          gstRate: normalizedTax.gstRate,
          gstAmount: normalizedTax.gstAmount,
          combinedTaxRate: normalizedTax.combinedTaxRate,
        };
      })
      : [];

    const computedTaxMeta = buildTaxMeta({
      taxType: req.body.taxType,
      taxLabel: req.body.taxLabel,
      taxSummary: undefined, // Let it recalculate from items
      totalTaxAmount: undefined, // ← Don't pass frontend value, recalculate from items
      items: normalizedItems,
    });

    // For milestone POs the totals are set at contract level, not item level
    if (paymentTerms === "milestone") {
      totalTaxableValue = Number(req.body.totalTaxableValue) || totalTaxableValue;
      totalAmount = Number(req.body.totalAmount) || totalAmount;

      // For milestone POs, rebuild tax meta with contract-level totals and ensure proper CGST/SGST split
      const totalTaxAmount = totalAmount - totalTaxableValue;
      const taxSummary = req.body.taxSummary || [];

      // If no tax summary provided but we have tax amount, generate it based on gstSplit
      if (taxSummary.length === 0 && totalTaxAmount > 0 && gstSplit) {
        if (gstSplit === "INTRA") {
          // Split equally between CGST and SGST
          const halfTax = round2(totalTaxAmount / 2);
          taxSummary.push(
            { taxType: "CGST", label: "CGST", rate: 0, amount: halfTax },
            { taxType: "SGST", label: "SGST", rate: 0, amount: round2(totalTaxAmount - halfTax) }
          );
        } else if (gstSplit === "INTER") {
          // All tax goes to IGST
          taxSummary.push(
            { taxType: "IGST", label: "IGST", rate: 0, amount: totalTaxAmount }
          );
        }
      }

      // Rebuild tax meta with corrected data
      const legacyTotals = deriveLegacyGstTotals(taxSummary);
      Object.assign(computedTaxMeta, {
        taxSummary,
        totalTaxAmount: round2(totalTaxAmount),
        ...legacyTotals,
      });
    }

    // ── Milestone defaults ────────────────────────────────────────
    // Auto-assign milestoneNo and default status here in the controller
    // so we never rely on a pre-save hook (unreliable with getDatabase()).
    const normalizedMilestones = Array.isArray(milestones)
      ? milestones.map((m, index) => ({
        ...m,
        milestoneNo: m.milestoneNo || index + 1,
        status: m.status || "pending",
        amount: Number(m.amount) || 0,
      }))
      : [];

    const poNumber = await generatePONumber(companyId, vendor?.name || "", poDate);

    const poData = {
      companyId,
      poNumber,
      poDate: new Date(poDate),
      deliveryDate: new Date(deliveryDate),

      // New fields
      direction: direction || "receivable",
      paymentTerms: paymentTerms || "monthly",

      // Legacy fields — kept for backward compat
      poCategory: poCategory || "project",
      billingModel: billingModel || billingModelMap[paymentTerms] || "fixed",

      vendor,
      deliverTo,

      // Items — hsnId comes as a String from frontend, stored as String
      items: normalizedItems,

      milestones: normalizedMilestones,
      resources: Array.isArray(resources) ? resources : [],
      attendanceRecords: [],

      totalTaxableValue: round2(totalTaxableValue),
      taxType: computedTaxMeta.taxType,
      taxLabel: computedTaxMeta.taxLabel,
      taxSummary: computedTaxMeta.taxSummary,
      totalTaxAmount: computedTaxMeta.totalTaxAmount,
      totalGSTAmount: computedTaxMeta.totalGSTAmount,
      totalCGSTAmount: computedTaxMeta.totalCGSTAmount,
      totalSGSTAmount: computedTaxMeta.totalSGSTAmount,
      totalIGSTAmount: computedTaxMeta.totalIGSTAmount,
      totalAmount: round2(totalAmount),
      valueInWords: req.body.valueInWords || `${totalAmount} only`,

      notes,
      withSignature: withSignature || false,

      // Approval fields
      approvalStatus: "Pending",
      actionType: "create",

      ...(poreferencevalue && { poreferencevalue }),
      ...(paymentSchedule && { paymentSchedule }),
      ...(staffingConfig && { staffingConfig }),

      // Store user id as String — User lives in a different DB
      createdBy: req.user?.id ? String(req.user.id) : undefined,
      updatedBy: req.user?.id ? String(req.user.id) : undefined,
    };

    const po = await createPurchaseOrderRepo(poData);

    await createAuditLog({
      companyId,
      entityType: "PurchaseOrder",
      entityId: po._id,
      action: "CREATE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: [],
      newValues: po,
      description: `Purchase Order created: ${po.poNumber}`,
    });

    // Notify company admins about new PO
    notifyCompanyAdmins({
      companyId: companyId,
      title: "New Purchase Order Created",
      message: `Purchase Order ${po.poNumber} has been created and is pending approval.`,
      type: "APPROVAL_REQUEST",
      relatedEntity: {
        entityType: "PO",
        entityId: po._id.toString()
      },
      senderName: req.user?.name || "System User"
    });

    new ApiResponse({
      statusCode: 201,
      data: po,
      message: "Purchase Order created successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getAllPurchaseOrders = async (req, res, next) => {
  try {
    const { 
      companyId, 
      status, 
      approvalStatus,
      direction, 
      paymentTerms, 
      poNumber,
      clientName,
      clientId,
      vendorId,
      invoiceState,
      poStatus,
      poDateFrom,
      poDateTo,
      createdDateFrom,
      createdDateTo,
      updatedDateFrom,
      updatedDateTo,
      deliveryDateFrom,
      deliveryDateTo,
      limit = 1000,
      skip = 0
    } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getAllPurchaseOrders");
    }

    const requestedStatus = poStatus || status;
    const filter = { companyId };
    if (approvalStatus) filter.approvalStatus = approvalStatus;
    if (direction) filter.direction = direction;
    if (paymentTerms) filter.paymentTerms = paymentTerms;
    if (clientId) filter["vendor._id"] = clientId;
    if (vendorId) filter["vendor._id"] = vendorId;

    // PO Number search (partial match)
    if (poNumber) {
      filter.poNumber = { $regex: poNumber, $options: "i" };
    }

    // Client Name search (partial match on vendor.name or client.name)
    if (clientName) {
      filter.$or = [
        { "vendor.name": { $regex: clientName, $options: "i" } },
        { "client.name": { $regex: clientName, $options: "i" } },
      ];
    }

    const addDateRangeFilter = (field, from, to) => {
      if (!from && !to) return;
      filter[field] = {};
      if (from) filter[field].$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter[field].$lte = end;
      }
    };

    addDateRangeFilter("poDate", poDateFrom, poDateTo);
    addDateRangeFilter("createdAt", createdDateFrom, createdDateTo);
    addDateRangeFilter("updatedAt", updatedDateFrom, updatedDateTo);
    addDateRangeFilter("deliveryDate", deliveryDateFrom, deliveryDateTo);

    // Invoice State filter (derived from totalAmount and totalInvoicedAmount)
    // This will be handled by filtering the results since it requires calculation
    
    const pos = await getPurchaseOrdersRepo(filter);

    const getDerivedStatus = (po = {}) => {
      if (po.status === "CLOSED") return "CLOSED";
      const totalAmount = Number(po.totalAmount || 0);
      const totalInvoicedAmount = Number(po.totalInvoicedAmount || 0);
      if (totalInvoicedAmount >= totalAmount && totalAmount > 0) return "FULLY_INVOICED";
      if (totalInvoicedAmount > 0) return "PARTIALLY_INVOICED";
      return "OPEN";
    };

    // Post-process status and invoiceState filters because the UI displays
    // status derived from invoice progress, not only the stored PO status field.
    let filteredPos = pos;
    if (requestedStatus) {
      filteredPos = filteredPos.filter((po) => getDerivedStatus(po) === requestedStatus);
    }

    if (invoiceState) {
      filteredPos = filteredPos.filter(po => {
        const totalAmount = po.totalAmount || 0;
        const totalInvoicedAmount = po.totalInvoicedAmount || 0;

        if (invoiceState === "OPEN_NO_INVOICE") {
          return totalInvoicedAmount <= 0;
        } else if (invoiceState === "PARTIALLY_INVOICED") {
          return totalInvoicedAmount > 0 && totalInvoicedAmount < totalAmount;
        } else if (invoiceState === "FULLY_INVOICED") {
          return totalInvoicedAmount >= totalAmount && totalAmount > 0;
        } else if (invoiceState === "FULLY_PAID") {
          return po.status === "CLOSED" && totalInvoicedAmount >= totalAmount;
        }
        return true;
      });
    }

    // Apply pagination
    const paginatedPos = filteredPos.slice(Number(skip), Number(skip) + Number(limit));

    new ApiResponse({
      statusCode: 200,
      data: paginatedPos,
      total: filteredPos.length,
      message: "Purchase Orders retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getPurchaseOrderById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Purchase Order ID is required", 400, "getPurchaseOrderById");
    }

    const po = await getPurchaseOrderByIdRepo(id);

    // Fetch linked invoices and attach to PO
    const linkedInvoices = await getInvoicesByPORepo(id);
    po.linkedInvoices = linkedInvoices;

    new ApiResponse({
      statusCode: 200,
      data: po,
      message: "Purchase Order retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const updatePurchaseOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!id) {
      throw new AppError("Purchase Order ID is required", 400, "updatePurchaseOrder");
    }

    const oldPO = await getPurchaseOrderByIdRepo(id);
    const company = oldPO?.companyId ? await findCompanyByIdRepo(oldPO.companyId) : null;

    // Keep billingModel in sync with paymentTerms
    if (updateData.paymentTerms && !updateData.billingModel) {
      updateData.billingModel = billingModelMap[updateData.paymentTerms] || "fixed";
    }

    // Normalize milestones if present
    if (Array.isArray(updateData.milestones)) {
      updateData.milestones = updateData.milestones.map((m, index) => ({
        ...m,
        milestoneNo: m.milestoneNo || index + 1,
        status: m.status || "pending",
      }));
    }

    if (updateData.paymentTerms && updateData.paymentTerms !== oldPO.paymentTerms) {
      if (updateData.paymentTerms !== "milestone") {
        // Switching away from milestone → wipe milestones
        updateData.milestones = [];
      } else {
        // Switching to milestone → wipe schedule-based fields
        updateData.invoiceSchedule = null;
        updateData.paymentSchedule = null;
      }
    }

    // Normalize hsnId to String on items and recalculate totals
    let totalTaxableValue = 0;
    let totalAmount = 0;

    if (Array.isArray(updateData.items)) {
      const gstSplit = getPoGstSplit(
        company,
        updateData.vendor || oldPO.vendor,
        updateData.deliverTo || oldPO.deliverTo,
      );

      updateData.items = updateData.items.map((item) => {
        const normalizedTax = normalizeLineItemTax(item, {
          taxType: updateData.taxType || oldPO.taxType,
          taxLabel: updateData.taxLabel || oldPO.taxLabel,
          gstSplit,
        });

        const taxableValue = Number(item.taxableValue) || 0;
        const totalAmountValue =
          Number(item.totalAmount) ||
          Number(item.total) ||
          taxableValue + Number(normalizedTax.taxAmount || normalizedTax.gstAmount || 0) ||
          0;

        totalTaxableValue += taxableValue;
        totalAmount += totalAmountValue;

        return {
          ...item,
          hsnId: item.hsnId ? String(item.hsnId) : undefined,
          taxableValue,
          totalAmount: totalAmountValue,
          ...normalizedTax,
          // CRITICAL: Ensure all tax fields are aligned with recalculated normalized values
          // These override any stale values from the request item
          taxRate: normalizedTax.taxRate,
          taxAmount: normalizedTax.taxAmount,
          gstRate: normalizedTax.gstRate,
          gstAmount: normalizedTax.gstAmount,
          combinedTaxRate: normalizedTax.combinedTaxRate,
        };
      });

      // Update totals in updateData so they get saved
      updateData.totalTaxableValue = round2(totalTaxableValue);
      updateData.totalAmount = round2(totalAmount);
    }

    // ── FIX: Always rebuild tax meta from items when items are present ──
    // This ensures PO-level totals (totalTaxAmount, totalCGSTAmount, etc.) are recalculated
    // and not left stale from previous save.
    if (Array.isArray(updateData.items)) {
      const taxMeta = buildTaxMeta({
        taxType: updateData.taxType || oldPO.taxType,
        taxLabel: updateData.taxLabel || oldPO.taxLabel,
        taxSummary: undefined, // Don't pass old summary, let it rebuild from items
        totalTaxAmount: undefined, // ← CRITICAL: Don't pass old amount, let it recalculate from items
        items: updateData.items || [], // Use freshly recalculated items
      });
      updateData.taxType = taxMeta.taxType;
      updateData.taxLabel = taxMeta.taxLabel;
      updateData.taxSummary = taxMeta.taxSummary;
      updateData.totalTaxAmount = taxMeta.totalTaxAmount;
      updateData.totalGSTAmount = taxMeta.totalGSTAmount;
      updateData.totalCGSTAmount = taxMeta.totalCGSTAmount;
      updateData.totalSGSTAmount = taxMeta.totalSGSTAmount;
      updateData.totalIGSTAmount = taxMeta.totalIGSTAmount;
    }

    const changes = getChangedFields(oldPO, updateData);
    const updatedPO = await updatePurchaseOrderRepo(id, {
      ...updateData,
      approvalStatus: updateData.approvalStatus || "Pending",
      approvedBy: null,
      approvalDate: null,
      rejectionReason: null,
      rejectedBy: null,
      rejectedAt: null,
      updateHistory: [
        ...(oldPO.updateHistory || []),
        {
          snapshot: toPlainObject(oldPO),
          changes,
          updatedBy: req.user?.id ? String(req.user.id) : undefined,
          updatedAt: new Date(),
        },
      ],
      approvalHistory: [
        ...(oldPO.approvalHistory || []),
        {
          status: "Pending",
          action: oldPO.approvalStatus === "Rejected" ? "RESUBMIT" : "UPDATE_SUBMIT",
          comments:
            oldPO.approvalStatus === "Rejected"
              ? "Rejected purchase order edited and resubmitted for approval"
              : "Purchase order update submitted for approval",
          performedBy: req.user?.id ? String(req.user.id) : undefined,
          performedAt: new Date(),
        },
      ],
      actionType: "update",
      updatedBy: req.user?.id ? String(req.user.id) : undefined,
    });

    // Compute changes for audit log
    await createAuditLog({
      companyId: oldPO.companyId,
      entityType: "PurchaseOrder",
      entityId: id,
      action: "UPDATE",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: changes,
      oldValues: oldPO,
      newValues: updatedPO,
      description: `Purchase Order updated: ${oldPO.poNumber}`,
    });

    // Handle approval notification if status changed
    if (updateData.approvalStatus && updateData.approvalStatus !== oldPO.approvalStatus) {
      if (oldPO.createdBy) {
        emitNotification({
          companyId: oldPO.companyId,
          recipientId: oldPO.createdBy.toString(),
          title: `Purchase Order ${updateData.approvalStatus}`,
          message: `Your purchase order ${oldPO.poNumber} has been ${updateData.approvalStatus.toLowerCase()}.`,
          type: updateData.approvalStatus.toUpperCase(),
          relatedEntity: {
            entityType: "PO",
            entityId: id.toString()
          },
          senderName: req.user?.name || "System User"
        });
      }
    }

    new ApiResponse({
      statusCode: 200,
      data: updatedPO,
      message: "Purchase Order updated successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const deletePurchaseOrder = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Purchase Order ID is required", 400, "deletePurchaseOrder");
    }

    const po = await getPurchaseOrderByIdRepo(id);

    await updatePurchaseOrderRepo(id, {
      approvalStatus: "Pending",
      actionType: "delete",
      updatedBy: req.user?.id ? String(req.user.id) : undefined,
    });

    await createAuditLog({
      companyId: po.companyId,
      entityType: "PurchaseOrder",
      entityId: id,
      action: "DELETE_REQUEST",
      userId: req.user?.id,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      changes: [],
      oldValues: po,
      description: `Purchase Order deletion requested: ${po.poNumber}`,
    });

    new ApiResponse({
      statusCode: 200,
      data: null,
      message: "Purchase Order deletion requested successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getPurchaseOrderByNumber = async (req, res, next) => {
  try {
    const { poNumber, q, companyId, clientId, vendorId, clientName } = req.query;
    const searchTerm = poNumber || q;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getPurchaseOrderByNumber");
    }

    // Search for PO numbers that match (partial match)
    const PurchaseOrder = await getPurchaseOrderModel();
    const filter = {
      companyId,
      approvalStatus: "Approved",
    };

    if (searchTerm) filter.poNumber = { $regex: searchTerm, $options: "i" };
    if (clientId) filter["vendor._id"] = clientId;
    if (vendorId) filter["vendor._id"] = vendorId;
    if (clientName) filter["vendor.name"] = { $regex: clientName, $options: "i" };

    const pos = await PurchaseOrder.find(filter)
      .sort({ poDate: -1, createdAt: -1 })
      .limit(20);

    // Return array of matching PO numbers with label format for dropdown
    const results = pos.map(po => ({
      label: po.poNumber,
      _id: po._id,
    }));

    new ApiResponse({
      statusCode: 200,
      data: results,
      message: "Purchase Orders search completed",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getPOStats = async (req, res, next) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      throw new AppError("companyId is required", 400, "getPOStats");
    }

    const stats = await getPOsWithInvoiceProgressRepo(companyId);

    new ApiResponse({
      statusCode: 200,
      data: stats,
      message: "PO statistics retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const getPOsByStatus = async (req, res, next) => {
  try {
    const { companyId, status } = req.query;

    if (!companyId || !status) {
      throw new AppError("companyId and status are required", 400, "getPOsByStatus");
    }

    const pos = await getPOsByStatusRepo(companyId, status);

    new ApiResponse({
      statusCode: 200,
      data: pos,
      message: `Purchase Orders with status '${status}' retrieved successfully`,
    }).send(res);
  } catch (error) {
    next(error);
  }
};

// ============================================
// Download Functions
// ============================================

/**
 * Prepare purchase order data for template
 */
const preparePurchaseOrderData = (purchaseOrder) => {
  const data = {
    // Header
    PurchaseOrderNo: purchaseOrder.poNumber,
    poDate: formatDate(purchaseOrder.poDate),
    DueDate: formatDate(purchaseOrder.deliveryDate),
    purchaseorderreference: purchaseOrder.poreferencevalue || "",
    referenceDate: formatDate(purchaseOrder.referenceDate),
    Currency: purchaseOrder.currency || "INR",
    AmountDue: purchaseOrder.totalAmount?.toFixed(2) || "0.00",
    PaymentMode: purchaseOrder.paymentTerms || "",

    // Bill To / Ship To
    BillToClientName: purchaseOrder.vendor?.name || "",
    BillToAddress: purchaseOrder.vendor?.address || "",
    BillToStateCode: purchaseOrder.vendor?.stateCode || "",
    BillToGSTIN: purchaseOrder.vendor?.GSTIN || "",
    ShipToClientName: purchaseOrder.deliverTo?.name || "",
    ShipToAddress: purchaseOrder.deliverTo?.address || "",
    ShipToStateCode: purchaseOrder.deliverTo?.stateCode || "",
    ShipToGSTIN: purchaseOrder.deliverTo?.GSTIN || "",

    // Totals
    TotalTaxableValue: purchaseOrder.totalTaxableValue?.toFixed(2) || "0.00",
    ValueInFigure: purchaseOrder.valueInWords || "",
    CGST: purchaseOrder.totalCGSTAmount?.toFixed(2) || "0.00",
    SGST: purchaseOrder.totalSGSTAmount?.toFixed(2) || "0.00",
    IGST: purchaseOrder.totalIGSTAmount?.toFixed(2) || "0.00",

    // Items array for looping
    items: (purchaseOrder.items || []).map((item, idx) => ({
      index: idx + 1,
      description: item.description || "",
      hsnSac: item.hsnSac || "",
      quantity: item.quantity,
      rate: (item.rate || 0).toFixed(2),
      taxableValue: (item.taxableValue || 0).toFixed(2),
      gstRate: item.gstRate || 0,
      gstAmount: (item.gstAmount || 0).toFixed(2),
      total: (item.totalAmount || item.total || 0).toFixed(2),
    })),
  };
  return data;
};

/**
 * Download Purchase Order as Word document
 */
export const downloadWordPurchaseOrder = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Purchase Order ID is required", 400, "downloadWordPurchaseOrder");
    }

    const purchaseOrder = await getPurchaseOrderByIdRepo(id);

    if (!purchaseOrder) {
      throw new AppError("Purchase Order not found", 404, "downloadWordPurchaseOrder");
    }
    if (purchaseOrder.approvalStatus !== "Approved") {
      throw new AppError("Only approved purchase orders can be downloaded", 400, "downloadWordPurchaseOrder");
    }

    const templateName = purchaseOrder.withSignature
      ? "PurchaseOrder-Template With Signature.docx"
      : "PurchaseOrder-Template Without Signature.docx";

    const templateData = preparePurchaseOrderData(purchaseOrder);
    const buffer = await generateWordDocument(templateName, templateData);

    sendDocumentResponse(
      res,
      buffer,
      `PurchaseOrder_${purchaseOrder.poNumber}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Download Purchase Order as PDF document
 */
export const downloadPdfPurchaseOrder = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Purchase Order ID is required", 400, "downloadPdfPurchaseOrder");
    }

    const purchaseOrder = await getPurchaseOrderByIdRepo(id);

    if (!purchaseOrder) {
      throw new AppError("Purchase Order not found", 404, "downloadPdfPurchaseOrder");
    }
    if (purchaseOrder.approvalStatus !== "Approved") {
      throw new AppError("Only approved purchase orders can be downloaded", 400, "downloadPdfPurchaseOrder");
    }

    const templateName = purchaseOrder.withSignature
      ? "PurchaseOrder-Template With Signature.docx"
      : "PurchaseOrder-Template Without Signature.docx";

    const templateData = preparePurchaseOrderData(purchaseOrder);
    const wordBuffer = await generateWordDocument(templateName, templateData);
    const pdfBuffer = await generatePdfFromWord(wordBuffer);

    sendDocumentResponse(
      res,
      pdfBuffer,
      `PurchaseOrder_${purchaseOrder.poNumber}.pdf`,
      "application/pdf"
    );
  } catch (error) {
    next(error);
  }
};

export const getPendingApprovals = async (req, res, next) => {
  try {
    const { companyId } = req.query;
    if (!companyId) {
      throw new AppError("companyId is required", 400, "getPendingApprovals");
    }
    const PurchaseOrder = await getPurchaseOrderModel();
    const pos = await PurchaseOrder.find({ companyId, approvalStatus: "Pending" })
      .sort({ updatedAt: -1 })
      .lean();

    new ApiResponse({
      statusCode: 200,
      data: pos.map(po => ({ ...po, client: po.vendor })),
      message: "Pending Purchase Orders retrieved successfully",
    }).send(res);
  } catch (error) {
    next(error);
  }
};

export const updatePurchaseOrderApproval = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { approvalStatus, approvalComments } = req.body;

    if (!id) {
      throw new AppError("Purchase Order ID is required", 400, "updatePurchaseOrderApproval");
    }

    const po = await getPurchaseOrderByIdRepo(id);

    if (approvalStatus === "Approved") {
      if (po.actionType === "delete") {
        await deletePurchaseOrderRepo(id);

        await createAuditLog({
          companyId: po.companyId,
          entityType: "PurchaseOrder",
          entityId: id,
          action: "DELETE",
          userId: req.user?.id,
          userEmail: req.user?.email,
          userRole: req.user?.role,
          description: `Purchase Order deleted: ${po.poNumber}`,
        });

        return new ApiResponse({
          statusCode: 200,
          data: null,
          message: "Purchase Order deleted successfully",
        }).send(res);
      } else {
        const updatedPO = await updatePurchaseOrderRepo(id, {
          approvalStatus: "Approved",
          approvedBy: req.user?.id ? String(req.user.id) : undefined,
          approvalDate: new Date(),
          approvalComments,
          rejectionReason: null,
          rejectedBy: null,
          rejectedAt: null,
          approvalHistory: [
            ...(po.approvalHistory || []),
            {
              status: "Approved",
              action: "APPROVE",
              comments: approvalComments,
              performedBy: req.user?.id ? String(req.user.id) : undefined,
              performedAt: new Date(),
            },
          ],
        });

        await createAuditLog({
          companyId: po.companyId,
          entityType: "PurchaseOrder",
          entityId: id,
          action: po.actionType === "create" ? "CREATE_APPROVE" : "UPDATE_APPROVE",
          userId: req.user?.id,
          userEmail: req.user?.email,
          userRole: req.user?.role,
          description: `Purchase Order approved: ${po.poNumber}`,
        });

        return new ApiResponse({
          statusCode: 200,
          data: updatedPO,
          message: "Purchase Order approved successfully",
        }).send(res);
      }
    } else if (approvalStatus === "Rejected") {
      const reason = String(approvalComments || req.body.rejectionReason || "").trim();
      if (!reason) {
        throw new AppError("Rejection reason is required", 400, "updatePurchaseOrderApproval");
      }

      const updatedPO = await updatePurchaseOrderRepo(id, {
        approvalStatus: "Rejected",
        approvedBy: req.user?.id ? String(req.user.id) : undefined,
        approvalDate: new Date(),
        approvalComments: reason,
        rejectionReason: reason,
        rejectedBy: req.user?.id ? String(req.user.id) : undefined,
        rejectedAt: new Date(),
        approvalHistory: [
          ...(po.approvalHistory || []),
          {
            status: "Rejected",
            action: "REJECT",
            reason,
            comments: reason,
            performedBy: req.user?.id ? String(req.user.id) : undefined,
            performedAt: new Date(),
          },
        ],
        rejectionHistory: [
          ...(po.rejectionHistory || []),
          {
            status: "Rejected",
            action: "REJECT",
            reason,
            comments: reason,
            performedBy: req.user?.id ? String(req.user.id) : undefined,
            performedAt: new Date(),
          },
        ],
      });

      await createAuditLog({
        companyId: po.companyId,
        entityType: "PurchaseOrder",
        entityId: id,
        action: "REJECT",
        userId: req.user?.id,
        userEmail: req.user?.email,
        userRole: req.user?.role,
        description: `Purchase Order rejected: ${po.poNumber}`,
      });

      return new ApiResponse({
        statusCode: 200,
        data: updatedPO,
        message: "Purchase Order rejected successfully",
      }).send(res);
    } else {
      throw new AppError("Invalid approvalStatus", 400, "updatePurchaseOrderApproval");
    }
  } catch (error) {
    next(error);
  }
};
