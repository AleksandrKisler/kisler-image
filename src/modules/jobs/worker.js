require("dotenv").config();
const {getDb} = require("../../db");
const {createKlingJob, getRequestStatus} = require("../../integrations/genapi/client");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {markJobFailedAndRefund} = require("./markFailedAndRefund");

const POLL_INTERVAL_MS = 4000;

function publicVideoUrl(jobId) {
    return `/uploads/videos/${jobId}.mp4`;
}

async function downloadToLocal(url, outPath) {
    const res = await axios.get(url, {responseType: "stream", timeout: 120_000});
    await new Promise((resolve, reject) => {
        const s = res.data.pipe(fs.createWriteStream(outPath));
        s.on("finish", resolve);
        s.on("error", reject);
    });
}

async function takeOneQueuedJob(db) {
    const now = new Date().toISOString();
    // Atomic lock: update one queued row to processing
    const updated = await db("jobs")
        .where({status: "queued"})
        .orderBy("created_at", "asc")
        .limit(1)
        .update({status: "processing", updated_at: now});

    if (!updated) return null;

    // Fetch the earliest processing job with missing provider_job_id (the one we just locked)
    const job = await db("jobs")
        .where({status: "processing"})
        .whereNull("provider_job_id")
        .orderBy("created_at", "asc")
        .first();

    return job || null;
}

async function runOnce() {
    const db = getDb();
    const job = await takeOneQueuedJob(db);
    if (!job) return;

    try {
        const videoDir = path.join(__dirname, "../../../public/uploads/videos");
        fs.mkdirSync(videoDir, {recursive: true});

        const callbackBase = process.env.APP_PUBLIC_BASE_URL || "http://localhost:8080";
        const callbackSecret = process.env.GENAPI_CALLBACK_SECRET || "change_me";
        const callbackUrl = `${callbackBase}/api/v1/genapi/webhook?secret=${encodeURIComponent(callbackSecret)}&jobId=${encodeURIComponent(job.id)}`;

        // Map emotionCode to prompts
        const emotion = job.animation_code;
        const prompts = {
            smile: "Make a natural gentle smile. Subtle facial motion only. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.",
            blink: "Make a natural blink once or twice. Subtle facial motion only. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.",
            surprised: "Show a mild surprised expression: slightly raised eyebrows and soft widened eyes. Subtle facial motion only. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds."
        };
        const prompt = prompts[emotion] || prompts.blink;
        const negativePrompt = "bad anatomy, deformed, extra limbs, blurry, low quality, worst quality, artifacts, flicker";
        const publicBase = (process.env.APP_PUBLIC_BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
        const absoluteImageUrl = (job.image_url || "").startsWith("http")
            ? job.image_url
            : `${publicBase}${job.image_url}`;

        const created = await createKlingJob({
            imageUrl: absoluteImageUrl,
            prompt,
            negativePrompt,
            callbackUrl
        });

        await db("jobs").where({id: job.id}).update({
            provider: "genapi",
            provider_job_id: created.request_id,
            updated_at: new Date().toISOString()
        });

        // Polling fallback (in case callback is not delivered)
        while (true) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            const st = await getRequestStatus(created.request_id);

            if (st.status === "processing") continue;

            if (st.status === "failed") {
                await db("jobs").where({id: job.id}).update({
                    status: "failed",
                    error_message: st.error || "GenAPI failed",
                    updated_at: new Date().toISOString()
                });
                await markJobFailedAndRefund(job.id, st.error || "GenAPI failed");
                return;
            }

            if (st.status === "success") {
                const outPath = path.join(videoDir, `${job.id}.mp4`);
                const resultUrl = st.result_url || st.video_url || st.url;
                if (!resultUrl) throw new Error("GenAPI success without result_url");

                await downloadToLocal(resultUrl, outPath);

                await db("jobs").where({id: job.id}).update({
                    status: "completed",
                    result_video_url: publicVideoUrl(job.id),
                    updated_at: new Date().toISOString()
                });
                return;
            }
        }
    } catch (e) {
        await db("jobs").where({id: job.id}).update({
            status: "failed",
            error_message: e.message,
            updated_at: new Date().toISOString()
        });
        await markJobFailedAndRefund(job.id, e.message);
    }
}

setInterval(runOnce, 2000);
