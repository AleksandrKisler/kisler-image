require("dotenv").config();
const {getDb} = require("./index");

async function addColumnIfMissing(db, table, colName, colSql) {
    const info = await db.raw(`PRAGMA table_info(${table})`);
    const rows = Array.isArray(info) ? info : (info?.rows || info);
    const exists = rows.some((r) => r.name === colName);
    if (!exists) {
        await db.raw(`ALTER TABLE ${table}
            ADD COLUMN ${colName} ${colSql}`);
    }
}

async function migrate() {
    const db = getDb();

    // users
    const hasUsers = await db.schema.hasTable("users");
    if (!hasUsers) {
        await db.schema.createTable("users", (t) => {
            t.text("id").primary();
            t.text("email").notNullable().unique();
            t.text("password_hash");
            t.integer("token_balance").notNullable().defaultTo(0);
            t.text("created_at").notNullable();
        });
    }

    // auth codes
    const hasCodes = await db.schema.hasTable("auth_email_codes");
    if (!hasCodes) {
        await db.schema.createTable("auth_email_codes", (t) => {
            t.text("id").primary();
            t.text("email").notNullable();
            t.text("code_hash").notNullable();
            t.text("expires_at").notNullable();
            t.integer("attempts").notNullable().defaultTo(0);
            t.text("created_at").notNullable();
        });
        await db.schema.raw("CREATE INDEX IF NOT EXISTS idx_auth_email_codes_email ON auth_email_codes(email)");
    } else {
        await addColumnIfMissing(db, "auth_email_codes", "attempts", "INTEGER NOT NULL DEFAULT 0");
    }

    // jobs
    const hasJobs = await db.schema.hasTable("jobs");
    if (!hasJobs) {
        await db.schema.createTable("jobs", (t) => {
            t.text("id").primary();
            t.text("user_id").notNullable();
            t.text("image_url").notNullable();
            t.text("animation_code").notNullable();
            t.text("params_json"); // JSON as string
            t.text("provider").notNullable().defaultTo("genapi");
            t.text("provider_job_id");
            t.text("status").notNullable();
            t.text("result_video_url");
            t.text("error_message");
            t.text("refunded_at");
            t.text("created_at").notNullable();
            t.text("updated_at");
        });
        await db.schema.raw("CREATE INDEX IF NOT EXISTS idx_jobs_user_id_created_at ON jobs(user_id, created_at)");
    } else {
        await addColumnIfMissing(db, "jobs", "user_id", "TEXT");
        await addColumnIfMissing(db, "jobs", "image_url", "TEXT");
        await addColumnIfMissing(db, "jobs", "animation_code", "TEXT");
        await addColumnIfMissing(db, "jobs", "params_json", "TEXT");
        await addColumnIfMissing(db, "jobs", "provider", "TEXT");
        await addColumnIfMissing(db, "jobs", "provider_job_id", "TEXT");
        await addColumnIfMissing(db, "jobs", "result_video_url", "TEXT");
        await addColumnIfMissing(db, "jobs", "error_message", "TEXT");
        await addColumnIfMissing(db, "jobs", "refunded_at", "TEXT");
        await addColumnIfMissing(db, "jobs", "updated_at", "TEXT");
    }


    // payments (YooKassa)
    const hasPayments = await db.schema.hasTable("payments");
    if (!hasPayments) {
        await db.schema.createTable("payments", (t) => {
            t.text("id").primary(); // internal
            t.text("user_id").notNullable();
            t.text("plan_id").notNullable();
            t.integer("videos").notNullable();
            t.text("amount_value").notNullable();
            t.text("currency").notNullable().defaultTo("RUB");
            t.text("yk_payment_id");
            t.text("status").notNullable(); // pending|succeeded|canceled
            t.text("confirmation_url");
            t.text("idempotence_key");
            t.text("applied_at");
            t.text("created_at").notNullable();
            t.text("updated_at");
        });
        await db.schema.raw("CREATE INDEX IF NOT EXISTS idx_payments_user_id_created_at ON payments(user_id, created_at)");
        await db.schema.raw("CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_yk_payment_id ON payments(yk_payment_id)");
    } else {
        await addColumnIfMissing(db, "payments", "applied_at", "TEXT");
        await addColumnIfMissing(db, "payments", "idempotence_key", "TEXT");
    }

    const hasEvents = await db.schema.hasTable("payment_events");
    if (!hasEvents) {
        await db.schema.createTable("payment_events", (t) => {
            t.text("id").primary();
            t.text("payment_id"); // internal payment id
            t.text("yk_payment_id");
            t.text("event").notNullable();
            t.text("payload_json").notNullable();
            t.text("created_at").notNullable();
        });
        await db.schema.raw("CREATE INDEX IF NOT EXISTS idx_payment_events_yk_payment_id ON payment_events(yk_payment_id)");
    }

    return true;
}

if (require.main === module) {
    migrate()
        .then(() => {
            console.log("Migrations done");
            process.exit(0);
        })
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}

module.exports = {migrate};
