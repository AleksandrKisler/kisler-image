const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../../db");
const { requireAuth } = require("../../shared/http/authMiddleware");
const { createPayment, getPayment } = require("../../integrations/yookassa/client");

// Fixed plans (must match /plans)
const PLANS = {
  one: { id: "one", title: "1 видео", videos: 1, priceRub: 199 },
  three: { id: "three", title: "3 видео", videos: 3, priceRub: 499 }
};

const paymentsRouter = express.Router();
paymentsRouter.use(requireAuth);

/**
 * Create YooKassa payment for chosen plan.
 * Returns confirmationUrl for redirect.
 */
paymentsRouter.post("/create", async (req, res) => {
  const planId = String(req.body?.planId || "");
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid planId" } });

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  // Create internal record first
  await db("payments").insert({
    id,
    user_id: req.user.sub,
    plan_id: plan.id,
    videos: plan.videos,
    amount_value: plan.priceRub.toFixed(2),
    currency: "RUB",
    status: "pending",
    created_at: now,
    updated_at: now
  });

  const returnUrl = process.env.YOOKASSA_RETURN_URL || "http://localhost:5173/billing/return";
  const description = `Warm Memories: ${plan.title}`;

  const { idempotenceKey, payment } = await createPayment({
    amountRub: plan.priceRub,
    description,
    returnUrl,
    metadata: { internal_payment_id: id, user_id: req.user.sub, plan_id: plan.id, videos: plan.videos }
  });

  await db("payments").where({ id }).update({
    yk_payment_id: payment.id,
    confirmation_url: payment.confirmation?.confirmation_url || null,
    idempotence_key: idempotenceKey,
    updated_at: new Date().toISOString()
  });

  res.json({
    paymentId: id,
    ykPaymentId: payment.id,
    status: payment.status,
    confirmationUrl: payment.confirmation?.confirmation_url
  });
});

/**
 * Get payment status (server source of truth).
 */
paymentsRouter.get("/:id", async (req, res) => {
  const db = getDb();
  const p = await db("payments").where({ id: req.params.id }).first();
  if (!p) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Payment not found" } });
  if (p.user_id !== req.user.sub) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Forbidden" } });

  res.json({
    id: p.id,
    status: p.status,
    videos: p.videos,
    amount: { value: p.amount_value, currency: p.currency },
    confirmationUrl: p.confirmation_url,
    ykPaymentId: p.yk_payment_id,
    appliedAt: p.applied_at
  });
});

/**
 * Optional: force-refresh status from YooKassa (auth required).
 */
paymentsRouter.post("/:id/refresh", async (req, res) => {
  const db = getDb();
  const p = await db("payments").where({ id: req.params.id }).first();
  if (!p) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Payment not found" } });
  if (p.user_id !== req.user.sub) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Forbidden" } });
  if (!p.yk_payment_id) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Missing yk_payment_id" } });

  const yk = await getPayment(p.yk_payment_id);
  // Update status fields
  await db("payments").where({ id: p.id }).update({
    status: yk.status === "succeeded" && yk.paid ? "succeeded" : (yk.status === "canceled" ? "canceled" : "pending"),
    updated_at: new Date().toISOString()
  });

  res.json({ ok: true });
});

module.exports = { paymentsRouter, PLANS };
