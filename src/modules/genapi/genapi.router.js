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
    const resultUrl = req.body?.result_url || req.body?.video_url || req.body?.url;

    if (status === "failed") {
        await db("jobs").where({id: jobId}).update({
            status: "failed",
            error_message: req.body?.error || "GenAPI failed",
            updated_at: new Date().toISOString()
        });
        await markJobFailedAndRefund(jobId, req.body?.error || "GenAPI failed");
        return res.json({ok: true});
    }

    if (status !== "success") {
        return res.json({ok: true}); // ignore intermediate
    }

    if (!resultUrl) {
        await db("jobs").where({id: jobId}).update({
            status: "failed",
            error_message: "Callback success without result_url",
            updated_at: new Date().toISOString()
        });
        await markJobFailedAndRefund(jobId, req.body?.error || "GenAPI failed");
        return res.json({ok: true});
    }

    const videoDir = path.join(__dirname, "../../../public/uploads/videos");
    fs.mkdirSync(videoDir, {recursive: true});
    const outPath = path.join(videoDir, `${jobId}.mp4`);

    await downloadToLocal(resultUrl, outPath);

    await db("jobs").where({id: jobId}).update({
        status: "completed",
        result_video_url: `/uploads/videos/${jobId}.mp4`,
        updated_at: new Date().toISOString()
    });

    res.json({ok: true});
});

module.exports = {genapiRouter};
