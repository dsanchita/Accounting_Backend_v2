import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { signIntegrationRequest } from "../src/middlewares/hrmsIntegrationAuth.js";

test("signs exact request path and raw body with normalized method", () => {
  const request = {
    timestamp: "1710000000",
    nonce: "a1b2c3d4e5f6a7b8",
    method: "post",
    requestPath: "/api/integrations/hrms/payroll-accruals?x=1",
    rawBody: '{"employee":"A"}',
    secret: "a sufficiently long test secret value",
  };
  const expected = crypto
    .createHmac("sha256", request.secret)
    .update([
      request.timestamp,
      request.nonce,
      "POST",
      request.requestPath,
      request.rawBody,
    ].join("\n"))
    .digest("hex");

  assert.equal(signIntegrationRequest(request), expected);
  assert.equal(signIntegrationRequest({ ...request, rawBody: '{"employee":"B"}' }) === expected, false);
  assert.equal(signIntegrationRequest({ ...request, requestPath: "/different" }) === expected, false);
});

test("signs payroll-settlements requests consistently", () => {
  const request = {
    timestamp: "1710000000",
    nonce: "a1b2c3d4e5f6a7b8c9d0e1f2",
    method: "POST",
    requestPath: "/api/integrations/hrms/payroll-settlements",
    rawBody: JSON.stringify({ eventId: "hrms-settlement-1" }),
    secret: "01234567890123456789012345678901",
  };
  const sig = signIntegrationRequest(request);
  assert.equal(typeof sig, "string");
  assert.equal(sig.length, 64);
});

test("signs claim-accruals and claim-settlements requests consistently", () => {
  const accrualRequest = {
    timestamp: "1710000000",
    nonce: "claim-accrual-nonce-12345",
    method: "POST",
    requestPath: "/api/integrations/hrms/claim-accruals",
    rawBody: JSON.stringify({ eventId: "hrms-claim-1" }),
    secret: "01234567890123456789012345678901",
  };
  const accrualSig = signIntegrationRequest(accrualRequest);
  assert.equal(typeof accrualSig, "string");
  assert.equal(accrualSig.length, 64);

  const settlementRequest = {
    timestamp: "1710000000",
    nonce: "claim-settlement-nonce-12345",
    method: "POST",
    requestPath: "/api/integrations/hrms/claim-settlements",
    rawBody: JSON.stringify({ eventId: "hrms-settlement-claim-1" }),
    secret: "01234567890123456789012345678901",
  };
  const settlementSig = signIntegrationRequest(settlementRequest);
  assert.equal(typeof settlementSig, "string");
  assert.equal(settlementSig.length, 64);
});
