import mongoose from "mongoose";
import { getAuditLogModel } from "../models/AuditLog.js";

/**
 * Find audit logs with filtering and pagination
 * @param {Object} query - MongoDB query object
 * @param {Object} options - { limit, skip, sort }
 */
export const findAuditLogs = async (query, options = {}) => {
  try {
    const AuditLog = await getAuditLogModel();
    const { limit = 100, skip = 0, sort = { timestamp: -1 } } = options;

    const logs = await AuditLog.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .lean();

    const total = await AuditLog.countDocuments(query);

    return { logs, total };
  } catch (error) {
    throw new Error(`Error finding audit logs: ${error.message}`);
  }
};

/**
 * Find audit logs by company with optional date and module filtering
 */
export const findAuditLogsByCompanyId = async (
  companyId,
  { fromDate, toDate, module, entityType, action, limit = 100, skip = 0 } = {}
) => {
  try {
    const query = { companyId: new mongoose.Types.ObjectId(companyId) };

    // Date range filtering
    if (fromDate || toDate) {
      query.timestamp = {};
      if (fromDate) {
        const startDate = new Date(fromDate);
        startDate.setHours(0, 0, 0, 0);
        query.timestamp.$gte = startDate;
      }
      if (toDate) {
        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);
        query.timestamp.$lte = endDate;
      }
    }

    // Module filtering
    if (module) {
      query.$or = [
        { module: module },
        { module: module.toUpperCase() },
        { module: null, entityType: new RegExp(`^${module}$`, "i") },
        { module: { $exists: false }, entityType: new RegExp(`^${module}$`, "i") },
      ];
    }

    // Entity type filtering
    if (entityType) {
      query.entityType = entityType;
    }

    // Action filtering
    if (action) {
      query.action = action;
    }

    return findAuditLogs(query, { limit, skip });
  } catch (error) {
    throw new Error(`Error finding audit logs by company: ${error.message}`);
  }
};

/**
 * Get audit logs for a specific entity (e.g., journal, invoice, PO)
 */
export const findEntityUpdates = async (
  companyId,
  entityId,
  { entityType, excludeActions = [], limit = 100, skip = 0 } = {}
) => {
  try {
    const query = {
      companyId: new mongoose.Types.ObjectId(companyId),
      entityId: new mongoose.Types.ObjectId(entityId),
    };

    if (entityType) {
      query.entityType = entityType;
    }

    if (excludeActions && excludeActions.length > 0) {
      query.action = { $nin: excludeActions };
    }

    return findAuditLogs(query, { limit, skip, sort: { timestamp: -1 } });
  } catch (error) {
    throw new Error(`Error finding entity updates: ${error.message}`);
  }
};

/**
 * Aggregate audit logs by action type (for summary)
 */
export const aggregateAuditSummary = async (companyId, entityType = null) => {
  try {
    const AuditLog = await getAuditLogModel();

    const matchStage = {
      companyId: new mongoose.Types.ObjectId(companyId),
    };

    if (entityType) {
      matchStage.entityType = entityType;
    }

    const summary = await AuditLog.aggregate([
      {
        $match: matchStage,
      },
      {
        $group: {
          _id: "$action",
          count: { $sum: 1 },
          latestDate: { $max: "$timestamp" },
        },
      },
      {
        $project: {
          action: "$_id",
          count: 1,
          latestDate: 1,
          _id: 0,
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    return summary;
  } catch (error) {
    throw new Error(`Error aggregating audit summary: ${error.message}`);
  }
};

/**
 * Get audit statistics for a specific entity
 */
export const getEntityAuditStats = async (companyId, entityId, entityType) => {
  try {
    const AuditLog = await getAuditLogModel();

    const stats = await AuditLog.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          entityId: new mongoose.Types.ObjectId(entityId),
          entityType: entityType,
        },
      },
      {
        $group: {
          _id: "$performedBy",
          count: { $sum: 1 },
          user: { $first: "$performedByEmail" },
          firstChange: { $min: "$timestamp" },
          lastChange: { $max: "$timestamp" },
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    return stats;
  } catch (error) {
    throw new Error(`Error getting entity audit stats: ${error.message}`);
  }
};

/**
 * Get field change frequency for an entity
 */
export const getEntityFieldFrequency = async (companyId, entityId, entityType) => {
  try {
    const AuditLog = await getAuditLogModel();

    const logs = await AuditLog.find(
      {
        companyId: new mongoose.Types.ObjectId(companyId),
        entityId: new mongoose.Types.ObjectId(entityId),
        entityType: entityType,
      },
      { changes: 1 }
    ).lean();

    const fieldFrequency = {};

    logs.forEach((log) => {
      if (log.changes && typeof log.changes === "object") {
        if (Array.isArray(log.changes)) {
          log.changes.forEach((change) => {
            const field = change.field || "unknown";
            fieldFrequency[field] = (fieldFrequency[field] || 0) + 1;
          });
        } else {
          // If changes is an object, count its keys
          Object.keys(log.changes).forEach((field) => {
            fieldFrequency[field] = (fieldFrequency[field] || 0) + 1;
          });
        }
      }
    });

    return Object.entries(fieldFrequency)
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  } catch (error) {
    throw new Error(`Error getting field frequency: ${error.message}`);
  }
};
