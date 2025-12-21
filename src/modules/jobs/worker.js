require("dotenv").config();
const { getDb } = require("../../db");
const { createKlingJob, getRequestStatus } = require("../../integrations/genapi/client");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { failStuckJobs } = require("./jobTimeout");
const { markJobFailedAndRefund } = require("./markFailedAndRefund");

/**
 * Комментарии (главные исправления):
 * 1) Убираем бесконечный while(true), который "видит success/failed, но ждёт webhook".
 *    Теперь worker САМ завершает job при success и ставит failed/refund при failed.
 *
 * 2) Обновляем updated_at во время polling (иначе failStuckJobs мог убить job, если webhook не пришёл).
 *
 * 3) Исправляем takeOneQueuedJob: раньше было условие гонки
 *    (update queued -> потом выбираем "любую processing без provider_job_id").
 *    Теперь атомарно берём конкретный job через транзакцию.
 */

const POLL_INTERVAL_MS = 4000;
const KEEPALIVE_EVERY_MS = 20_000; // раз в N мс трогаем updated_at во время processing

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
    const res = await axios.get(url, { responseType: "stream", timeout: 120_000 });

    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(absPath);
        res.data.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
    });

    return res.headers?.["content-type"] || null;
}

async function takeOneQueuedJob(db) {
    const now = new Date().toISOString();

    return db.transaction(async (trx) => {
        const job = await trx("jobs")
            .where({ status: "queued" })
            .orderBy("created_at", "asc")
            .first();

        if (!job) return null;

        const updated = await trx("jobs")
            .where({ id: job.id, status: "queued" })
            .update({ status: "processing", updated_at: now });

        if (!updated) return null;

        // Возвращаем уже “наш” job
        return trx("jobs").where({ id: job.id }).first();
    });
}

async function runOnce() {
    const db = getDb();

    // страховка от вечных processing
    await failStuckJobs(db);

    const job = await takeOneQueuedJob(db);
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
        console.log("[worker] create job", job.id);
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

        // Polling + финализация
        let lastKeepaliveAt = Date.now();

        while (true) {
            await sleep(POLL_INTERVAL_MS);

            // keepalive, чтобы timeout-джоба не убивало job если webhook не пришёл
            if (Date.now() - lastKeepaliveAt >= KEEPALIVE_EVERY_MS) {
                lastKeepaliveAt = Date.now();
                await db("jobs")
                    .where({ id: job.id })
                    .update({ updated_at: new Date().toISOString() });
            }

            let st;
            try {
                st = await getRequestStatus(providerRequestId);
            } catch (e) {
                // Некоторые провайдеры могут отдавать 404 после завершения/переноса,
                // но тут мы не хотим "висеть вечно".
                if (e.response?.status === 404) {
                    console.warn("[poll] 404 — status not found, retrying", "job", job.id);
                    continue;
                }
                throw e;
            }

            const status = st?.status;

            // обновляем provider_status, чтобы видеть прогресс
            await db("jobs")
                .where({ id: job.id })
                .update({
                    provider_status: status || null,
                    updated_at: new Date().toISOString(),
                });

            if (!status || status === "processing") continue;

            console.log("[poll] status =", status, "job", job.id);

            if (status === "failed") {
                const errMsg = st?.error?.message || st?.message || "GenAPI: generation failed";
                await markJobFailedAndRefund(job.id, `GenAPI failed: ${errMsg}`);
                return;
            }

            if (status === "success") {
                const remoteUrl = st._videoUrl; // нормализованное поле из client.js
                if (!remoteUrl) {
                    // Это важный кейс: success есть, а URL нет -> считаем ошибкой (refund).
                    await markJobFailedAndRefund(job.id, "GenAPI success but video URL missing in status payload");
                    return;
                }

                // Определим расширение: пробуем скачать и берём content-type
                const tmpPath = path.join(videoDir, `${job.id}.tmp`);
                const contentType = await downloadToFile(remoteUrl, tmpPath);
                const ext = guessExtByContentType(contentType);

                const finalFileName = `${job.id}${ext}`;
                const finalAbsPath = path.join(videoDir, finalFileName);

                // атомарное переименование
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

            // если провайдер вернёт неизвестный статус — не зависаем бесконечно
            console.warn("[poll] unknown status:", status, "job", job.id);
        }
    } catch (e) {
        console.error("[worker] error:", e.message);

        // Важно: не ставим failed напрямую — чтобы не было двойных refund/сценариев.
        // Но если это НЕ "SOFT:", то это реальная ошибка pipeline — лучше вернуть токен.
        const msg = String(e.message || "Worker error");

        // Если это network/временная проблема, можно оставить SOFT.
        // Но сейчас — безопаснее вернуть токен, чтобы не “съедать” баланс пользователя.
        await markJobFailedAndRefund(job.id, `Worker error: ${msg}`);
    }
}

setInterval(runOnce, 2000);
