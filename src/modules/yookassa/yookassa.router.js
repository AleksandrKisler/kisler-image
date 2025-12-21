const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../../db");
const { getPayment } = require("../../integrations/yookassa/client");

const yookassaRouter = express.Router();

/**
 * YooKassa notifications (webhooks).
 * We validate authenticity by re-fetching payment status from YooKassa API (recommended approach).
 * YooKassa expects HTTP 200; body ignored.
 */
yookassaRouter.post("/webhook", async (req, res) => {
  const db = getDb();

  const event = String(req.body?.event || "");
  const obj = req.body?.object || {};
  const ykPaymentId = String(obj?.id || "");

  // store raw event
  await db("payment_events").insert({
    id: uuidv4(),
    payment_id: req.body?.object?.metadata?.internal_payment_id || null,
    yk_payment_id: ykPaymentId || null,
    event: event || "unknown",
    payload_json: JSON.stringify(req.body || {}),
    created_at: new Date().toISOString()
  });

  if (!ykPaymentId) return res.status(200).send("OK");

  // find internal payment record by yk_payment_id OR by metadata.internal_payment_id
  let p = await db("payments").where({ yk_payment_id: ykPaymentId }).first();
  if (!p) {
    const internalId = String(req.body?.object?.metadata?.internal_payment_id || "");
    if (internalId) p = await db("payments").where({ id: internalId }).first();
  }
  if (!p) return res.status(200).send("OK");

  // Check current status from YooKassa to ensure notification is актуально and genuine
  let yk;
  try {
    yk = await getPayment(ykPaymentId);
  } catch (e) {
    return res.status(200).send("OK");
  }

  const now = new Date().toISOString();
  const newStatus =
    (yk.status === "succeeded" && yk.paid) ? "succeeded" :
    (yk.status === "canceled") ? "canceled" :
    "pending";

  await db("payments").where({ id: p.id }).update({ status: newStatus, updated_at: now });

  // Apply local accounting once
  if (newStatus === "succeeded" && !p.applied_at) {
    await db.transaction(async (trx) => {
      const fresh = await trx("payments").where({ id: p.id }).first();
      if (fresh.applied_at) return;
      await trx("users").where({ id: fresh.user_id }).increment("token_balance", fresh.videos);
      await trx("payments").where({ id: fresh.id }).update({ applied_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    });
  }

  return res.status(200).send("OK");
});

module.exports = { yookassaRouter };
