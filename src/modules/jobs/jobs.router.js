const express = require("express");
const { getDb } = require("../../db");
const { v4: uuidv4 } = require("uuid");
const { requireAuth } = require("../../shared/http/authMiddleware");

/**
 * Комментарии (что "по уму"):
 * 1) POST /jobs создаёт job строго со статусом `queued`.
 *    Это правильная архитектура: API ставит в очередь, worker исполняет.
 *
 * 2) Возвращаем 201 и нормализованное поле `id` (и для совместимости `jobId`).
 *
 * 3) В DTO добавлены providerStatus/providerJobId — для дебага и для e2e.
 *    Иначе твой CLI будет печатать providerStatus пустым даже когда он есть в БД,
 *    потому что поле просто не отдавалось в API.
 */

const jobsRouter = express.Router();

function toDto(job) {
    return {
        id: job.id,
        status: job.status,

        // важное для e2e/наблюдения
        provider: job.provider || null,
        providerJobId: job.provider_job_id || null,
        providerStatus: job.provider_status || null,

        resultVideoUrl: job.result_video_url || null,
        errorMessage: job.error_message || null,

        createdAt: job.created_at,
        updatedAt: job.updated_at || null,

        emotionCode: job.animation_code,
        imageUrl: job.image_url
    };
}

jobsRouter.use(requireAuth);

jobsRouter.post("/", async (req, res) => {
    const { imageUrl, emotionCode, params } = req.body || {};
    if (!imageUrl || !emotionCode) {
        return res
            .status(400)
            .json({ error: { code: "BAD_REQUEST", message: "imageUrl and emotionCode required" } });
    }

    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();

    try {
        await db.transaction(async (trx) => {
            // списываем 1 токен атомарно, только если баланс > 0
            const updated = await trx("users")
                .where({ id: req.user.sub })
                .where("token_balance", ">", 0)
                .decrement("token_balance", 1);

            if (!updated) {
                const u = await trx("users").where({ id: req.user.sub }).first();
                const bal = u ? u.token_balance : 0;
                const err = new Error("INSUFFICIENT_TOKENS");
                err.balance = bal;
                throw err;
            }

            await trx("jobs").insert({
                id,
                user_id: req.user.sub,
                image_url: imageUrl,
                animation_code: emotionCode,
                params_json: params ? JSON.stringify(params) : null,

                provider: "genapi",

                // ✅ по уму — только queued
                status: "queued",

                // provider_* заполняет воркер
                provider_job_id: null,
                provider_status: null,

                created_at: now,
                updated_at: now
            });
        });

        // ✅ 201 + id + совместимость jobId
        return res.status(201).json({ id, jobId: id, status: "queued" });
    } catch (e) {
        if (e.message === "INSUFFICIENT_TOKENS") {
            return res.status(402).json({
                error: { code: "INSUFFICIENT_TOKENS", message: "Not enough tokens to create video" },
                tokenBalance: e.balance ?? 0
            });
        }

        console.error("[jobs.post] error:", e);
        return res.status(500).json({ error: { code: "INTERNAL", message: "Failed to create job" } });
    }
});

jobsRouter.get("/", async (req, res) => {
    const db = getDb();
    const items = await db("jobs")
        .where({ user_id: req.user.sub })
        .orderBy("created_at", "desc");

    return res.json({ items: items.map(toDto) });
});

jobsRouter.get("/:id", async (req, res) => {
    const db = getDb();
    const job = await db("jobs").where({ id: req.params.id }).first();

    if (!job) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found" } });
    }
    if (job.user_id !== req.user.sub) {
        return res.status(403).json({ error: { code: "FORBIDDEN", message: "Forbidden" } });
    }

    return res.json(toDto(job));
});

module.exports = { jobsRouter };
