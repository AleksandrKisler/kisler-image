const express = require("express");
const {getDb} = require("../../db");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {markJobFailedAndRefund} = require("../jobs/markFailedAndRefund");

const genapiRouter = express.Router();

async function downloadToLocal(url, outPath) {
    const res = await axios.get(url, {responseType: "stream", timeout: 120_000});
    await new Promise((resolve, reject) => {
        const s = res.data.pipe(fs.createWriteStream(outPath));
        s.on("finish", resolve);
        s.on("error", reject);
    });
}

function pickResultUrl(body) {
    if (!body || typeof body !== "object") return "";
    // common top-level fields
    const direct = body.result_url || body.video_url || body.url;
    if (direct) return direct;
    // nested variants (common in async providers)
    return (
        body?.result?.url ||
        body?.result?.video_url ||
        body?.data?.result_url ||
        body?.data?.video_url ||
        body?.output?.url ||
        body?.output?.video_url ||
        body?.payload?.result_url ||
        body?.payload?.video_url ||
        ""
    );
}

genapiRouter.post("/webhook", async (req, res) => {
    const secret = String(req.query.secret || "");
    const jobId = String(req.query.jobId || "");
    if (!secret || secret !== (process.env.GENAPI_CALLBACK_SECRET || "change_me")) {
        return res.status(403).json({error: {code: "FORBIDDEN", message: "Invalid secret"}});
    }
    if (!jobId) return res.status(400).json({error: {code: "BAD_REQUEST", message: "jobId required"}});

    const db = getDb();
    const job = await db("jobs").where({id: jobId}).first();
    if (!job) return res.status(404).json({error: {code: "NOT_FOUND", message: "Job not found"}});

    // GenAPI may send payload with result_url / video_url and status
    const status = req.body?.status;
    const resultUrl = pickResultUrl(req.body);

    if (status === "failed") {
        await db("jobs").where({id: jobId}).update({
            status: job.status === "completed" ? "completed" : "processing",
            error_message: req.body?.error || "GenAPI reported failed (awaiting retry/webhook)",
            updated_at: new Date().toISOString()
        });
        return res.json({ok: true});
    }

    if (status !== "success") {
        return res.json({ok: true}); // ignore intermediate
    }

    if (!resultUrl) {
        await db("jobs").where({id: jobId}).update({
            status: job.status === "completed" ? "completed" : "processing",
            error_message: "Webhook success without result url (waiting for follow-up)",
            updated_at: new Date().toISOString()
        });
        return res.json({ok: true});
    }

    const videoDir = path.join(process.cwd(), "public/uploads/videos");
    fs.mkdirSync(videoDir, {recursive: true});
    const outPath = path.join(videoDir, `${jobId}.mp4`);

    try {
        await downloadToLocal(resultUrl, outPath);
    } catch (e) {
        // transient CDN URLs happen; don't fail+refund here
        await db("jobs").where({id: jobId}).update({
            status: job.status === "completed" ? "completed" : "processing",
            error_message: `Failed to download result url (will wait): ${e.response?.status || ""} ${e.message}`,
            updated_at: new Date().toISOString()
        });
        return res.json({ok: true});
    }
    await db("jobs").where({id: jobId}).update({
        status: "completed",
        result_video_url: `/uploads/videos/${jobId}.mp4`,
        updated_at: new Date().toISOString()
    });

    res.json({ok: true});
});

module.exports = {genapiRouter};
