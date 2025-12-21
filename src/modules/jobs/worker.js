require("dotenv").config();
const { getDb } = require("../../db");
const { createKlingJob, getRequestStatus } = require("../../integrations/genapi/client");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { failStuckJobs } = require("./jobTimeout");
const { markJobFailedAndRefund } = require("./markFailedAndRefund");

/**
 * Комментарии (по уму + совместимость):
 *
 * ✅ По уму: новые job создаются как `queued` (см. jobs.router.js)
 * ✅ Совместимость: worker также подхватывает "старые/сломанные" job,
 *    которые уже `processing`, но provider_job_id ещё NULL.
 *
 * Это позволяет:
 * - не потерять старые задачи
 * - плавно мигрировать прод без ручной чистки БД
 */

const POLL_INTERVAL_MS = 4000;
const KEEPALIVE_EVERY_MS = 20_000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getPublicBase() {
    return (process.env.APP_PUBLIC_BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
}

function guessExtByContentType(contentType) {
    if (!contentType) return ".mp4";
    const ct = String(contentType).toLowerCase();
    if (ct.includes("webm")) return ".webm";
    if (ct.includes("mp4")) return ".mp4";
    if (ct.includes("quicktime")) return ".mov";
    return ".mp4";
}

async function downloadToFile(url, absPath) {
    const res = await axios.get(url, { responseType: "stream", timeout: 180_000 });

    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(absPath);
        res.data.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
    });

    return res.headers?.["content-type"] || null;
}

/**
 * Берём задачу на старт:
 * - queued (правильный поток)
 * - ИЛИ processing без provider_job_id (совместимость/спасение зависших)
 */
async function takeOneStartableJob(db) {
    const now = new Date().toISOString();

    return db.transaction(async (trx) => {
        const job = await trx("jobs")
            .whereIn("status", ["queued", "processing"])
            .whereNull("provider_job_id")
            .orderBy("created_at", "asc")
            .first();

        if (!job) return null;

        // “захват” — ставим processing (если был queued) и обновляем updated_at
        const updated = await trx("jobs")
            .where({ id: job.id })
            .whereIn("status", ["queued", "processing"])
            .whereNull("provider_job_id")
            .update({
                status: "processing",
                updated_at: now,
            });

        if (!updated) return null;

        return trx("jobs").where({ id: job.id }).first();
    });
}

async function runOnce() {
    const db = getDb();

    await failStuckJobs(db);

    const job = await takeOneStartableJob(db);
    if (!job) return;

    const publicBase = getPublicBase();
    const callbackSecret = process.env.GENAPI_CALLBACK_SECRET || "change_me";
    const callbackUrl = `${publicBase}/api/v1/genapi/webhook?secret=${encodeURIComponent(
        callbackSecret
    )}&jobId=${job.id}`;

    const prompts = {
        smile: "Make a natural gentle smile. Subtle facial motion only. 5 seconds.",
        blink: "Make a natural blink once or twice. Subtle facial motion only. 5 seconds.",
        surprised: "Show mild surprise. Subtle facial motion only. 5 seconds.",
    };

    const prompt = prompts[job.animation_code] || prompts.blink;

    const absoluteImageUrl = String(job.image_url || "").startsWith("http")
        ? job.image_url
        : `${publicBase}${job.image_url}`;

    const videoDir = path.join(process.cwd(), "public/uploads/videos");
    fs.mkdirSync(videoDir, { recursive: true });

    try {
        console.log("[worker] start job", job.id);
        console.log("[worker] image:", absoluteImageUrl);

        const created = await createKlingJob({
            imageUrl: absoluteImageUrl,
            prompt,
            negativePrompt: "bad anatomy, artifacts",
            callbackUrl,
        });

        const providerRequestId = String(created.request_id);

        await db("jobs")
            .where({ id: job.id })
            .update({
                provider: "genapi",
                provider_job_id: providerRequestId,
                provider_status: created.status || "processing",
                updated_at: new Date().toISOString(),
            });

        let lastKeepaliveAt = Date.now();

        while (true) {
            await sleep(POLL_INTERVAL_MS);

            if (Date.now() - lastKeepaliveAt >= KEEPALIVE_EVERY_MS) {
                lastKeepaliveAt = Date.now();
                await db("jobs").where({ id: job.id }).update({ updated_at: new Date().toISOString() });
            }

            const st = await getRequestStatus(providerRequestId);

            const status = st?.status;

            await db("jobs")
                .where({ id: job.id })
                .update({
                    provider_status: status || null,
                    updated_at: new Date().toISOString(),
                });

            if (!status || status === "processing") continue;

            console.log("[worker] final status =", status, "job", job.id);

            if (status === "failed") {
                const errMsg = st?.error?.message || st?.message || "GenAPI: generation failed";
                await markJobFailedAndRefund(job.id, `GenAPI failed: ${errMsg}`);
                return;
            }

            if (status === "success") {
                const remoteUrl = st._videoUrl;
                if (!remoteUrl) {
                    await markJobFailedAndRefund(job.id, "GenAPI success but video URL missing in status payload");
                    return;
                }

                const tmpPath = path.join(videoDir, `${job.id}.tmp`);
                const contentType = await downloadToFile(remoteUrl, tmpPath);
                const ext = guessExtByContentType(contentType);

                const finalFileName = `${job.id}${ext}`;
                const finalAbsPath = path.join(videoDir, finalFileName);

                fs.renameSync(tmpPath, finalAbsPath);

                const publicUrl = `/uploads/videos/${finalFileName}`;

                await db("jobs")
                    .where({ id: job.id })
                    .update({
                        status: "completed",
                        result_video_url: publicUrl,
                        error_message: null,
                        updated_at: new Date().toISOString(),
                    });

                console.log("[worker] completed job", job.id, "→", publicUrl);
                return;
            }

            console.warn("[worker] unknown status:", status, "job", job.id);
        }
    } catch (e) {
        console.error("[worker] error:", e.message);
        await markJobFailedAndRefund(job.id, `Worker error: ${String(e.message || "Worker error")}`);
    }
}

setInterval(runOnce, 2000);
