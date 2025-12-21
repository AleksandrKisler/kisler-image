require("dotenv").config();
const { getDb } = require("../../db");
const { createKlingJob, getRequestStatus } = require("../../integrations/genapi/client");
const path = require("path");
const fs = require("fs");
const { failStuckJobs } = require("./jobTimeout");

const POLL_INTERVAL_MS = 4000;

async function takeOneQueuedJob(db) {
    const now = new Date().toISOString();

    const updated = await db("jobs")
        .where({ status: "queued" })
        .orderBy("created_at", "asc")
        .limit(1)
        .update({ status: "processing", updated_at: now });

    if (!updated) return null;

    return db("jobs")
        .where({ status: "processing" })
        .whereNull("provider_job_id")
        .orderBy("created_at", "asc")
        .first();
}

async function runOnce() {
    const db = getDb();

    // 🔐 Страховка от вечных processing
    await failStuckJobs(db);

    const job = await takeOneQueuedJob(db);
    if (!job) return;

    try {
        const videoDir = path.join(process.cwd(), "public/uploads/videos");
        fs.mkdirSync(videoDir, { recursive: true });

        const publicBase = (process.env.APP_PUBLIC_BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
        const callbackSecret = process.env.GENAPI_CALLBACK_SECRET || "change_me";
        const callbackUrl =
            `${publicBase}/api/v1/genapi/webhook?secret=${encodeURIComponent(callbackSecret)}&jobId=${job.id}`;

        const prompts = {
            smile: "Make a natural gentle smile. Subtle facial motion only. 5 seconds.",
            blink: "Make a natural blink once or twice. Subtle facial motion only. 5 seconds.",
            surprised: "Show mild surprise. Subtle facial motion only. 5 seconds."
        };

        const prompt = prompts[job.animation_code] || prompts.blink;

        const absoluteImageUrl = job.image_url.startsWith("http")
            ? job.image_url
            : `${publicBase}${job.image_url}`;

        console.log("[worker] create job", job.id);
        console.log("[worker] image:", absoluteImageUrl);

        const created = await createKlingJob({
            imageUrl: absoluteImageUrl,
            prompt,
            negativePrompt: "bad anatomy, artifacts",
            callbackUrl
        });

        await db("jobs").where({ id: job.id }).update({
            provider: "genapi",
            provider_job_id: String(created.request_id),
            updated_at: new Date().toISOString()
        });

        // 👀 Polling — ТОЛЬКО наблюдение
        while (true) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            try {
                const st = await getRequestStatus(created.request_id);
                if (!st || st.status === "processing") continue;

                console.log("[poll] status =", st.status, "job", job.id);
                // success / failed — ждем webhook
            } catch (e) {
                if (e.response?.status === 404) {
                    console.warn("[poll] 404 — provider finished, waiting webhook");
                    continue;
                }
                throw e;
            }
        }

    } catch (e) {
        console.error("[worker] error:", e.message);
        // ❗ НИКОГДА не ставим failed здесь
        await getDb()("jobs").where({ id: job.id }).update({
            error_message: `SOFT: ${e.message}`,
            updated_at: new Date().toISOString()
        });
    }
}

setInterval(runOnce, 2000);
