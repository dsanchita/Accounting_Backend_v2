import mongoose from "mongoose";
import {
  findAuditLogsByCompanyId,
  findEntityUpdates,
  aggregateAuditSummary,
  getEntityAuditStats,
  getEntityFieldFrequency,
} from "../repos/auditRepo.js";
import {
  formatValue,
  getFieldLabel,
  getActionLabel,
  formatDate,
  formatTime,
  determineChangeType,
  getChangeDescription,
  getChangeColor,
  getChangeIcon,
} from "../utils/auditHelpers.js";

/**
 * GET /api/audit-logs/:companyId
 * Get all audit logs for a company with optional filtering
 */
export const getAuditLogsController = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { fromDate, toDate, module, entityType, action, limit = 50, skip = 0 } = req.query;

    // Validate companyId
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company ID format",
      });
    }

    // Fetch logs with filters and pagination
    const { logs, total } = await findAuditLogsByCompanyId(companyId, {
      fromDate,
      toDate,
      module,
      entityType,
      action,
      limit: parseInt(limit),
      skip: parseInt(skip),
    });

    // Transform logs for response
    const transformedLogs = logs.map((log) => ({
      id: log._id,
      entityType: log.entityType,
      entityId: log.entityId,
      action: getActionLabel(log.action),
      actionCode: log.action,
      timestamp: log.timestamp,
      date: formatDate(log.timestamp),
      time: formatTime(log.timestamp),
      performedBy: {
        id: log.performedBy,
        name: log.performedByEmail?.split("@")[0] || "Unknown", // Extract name from email
        email: log.performedByEmail || "Unknown",
        role: log.performedByRole || "Unknown",
      },
      module: log.module,
      description: log.description,
      status: log.status,
      changeCount: Array.isArray(log.changes) ? log.changes.length : 0,
      changes: log.changes || [],
      oldValues: log.oldValues,
      newValues: log.newValues,
    }));

    res.status(200).json({
      success: true,
      data: transformedLogs,
      pagination: {
        limit: parseInt(limit),
        skip: parseInt(skip),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
      count: transformedLogs.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/audit-logs/:companyId/summary
 * Get aggregated audit statistics by action type
 */
export const getAuditSummaryController = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { entityType } = req.query;

    // Validate companyId
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company ID format",
      });
    }

    const summary = await aggregateAuditSummary(companyId, entityType || null);

    // Transform summary with action labels
    const transformedSummary = summary.map((item) => ({
      action: getActionLabel(item.action),
      actionCode: item.action,
      count: item.count,
      latestDate: item.latestDate,
      latestDateFormatted: formatDate(item.latestDate),
    }));

    res.status(200).json({
      success: true,
      data: transformedSummary,
      total: transformedSummary.reduce((sum, item) => sum + item.count, 0),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/audit-logs/:companyId/:journalId/journal-updates
 * Get detailed update history for a specific journal
 */
export const getJournalUpdatesController = async (req, res, next) => {
  try {
    const { companyId, journalId } = req.params;
    const { limit = 100 } = req.query;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(journalId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company or journal ID format",
      });
    }

    // Get journal updates only (exclude CREATE/DELETE)
    const { logs, total } = await findEntityUpdates(companyId, journalId, {
      entityType: "Journal",
      excludeActions: ["CREATE", "DELETE"],
      limit: parseInt(limit),
    });

    // Transform logs
    const updates = logs.map((log, index) => ({
      id: log._id,
      sequence: logs.length - index,
      timestamp: log.timestamp,
      date: formatDate(log.timestamp),
      time: formatTime(log.timestamp),
      action: getActionLabel(log.action),
      actionCode: log.action,
      performedBy: {
        id: log.performedBy,
        name: log.performedByEmail?.split("@")[0] || "Unknown",
        email: log.performedByEmail || "Unknown",
        role: log.performedByRole || "Unknown",
      },
      changes: transformChanges(log.changes, "Journal"),
      totalChanges: Array.isArray(log.changes) ? log.changes.length : 0,
    }));

    // Get statistics
    const stats = await getEntityAuditStats(companyId, journalId, "Journal");
    const fieldFrequency = await getEntityFieldFrequency(companyId, journalId, "Journal");

    // Transform stats for response
    const userActivity = stats.map((stat) => ({
      userId: stat._id,
      user: stat.email?.split("@")[0] || "Unknown",
      email: stat.email,
      changeCount: stat.count,
      firstChange: formatDate(stat.firstChange),
      lastChange: formatDate(stat.lastChange),
    }));

    res.status(200).json({
      success: true,
      data: {
        updates,
        summary: {
          journalId,
          totalUpdates: total,
          userActivity: userActivity.slice(0, 5),
          mostChangedFields: fieldFrequency.slice(0, 5).map((item) => ({
            field: getFieldLabel(item.field, "Journal"),
            fieldCode: item.field,
            changeCount: item.count,
          })),
          lastUpdated: updates.length > 0 ? updates[0].timestamp : null,
        },
      },
      count: updates.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/audit-logs/:companyId/:invoiceId/invoice-updates
 * Get detailed update history for a specific invoice
 */
export const getInvoiceUpdatesController = async (req, res, next) => {
  try {
    const { companyId, invoiceId } = req.params;
    const { limit = 100 } = req.query;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(invoiceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company or invoice ID format",
      });
    }

    // Get invoice updates (exclude CREATE/DELETE)
    const { logs, total } = await findEntityUpdates(companyId, invoiceId, {
      entityType: "Invoice",
      excludeActions: ["CREATE", "DELETE"],
      limit: parseInt(limit),
    });

    // Transform logs
    const updates = logs.map((log, index) => ({
      id: log._id,
      sequence: logs.length - index,
      timestamp: log.timestamp,
      date: formatDate(log.timestamp),
      time: formatTime(log.timestamp),
      module: log.module,
      action: getActionLabel(log.action),
      actionCode: log.action,
      performedBy: {
        id: log.performedBy,
        name: log.performedByEmail?.split("@")[0] || "Unknown",
        email: log.performedByEmail || "Unknown",
        role: log.performedByRole || "Unknown",
      },
      changes: transformChanges(log.changes, "Invoice"),
      totalChanges: Array.isArray(log.changes) ? log.changes.length : 0,
    }));

    // Get statistics
    const stats = await getEntityAuditStats(companyId, invoiceId, "Invoice");
    const fieldFrequency = await getEntityFieldFrequency(companyId, invoiceId, "Invoice");

    // Group updates by module if present
    const byModule = {};
    updates.forEach((update) => {
      const mod = update.module || "General";
      byModule[mod] = (byModule[mod] || 0) + 1;
    });

    // Transform stats
    const userActivity = stats.map((stat) => ({
      userId: stat._id,
      user: stat.email?.split("@")[0] || "Unknown",
      email: stat.email,
      changeCount: stat.count,
      firstChange: formatDate(stat.firstChange),
      lastChange: formatDate(stat.lastChange),
    }));

    res.status(200).json({
      success: true,
      data: {
        updates,
        summary: {
          invoiceId,
          totalUpdates: total,
          breakdown: byModule,
          userActivity: userActivity.slice(0, 5),
          mostChangedFields: fieldFrequency.slice(0, 5).map((item) => ({
            field: getFieldLabel(item.field, "Invoice"),
            fieldCode: item.field,
            changeCount: item.count,
          })),
          lastUpdated: updates.length > 0 ? updates[0].timestamp : null,
        },
      },
      count: updates.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/audit-logs/:companyId/:poId/po-updates
 * Get detailed update history for a specific purchase order
 */
export const getPurchaseOrderUpdatesController = async (req, res, next) => {
  try {
    const { companyId, poId } = req.params;
    const { limit = 100 } = req.query;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(poId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company or PO ID format",
      });
    }

    // Get PO updates (exclude CREATE/DELETE)
    const { logs, total } = await findEntityUpdates(companyId, poId, {
      entityType: "PurchaseOrder",
      excludeActions: ["CREATE", "DELETE"],
      limit: parseInt(limit),
    });

    // Transform logs
    const updates = logs.map((log, index) => ({
      id: log._id,
      sequence: logs.length - index,
      timestamp: log.timestamp,
      date: formatDate(log.timestamp),
      time: formatTime(log.timestamp),
      action: getActionLabel(log.action),
      actionCode: log.action,
      performedBy: {
        id: log.performedBy,
        name: log.performedByEmail?.split("@")[0] || "Unknown",
        email: log.performedByEmail || "Unknown",
        role: log.performedByRole || "Unknown",
      },
      changes: transformChanges(log.changes, "PurchaseOrder"),
      totalChanges: Array.isArray(log.changes) ? log.changes.length : 0,
    }));

    // Get statistics
    const stats = await getEntityAuditStats(companyId, poId, "PurchaseOrder");
    const fieldFrequency = await getEntityFieldFrequency(companyId, poId, "PurchaseOrder");

    // Transform stats
    const userActivity = stats.map((stat) => ({
      userId: stat._id,
      user: stat.email?.split("@")[0] || "Unknown",
      email: stat.email,
      changeCount: stat.count,
      firstChange: formatDate(stat.firstChange),
      lastChange: formatDate(stat.lastChange),
    }));

    res.status(200).json({
      success: true,
      data: {
        updates,
        summary: {
          poId,
          totalUpdates: total,
          userActivity: userActivity.slice(0, 5),
          mostChangedFields: fieldFrequency.slice(0, 5).map((item) => ({
            field: getFieldLabel(item.field, "PurchaseOrder"),
            fieldCode: item.field,
            changeCount: item.count,
          })),
          lastUpdated: updates.length > 0 ? updates[0].timestamp : null,
        },
      },
      count: updates.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper: Transform changes array for response
 */
const transformChanges = (changes, entityType = null) => {
  if (!changes) {
    return [];
  }

  // Handle if changes is an array (from logs)
  if (Array.isArray(changes)) {
    return changes
      .filter((change) => change && typeof change === "object")
      .map((change) => ({
        field: change.field,
        fieldLabel: getFieldLabel(change.field, entityType),
        oldValue: formatValue(change.oldValue),
        newValue: formatValue(change.newValue),
        changeType: determineChangeType(change.oldValue, change.newValue),
        icon: getChangeIcon(determineChangeType(change.oldValue, change.newValue)),
        color: getChangeColor(determineChangeType(change.oldValue, change.newValue)),
        description: getChangeDescription(
          getFieldLabel(change.field, entityType),
          formatValue(change.oldValue),
          formatValue(change.newValue),
          determineChangeType(change.oldValue, change.newValue)
        ),
      }));
  }

  // Handle if changes is an object (from oldValues/newValues or key-value updates)
  if (typeof changes === "object") {
    return Object.entries(changes).map(([field, changeObj]) => {
      const isChangeObject =
        changeObj !== null &&
        typeof changeObj === "object" &&
        !Array.isArray(changeObj) &&
        !(changeObj instanceof Date) &&
        (changeObj.oldValue !== undefined ||
          changeObj.newValue !== undefined ||
          changeObj.old !== undefined ||
          changeObj.new !== undefined);

      const oldVal = isChangeObject
        ? changeObj.oldValue !== undefined
          ? changeObj.oldValue
          : changeObj.old !== undefined
            ? changeObj.old
            : null
        : null;

      const newVal = isChangeObject
        ? changeObj.newValue !== undefined
          ? changeObj.newValue
          : changeObj.new !== undefined
            ? changeObj.new
            : null
        : changeObj;

      return {
        field,
        fieldLabel: getFieldLabel(field, entityType),
        oldValue: formatValue(oldVal),
        newValue: formatValue(newVal),
        changeType: determineChangeType(oldVal, newVal),
        icon: getChangeIcon(determineChangeType(oldVal, newVal)),
        color: getChangeColor(determineChangeType(oldVal, newVal)),
        description: getChangeDescription(
          getFieldLabel(field, entityType),
          formatValue(oldVal),
          formatValue(newVal),
          determineChangeType(oldVal, newVal)
        ),
      };
    });
  }

  return [];
};
