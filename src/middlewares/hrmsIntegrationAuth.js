import crypto from "crypto";
import { getHrmsIntegrationNonceModel } from "../modules/Account/models/HrmsIntegrationNonce.js";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const signIntegrationRequest = ({ timestamp, nonce, method, requestPath, rawBody, secret }) =>
  crypto
    .createHmac("sha256", secret)
    .update([
      timestamp,
      nonce,
      method.toUpperCase(),
      requestPath,
      rawBody,
    ].join("\n"))
    .digest("hex");

export const verifyHrmsIntegrationSignature = async (req, res, next) => {
  try {
    const secret = process.env.HRMS_ACCOUNTING_HMAC_SECRET;
    if (!secret || (process.env.NODE_ENV === "production" && Buffer.byteLength(secret) < 32)) {
      console.warn("[Accounting Integration Auth] Rejected: HRMS_ACCOUNTING_HMAC_SECRET is not configured or too short (length:", secret ? Buffer.byteLength(secret) : 0, ")");
      return res.status(503).json({
        success: false,
        message: "HRMS accounting integration is not configured",
      });
    }

    const timestamp = req.get("x-integration-timestamp");
    const nonce = req.get("x-integration-nonce");
    const suppliedSignature = req.get("x-integration-signature");
    const timestampMs = Number(timestamp) * 1000;

    console.log(`[Accounting Integration Auth] Incoming ${req.method} ${req.originalUrl} (nonce: ${nonce}, timestamp: ${timestamp})`);

    if (
      !timestamp ||
      !nonce ||
      !/^[a-f0-9]{64}$/i.test(suppliedSignature || "") ||
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS ||
      nonce.length < 16 ||
      nonce.length > 128
    ) {
      console.warn(`[Accounting Integration Auth] Verification failed: missing/invalid headers (timestamp: ${timestamp}, nonce: ${nonce}, sigLength: ${suppliedSignature?.length})`);
      return res.status(401).json({ success: false, message: "Invalid integration signature" });
    }

    const rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : req.method === "GET"
        ? Buffer.alloc(0)
        : null;
    if (!rawBody) {
      console.warn(`[Accounting Integration Auth] Verification failed: Raw body unavailable for ${req.method} ${req.originalUrl}`);
      return res.status(400).json({ success: false, message: "Raw request body is unavailable" });
    }

    const expected = Buffer.from(signIntegrationRequest({
      timestamp,
      nonce,
      method: req.method,
      requestPath: req.originalUrl,
      rawBody: rawBody.toString("utf8"),
      secret,
    }), "hex");
    const received = Buffer.from(suppliedSignature, "hex");

    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      console.warn(`[Accounting Integration Auth] Signature mismatch for ${req.method} ${req.originalUrl}`);
      return res.status(401).json({ success: false, message: "Invalid integration signature" });
    }

    const Nonce = await getHrmsIntegrationNonceModel();
    try {
      await Nonce.create({
        nonce,
        expiresAt: new Date(Date.now() + MAX_CLOCK_SKEW_MS * 2),
      });
    } catch (error) {
      if (error?.code === 11000) {
        console.warn(`[Accounting Integration Auth] Replayed nonce: ${nonce}`);
        return res.status(401).json({ success: false, message: "Integration request replayed" });
      }
      throw error;
    }

    console.log(`[Accounting Integration Auth] Signature verified successfully for ${req.method} ${req.originalUrl}`);
    req.integrationCaller = "HRMS";
    next();
  } catch (error) {
    console.error(`[Accounting Integration Auth] Unexpected error:`, error);
    next(error);
  }
};
