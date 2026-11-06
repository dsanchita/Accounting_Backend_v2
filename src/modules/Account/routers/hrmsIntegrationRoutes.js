import express from "express";
import { protect } from "../../../middlewares/authMiddleware.js";
import { accessControlMiddleware } from "../../../middlewares/accessBasedMiddleware.js";
import { verifyHrmsIntegrationSignature } from "../../../middlewares/hrmsIntegrationAuth.js";
import {
  createSettlement,
  getClaimsReport,
  getIntegrationEvent,
  getMappings,
  getEmployeePayableReconciliation,
  getSalaryRecords,
  listEmployeePayablesAdmin,
  listEmployeeSettlements,
  listOpenEmployeePayables,
  postClaimAccrual,
  postClaimSettlement,
  postPayrollAccrual,
  postPayrollSettlement,
  reverseSettlement,
  saveMappings,
} from "../controllers/hrmsIntegrationController.js";

const router = express.Router();

const adminOnly = (req, res, next) => {
  if (!["admin", "superAdmin"].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: "Accounting administrator access required" });
  }
  const companyId = String(req.params.companyId || "");
  const hasCompanyScope =
    req.user.role === "superAdmin" ||
    (req.user.permissions || []).some((permission) =>
      String(permission.company?._id || permission.companyId || permission.company) === companyId
    );
  if (!companyId || !hasCompanyScope) {
    return res.status(403).json({ success: false, message: "You do not have access to this company" });
  }
  next();
};

router.post("/payroll-accruals", verifyHrmsIntegrationSignature, postPayrollAccrual);
router.post("/payroll-settlements", verifyHrmsIntegrationSignature, postPayrollSettlement);
router.post("/claim-accruals", verifyHrmsIntegrationSignature, postClaimAccrual);
router.post("/claim-settlements", verifyHrmsIntegrationSignature, postClaimSettlement);
router.get("/events/:eventId", verifyHrmsIntegrationSignature, getIntegrationEvent);

router.get("/admin/:companyId", protect, adminOnly, listEmployeePayablesAdmin);
router.get("/admin/:companyId/mappings", protect, adminOnly, getMappings);
router.put("/admin/:companyId/mappings", protect, adminOnly, saveMappings);
router.get(
  "/company/:companyId",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "VIEW", companyIdSource: "params.companyId" }),
  listEmployeePayablesAdmin
);

router.get(
  "/payables",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "VIEW", companyIdSource: "query.companyId" }),
  listOpenEmployeePayables
);
router.get(
  "/salary-records",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "VIEW", companyIdSource: "query.companyId" }),
  getSalaryRecords
);
router.get(
  "/claims-report",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "VIEW", companyIdSource: "query.companyId" }),
  getClaimsReport
);
router.get(
  "/reconciliation",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "VIEW", companyIdSource: "query.companyId" }),
  getEmployeePayableReconciliation
);
router.post(
  "/settlements",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "CREATE", companyIdSource: "body.companyId" }),
  createSettlement
);
router.get(
  "/settlements",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "VIEW", companyIdSource: "query.companyId" }),
  listEmployeeSettlements
);
router.post(
  "/settlements/:settlementId/reversals",
  protect,
  accessControlMiddleware({ entityKey: "JOURNAL", action: "CREATE", companyIdSource: "body.companyId" }),
  reverseSettlement
);

export default router;
