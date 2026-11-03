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
