const express = require("express");
const { getDb } = require("../../db");

const genapiRouter = express.Router();
const DEBUG = (process.env.GENAPI_DEBUG || "0") === "1";

genapiRouter.post("/webhook", async (req, res) => {
    try {
        const secret = String(req.query.secret || "");
        const jobId = String(req.query.jobId || "");

        if (!secret || secret !== (process.env.GENAPI_CALLBACK_SECRET || "change_me")) {
            return res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid secret" } });
        }

        if (!jobId) {
            return res.status(400).json({ error: { code: "BAD_REQUEST", message: "jobId required" } });
        }

        const db = getDb();
        const job = await db("jobs").where({ id: jobId }).first();

        if (!job) {
            return res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found" } });
        }

        if (DEBUG) {
            console.log("[genapi webhook] jobId:", jobId);
            console.log("[genapi webhook] body:", JSON.stringify(req.body, null, 2));
        }

        const patch = {
            provider_status: req.body?.status || null,
            updated_at: new Date().toISOString(),
        };

        // В DEBUG можно сохранить кусок payload в error_message для быстрой диагностики,
        // но только если job ещё не completed (чтобы не затирать ошибки/историю).
        if (DEBUG && job.status !== "completed") {
            const safeSnippet = JSON.stringify(req.body || {}, null, 2).slice(0, 1500);
            patch.error_message = `SOFT: webhook received\n${safeSnippet}`;
        }

        await db("jobs").where({ id: jobId }).update(patch);

        return res.json({ ok: true });
    } catch (e) {
        console.error("[genapi webhook error]", e);
        return res.status(500).json({ error: { code: "INTERNAL", message: "Webhook error" } });
    }
});

module.exports = { genapiRouter };
