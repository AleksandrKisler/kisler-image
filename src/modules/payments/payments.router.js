const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../../db");
const { requireAuth } = require("../../shared/http/authMiddleware");
const { createPayment, getPayment } = require("../../integrations/yookassa/client");

// Fixed plans (must match /plans)
const PLANS = {
    one: { id: "one", title: "1 видео", videos: 1, priceRub: 199 },
    three: { id: "three", title: "3 видео", videos: 3, priceRub: 499 },
};

const paymentsRouter = express.Router();
paymentsRouter.use(requireAuth);

/**
 * INTERNAL helper: update local status from YooKassa + apply tokens ONCE
 */
async function refreshAndMaybeApplyPayment(db, p) {
    if (!p?.yk_payment_id) return p;

    const yk = await getPayment(p.yk_payment_id);

    const newStatus =
        yk.status === "succeeded" && yk.paid
            ? "succeeded"
            : yk.status === "canceled"
                ? "canceled"
                : "pending";

    // Update local status + confirmation_url if needed
    await db("payments")
        .where({ id: p.id })
        .update({
            status: newStatus,
            confirmation_url: p.confirmation_url || yk.confirmation?.confirmation_url || null,
            updated_at: new Date().toISOString(),
        });

    // Apply local accounting once (idempotent)
    if (newStatus === "succeeded" && !p.applied_at) {
        await db.transaction(async (trx) => {
            const fresh = await trx("payments").where({ id: p.id }).first();
            if (!fresh || fresh.applied_at) return;

            await trx("users").where({ id: fresh.user_id }).increment("token_balance", fresh.videos);

            await trx("payments")
                .where({ id: fresh.id })
                .update({
                    applied_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });
        });
    }

    return await db("payments").where({ id: p.id }).first();
}

/**
 * Create payment
 * Accepts BOTH:
 *   - { planId: "one" | "three" } (старое)
 *   - { pack: "one" | "three" }   (новое, фронт)
 */
paymentsRouter.post("/create", async (req, res) => {
    const planId = String(req.body?.planId || req.body?.pack || "");
    const plan = PLANS[planId];
    if (!plan) {
        return res
            .status(400)
            .json({ error: { code: "BAD_REQUEST", message: "Invalid planId/pack" } });
    }

    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();

    // IMPORTANT: return_url должен совпадать с фронтом
    const returnUrl =
        process.env.YOOKASSA_RETURN_URL || "http://localhost:5173/payment/return";

    const description = `Kisler Photo: ${plan.title}`;

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
        updated_at: now,
    });

    const { idempotenceKey, payment } = await createPayment({
        amountRub: plan.priceRub,
        description,
        returnUrl,
        metadata: {
            internal_payment_id: id,
            user_id: req.user.sub,
            plan_id: plan.id,
            videos: plan.videos,
        },
    });

    await db("payments").where({ id }).update({
        yk_payment_id: payment.id,
        confirmation_url: payment.confirmation?.confirmation_url || null,
        idempotence_key: idempotenceKey,
        updated_at: new Date().toISOString(),
    });

    return res.json({
        paymentId: id,
        ykPaymentId: payment.id,
        status: payment.status,
        confirmationUrl: payment.confirmation?.confirmation_url,
    });
});

/**
 * Get payment status (server source of truth).
 * IMPORTANT: if pending -> auto-refresh from YooKassa to avoid "pending forever".
 */
paymentsRouter.get("/:id", async (req, res) => {
    const db = getDb();
    let p = await db("payments").where({ id: req.params.id }).first();
    if (!p) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Payment not found" } });
    }
    if (p.user_id !== req.user.sub) {
        return res.status(403).json({ error: { code: "FORBIDDEN", message: "Forbidden" } });
    }

    // ✅ Key improvement: refresh from YooKassa when pending
    if (p.status === "pending" && p.yk_payment_id) {
        try {
            p = await refreshAndMaybeApplyPayment(db, p);
        } catch (e) {
            // не валим запрос: просто отдаем локальные данные
            // фронт может повторить через пару секунд
        }
    }

    return res.json({
        id: p.id,
        status: p.status,
        videos: p.videos,
        amount: { value: p.amount_value, currency: p.currency },
        confirmationUrl: p.confirmation_url,
        ykPaymentId: p.yk_payment_id,
        appliedAt: p.applied_at,
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

    try {
        await refreshAndMaybeApplyPayment(db, p);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(502).json({ error: { code: "UPSTREAM_ERROR", message: e.message || "YooKassa error" } });
    }
});

module.exports = { paymentsRouter, PLANS };
