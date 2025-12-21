const {getDb} = require("../../db");

/**
 * Mark job as failed and refund 1 token exactly once.
 *
 * - Refund happens only if `jobs.refunded_at` is NULL.
 * - Never refunds completed jobs.
 * - Safe to call multiple times (webhook retries / worker retries).
 */
async function markJobFailedAndRefund(jobId, errorMessage) {
    const db = getDb();
    const now = new Date().toISOString();
    const msg = String(errorMessage || "");
    const soft = msg.startsWith("SOFT:");

    await db.transaction(async (trx) => {
        const job = await trx("jobs").where({id: jobId}).first();
        if (!job) return;

        if (job.status === "completed") return;
        if (soft) {
            await trx("jobs").where({id: jobId}).update({
                error_message: msg,
                updated_at: now
            });
            return;
        }

        if (job.refunded_at) {
            await trx("jobs").where({id: jobId}).update({
                status: "failed",
                error_message: msg,
                updated_at: now
            });
            return;
        }

        await trx("jobs").where({id: jobId}).update({
            status: "failed",
            error_message: msg,
            refunded_at: now,
            updated_at: now
        });

        if (job.user_id) {
            await trx("users").where({id: job.user_id}).increment("token_balance", 1);
        }
    });
}

module.exports = {markJobFailedAndRefund};