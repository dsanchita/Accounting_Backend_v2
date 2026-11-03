import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJournalBalanced,
  reconcilePayrollEmployee,
  toMinorUnits,
} from "../src/modules/Account/services/hrmsIntegrationRules.js";

test("reconciles gross payroll to net and all supplied deduction components", () => {
  const result = reconcilePayrollEmployee({
    employeeId: "employee-1",
    employeeCode: "E-1",
    grossSalaryMinorUnits: 7000000,
    netPayableMinorUnits: 6200000,
    deductionsMinorUnits: {
      pf: 500000,
      professionalTax: 100000,
      incomeTax: 200000,
    },
    extraPayMinorUnits: 0,
  });

  assert.equal(result.totalDeductions, 800000);
  assert.deepEqual([...result.deductions.entries()], [
    ["pf", 500000],
    ["professionalTax", 100000],
    ["incomeTax", 200000],
  ]);
});

test("rejects payroll not reconciling without a plug liability", () => {
  assert.throws(
    () => reconcilePayrollEmployee({
      employeeId: "employee-1",
      grossSalaryMinorUnits: 7000000,
      netPayableMinorUnits: 6150000,
      deductionsMinorUnits: { pf: 500000, professionalTax: 100000, incomeTax: 200000 },
    }),
    { code: "PAYROLL_RECONCILIATION_FAILED" }
  );
});

test("rejects payroll extraPay until treatment is configured", () => {
  assert.throws(
    () => reconcilePayrollEmployee({
      employeeId: "employee-1",
      grossSalaryMinorUnits: 7000000,
      netPayableMinorUnits: 6200000,
      deductionsMinorUnits: { pf: 800000 },
      extraPayMinorUnits: 250000,
    }),
    { code: "UNMAPPED_EXTRA_PAY" }
  );
});

test("rejects unsafe and fractional minor-unit values", () => {
  assert.throws(() => toMinorUnits(-1, "amount"), { code: "INVALID_AMOUNT" });
  assert.throws(() => toMinorUnits(1.25, "amount"), { code: "INVALID_AMOUNT" });
  assert.throws(
    () => assertJournalBalanced([{ debitAmount: 1.001, creditAmount: 1 }]),
    { code: "INVALID_AMOUNT" }
  );
});

test("accepts balanced journal lines and rejects unbalanced lines", () => {
  assert.doesNotThrow(() => assertJournalBalanced([
    { debitAmount: 70000, creditAmount: 0 },
    { debitAmount: 0, creditAmount: 62000 },
    { debitAmount: 0, creditAmount: 8000 },
  ]));
  assert.throws(
    () => assertJournalBalanced([
      { debitAmount: 70000, creditAmount: 0 },
      { debitAmount: 0, creditAmount: 69999 },
    ]),
    { code: "UNBALANCED_JOURNAL" }
  );
});
