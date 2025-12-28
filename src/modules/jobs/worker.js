require("dotenv").config();
const { getDb } = require("../../db");
const { createKlingJob, getRequestStatus } = require("../../integrations/genapi/client");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { failStuckJobs } = require("./jobTimeout");
const { markJobFailedAndRefund } = require("./markFailedAndRefund");

/**
 * Что исправлено:
 * ✅ worker теперь ДОВОДИТ job до completed/failed
 * ✅ пишет provider_status во время polling
 * ✅ скачивает видео в public/uploads/videos и пишет result_video_url
 * ✅ keepalive обновляет updated_at, чтобы timeout не убивал живую задачу
 * ✅ поддержка кейса: status=success, но url появится чуть позже (ждём)
 * ✅ берём job из queued (и как совместимость — processing без provider_job_id)
 */

const POLL_INTERVAL_MS = 4000;
const KEEPALIVE_EVERY_MS = 20_000;
const SUCCESS_NO_URL_MAX_TRIES = Number(process.env.SUCCESS_NO_URL_MAX_TRIES || 30);

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

function normalizeProviderStatus(raw) {
    const s = String(raw || "").toLowerCase().trim();
    if (!s) return "";
    if (["processing", "pending", "queued", "running", "in_progress"].includes(s)) return "processing";
    if (["failed", "error", "canceled", "cancelled"].includes(s)) return "failed";
    if (["success", "succeeded", "completed", "done", "ok", "finish", "finished"].includes(s)) return "success";
    if (s.startsWith("success")) return "success";
    return s;
}

async function takeOneStartableJob(db) {
    const now = new Date().toISOString();

    return db.transaction(async (trx) => {
        const job = await trx("jobs")
            .whereIn("status", ["queued", "processing"])
            .whereNull("provider_job_id")
            .orderBy("created_at", "asc")
            .first();

        if (!job) return null;

        const updated = await trx("jobs")
            .where({ id: job.id })
            .whereIn("status", ["queued", "processing"])
            .whereNull("provider_job_id")
            .update({ status: "processing", updated_at: now });

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
        smile: "Create a natural, soft smile with barely noticeable facial movement. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.",
        blink: "Create a natural blink once or twice with a light, relaxed smile. Keep identity, skin texture and lighting consistent. Subtle facial motion only, no head movement. 5 seconds.",
        surprised: "Show a light, restrained surprise: slightly raised brows and softly widened eyes. Keep identity, skin texture and lighting consistent. Minimal facial motion, no head movement. 5 seconds.",
        calm: "Maintain a calm, confident, friendly-neutral expression. Keep face relaxed with smooth, minimal motion. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.",
        joy: "Show bright joy with a wide, warm smile and friendly gaze. Allow slightly more facial movement and energy while keeping identity, skin texture and lighting consistent. Minimal head movement. 5 seconds.",
    };

    const prompt = prompts[job.animation_code] || prompts.blink;

    const absoluteImageUrl = String(job.image_url || "").startsWith("http")
        ? job.image_url
        : `${publicBase}${job.image_url}`;

    const videoDir = path.join(process.cwd(), "public/uploads/videos");
    fs.mkdirSync(videoDir, { recursive: true });

    try {
        console.log("[worker] start job", job.id);

        const created = await createKlingJob({
            imageUrl: absoluteImageUrl,
            prompt,
            negativePrompt: "bad anatomy, artifacts",
            callbackUrl,
        });

        const providerRequestId = String(created.request_id);

        await db("jobs").where({ id: job.id }).update({
            provider: "genapi",
            provider_job_id: providerRequestId,
            provider_status: created.status || "processing",
            updated_at: new Date().toISOString(),
        });

        let lastKeepaliveAt = Date.now();
        let successNoUrlTries = 0;

        while (true) {
            await sleep(POLL_INTERVAL_MS);

            if (Date.now() - lastKeepaliveAt >= KEEPALIVE_EVERY_MS) {
                lastKeepaliveAt = Date.now();
                await db("jobs").where({ id: job.id }).update({ updated_at: new Date().toISOString() });
            }

            let st;
            try {
                st = await getRequestStatus(providerRequestId);
            } catch (e) {
                if (e.code === "GENAPI_STATUS_404" || e.response?.status === 404) {
                    console.warn("[worker] status 404, retry… job", job.id);
                    continue;
                }
                throw e;
            }

            const status = normalizeProviderStatus(st?.status);

            await db("jobs").where({ id: job.id }).update({
                provider_status: status || null,
                updated_at: new Date().toISOString(),
            });

            if (!status || status === "processing") continue;

            if (status === "failed") {
                const errMsg = st?.error?.message || st?.message || "GenAPI: generation failed";
                await markJobFailedAndRefund(job.id, `GenAPI failed: ${errMsg}`);
                return;
            }

            if (status === "success") {
                const remoteUrl = st._videoUrl;

                // success может прийти раньше url — ждём
                if (!remoteUrl) {
                    successNoUrlTries += 1;
                    console.warn(
                        `[worker] success but no url yet (try ${successNoUrlTries}/${SUCCESS_NO_URL_MAX_TRIES}) job ${job.id}`
                    );

                    if (successNoUrlTries >= SUCCESS_NO_URL_MAX_TRIES) {
                        await markJobFailedAndRefund(job.id, "GenAPI success but video URL still missing after retries");
                        return;
                    }
                    continue;
                }

                const tmpPath = path.join(videoDir, `${job.id}.tmp`);
                const contentType = await downloadToFile(remoteUrl, tmpPath);
                const ext = guessExtByContentType(contentType);

                const finalFileName = `${job.id}${ext}`;
                const finalAbsPath = path.join(videoDir, finalFileName);
                fs.renameSync(tmpPath, finalAbsPath);

                const publicUrl = `/uploads/videos/${finalFileName}`;

                await db("jobs").where({ id: job.id }).update({
                    status: "completed",
                    result_video_url: publicUrl,
                    error_message: null,
                    updated_at: new Date().toISOString(),
                });

                console.log("[worker] completed job", job.id, "→", publicUrl);
                return;
            }

            console.warn("[worker] unknown status:", st?.status, "job", job.id);
        }
    } catch (e) {
        console.error("[worker] error:", e.message);
        await markJobFailedAndRefund(job.id, `Worker error: ${String(e.message || "Worker error")}`);
    }
}

setInterval(runOnce, 2000);
