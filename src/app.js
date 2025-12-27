require("dotenv").config();
const express = require("express");
const path = require("path");
// const swaggerUi = require("swagger-ui-express");
// const YAML = require("yamljs");

function parseAllowedOrigins() {
    const raw = process.env.ALLOWED_ORIGINS || "*";
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Proper CORS middleware:
 * - If credentials are allowed -> Access-Control-Allow-Origin must be a конкретный origin
 * - Supports ALLOWED_ORIGINS="*" meaning "allow any origin" (but still echoes request origin)
 * - Handles OPTIONS preflight with 204
 */
function createCorsMiddleware() {
    const allowedOrigins = parseAllowedOrigins();
    const allowAny = allowedOrigins.includes("*");
    return (req, res, next) => {
        const origin = req.headers.origin;

        res.setHeader("Vary", "Origin");

        if (origin) {
            const isAllowed = allowAny || allowedOrigins.includes(origin);

            if (isAllowed) {
                // IMPORTANT: if we allow credentials, we must echo exact origin (not "*")
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Access-Control-Allow-Credentials", "true");
            }
        } else if (allowAny) {
            // Non-browser request (no Origin) — ok
            res.setHeader("Access-Control-Allow-Origin", "*");
        }

        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

        const reqHeaders = req.headers["access-control-request-headers"];
        res.setHeader(
            "Access-Control-Allow-Headers",
            reqHeaders ? String(reqHeaders) : "Content-Type, Authorization"
        );

        res.setHeader("Access-Control-Max-Age", "600");

        if (req.method === "OPTIONS") {
            // 204 is best practice for preflight
            return res.sendStatus(204);
        }

        next();
    };
}

const { createAuthRouter } = require("./modules/auth/auth.router");
const { jobsRouter } = require("./modules/jobs/jobs.router");
const { adminRouter } = require("./modules/admin/admin.router");
const { meRouter } = require("./modules/me/me.router");
const { plansRouter } = require("./modules/plans/plans.router");
const { genapiRouter } = require("./modules/genapi/genapi.router");
const { paymentsRouter } = require("./modules/payments/payments.router");
const { yookassaRouter } = require("./modules/yookassa/yookassa.router");
const { uploadsRouter } = require("./modules/uploads/uploads.router");
const { filesRouter } = require("./modules/files/files.router");

function createApp() {
    const app = express();


    app.use(createCorsMiddleware());
    app.use(express.json({ limit: "10mb" }));

    app.use("/uploads", express.static(path.join(process.cwd(), "public/uploads")));

    // const spec = YAML.load(path.join(process.cwd(), "openapi.yaml"));
    // app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));

    app.use("/api/v1/auth", createAuthRouter());
    app.use("/api/v1/me", meRouter);
    app.use("/api/v1/plans", plansRouter);
    app.use("/api/v1/uploads", uploadsRouter);
    app.use("/api/v1/jobs", jobsRouter);
    app.use("/api/v1/genapi", genapiRouter);
    app.use("/api/v1/payments", paymentsRouter);
    app.use("/api/v1/yookassa", yookassaRouter);
    app.use("/api/v1/admin", adminRouter);
    app.use("/api/v1/files", filesRouter);

    return app;
}

module.exports = { createApp };
