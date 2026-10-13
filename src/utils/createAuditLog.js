import { getAuditLogModel } from "../modules/audit/models/AuditLog.js";

/**
 * Create an audit log entry for tracking changes to entities
 * @param {Object} auditData - Audit log data
 * @param {String} auditData.companyId - Company ID
 * @param {String} auditData.entityType - Type of entity (Invoice, Payment, etc.)
 * @param {String} auditData.entityId - ID of the entity
 * @param {String} auditData.action - Action type (CREATE, UPDATE, DELETE, etc.)
 * @param {String} auditData.userId - User ID who performed the action
 * @param {String} auditData.userEmail - User email for reference
 * @param {String} auditData.userRole - User role for reference
 * @param {Object} auditData.changes - Changes made
 * @param {Object} auditData.oldValues - Old values before change
 * @param {String} auditData.ipAddress - IP address of requester
 * @param {String} auditData.userAgent - User agent string
 * @param {String} auditData.description - Human-readable description
 */
export const createAuditLog = async (auditData) => {
  try {
    // Validate required fields
    if (!auditData.companyId || !auditData.entityType || !auditData.entityId || !auditData.action) {
      console.warn("Audit log missing required fields:", {
        companyId: !!auditData.companyId,
        entityType: !!auditData.entityType,
        entityId: !!auditData.entityId,
        action: !!auditData.action,
      });
      return;
    }

    // Get AuditLog model
    const AuditLog = await getAuditLogModel();

    // Create audit log entry
    const auditEntry = new AuditLog({
      companyId: auditData.companyId,
      entityType: auditData.entityType,
      entityId: auditData.entityId,
      action: auditData.action,
      performedBy: auditData.userId,
      performedByEmail: auditData.userEmail,
      performedByRole: auditData.userRole,
      changes: auditData.changes,
      oldValues: auditData.oldValues,
      newValues: auditData.newValues,
      ipAddress: auditData.ipAddress,
      userAgent: auditData.userAgent,
      status: auditData.status || "SUCCESS",
      errorMessage: auditData.errorMessage,
      module: auditData.module || (auditData.entityType ? auditData.entityType.toUpperCase() : "GENERAL"),
      description: auditData.description,
      relatedEntities: auditData.relatedEntities,
      timestamp: new Date(),
    });

    // Save without session (can be improved with transactions if needed)
    await auditEntry.save();

    console.log(`✅ Audit log created: ${auditData.entityType} ${auditData.action} by ${auditData.userEmail}`);
  } catch (error) {
    // FAIL OPEN: Never block operations due to audit logging failure
    console.error("❌ Audit log error:", {
      error: error.message,
      entityType: auditData.entityType,
      action: auditData.action,
      entityId: auditData.entityId,
    });

    // In production, you might want to:
    // 1. Send alert to monitoring system
    // 2. Log to separate error system
    // 3. Trigger incident response
    // For now, we just log the error
  }
};
