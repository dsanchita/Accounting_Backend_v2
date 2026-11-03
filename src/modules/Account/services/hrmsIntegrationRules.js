const ruleError = (message, code = "VALIDATION_FAILED") =>
  Object.assign(new Error(message), { statusCode: 422, code });

export const toMinorUnits = (value, label) => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw ruleError(`${label} must be a non-negative integer in minor currency units`, "INVALID_AMOUNT");
  }
  return amount;
};

export const reconcilePayrollEmployee = (employee) => {
  if (Number(employee.extraPayMinorUnits || 0) !== 0) {
    throw ruleError(
      "Payroll includes extraPay items that do not yet have an approved accounting treatment",
      "UNMAPPED_EXTRA_PAY"
    );
  }
  const gross = toMinorUnits(employee.grossSalaryMinorUnits, "Gross salary");
  const net = toMinorUnits(employee.netPayableMinorUnits, "Employee net payable");
  const deductions = new Map(
    Object.entries(employee.deductionsMinorUnits || {}).map(([key, amount]) => [
      key,
      toMinorUnits(amount, `Payroll deduction ${key}`),
    ])
  );
  const totalDeductions = [...deductions.values()].reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(totalDeductions) || gross !== net + totalDeductions) {
    throw ruleError(
      `Payroll does not reconcile for employee ${employee.employeeCode || employee.employeeId}: gross must equal net payable plus mapped deductions`,
      "PAYROLL_RECONCILIATION_FAILED"
    );
  }
  return { gross, net, deductions, totalDeductions };
};

export const assertJournalBalanced = (lines) => {
  const amountInMinorUnits = (value, label) => {
    const minorUnits = Number(value || 0) * 100;
    if (!Number.isSafeInteger(minorUnits)) {
      throw ruleError(`${label} must have no more than two decimal places`, "INVALID_AMOUNT");
    }
    return toMinorUnits(minorUnits, label);
  };
  const debitMinorUnits = lines.reduce(
    (sum, line) => sum + amountInMinorUnits(line.debitAmount, "Journal debit"),
    0
  );
  const creditMinorUnits = lines.reduce(
    (sum, line) => sum + amountInMinorUnits(line.creditAmount, "Journal credit"),
    0
  );
  if (!Number.isSafeInteger(debitMinorUnits) || debitMinorUnits !== creditMinorUnits) {
    throw ruleError("Generated journal is not balanced", "UNBALANCED_JOURNAL");
  }
};
