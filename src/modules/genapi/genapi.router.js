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
            console.log("[genapi webhook]");
            console.log("jobId:", jobId);
            console.log("body:", JSON.stringify(req.body, null, 2));
        }

        // webhook — только сигнал активности
        await db("jobs")
            .where({ id: jobId })
            .update({
                provider_status: req.body?.status || null,
                updated_at: new Date().toISOString()
            });

        return res.json({ ok: true });
    } catch (e) {
        console.error("[genapi webhook error]", e);
        return res.status(500).json({ error: { code: "INTERNAL", message: "Webhook error" } });
    }
});

module.exports = { genapiRouter };
