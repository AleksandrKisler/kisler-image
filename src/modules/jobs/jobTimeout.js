const { markJobFailedAndRefund } = require("./markFailedAndRefund");

const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000; // 15 минут

async function failStuckJobs(db) {
    const deadline = new Date(Date.now() - PROCESSING_TIMEOUT_MS).toISOString();

    const stuck = await db("jobs")
        .where("status", "processing")
        .andWhere("updated_at", "<", deadline);

    for (const job of stuck) {
        console.error("[timeout] job stuck → fail:", job.id);
        await markJobFailedAndRefund(job.id, "Processing timeout — provider did not complete in time");
    }
}

module.exports = { failStuckJobs };
