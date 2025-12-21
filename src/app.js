require("dotenv").config();
const express = require("express");
const path = require("path");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");

const { createAuthRouter } = require("./modules/auth/auth.router");
const { jobsRouter } = require("./modules/jobs/jobs.router");
const { adminRouter } = require("./modules/admin/admin.router");
const { meRouter } = require("./modules/me/me.router");
const { plansRouter } = require("./modules/plans/plans.router");
const { genapiRouter } = require("./modules/genapi/genapi.router");
const { paymentsRouter } = require("./modules/payments/payments.router");
const { yookassaRouter } = require("./modules/yookassa/yookassa.router");
const { uploadsRouter } = require("./modules/uploads/uploads.router");

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));

const spec = YAML.load(path.join(__dirname, "../openapi.yaml"));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));

app.use("/api/v1/auth", createAuthRouter());
app.use("/api/v1/me", meRouter);
app.use("/api/v1/plans", plansRouter);
app.use("/api/v1/uploads", uploadsRouter);
app.use("/api/v1/jobs", jobsRouter);
app.use("/api/v1/genapi", genapiRouter);
app.use("/api/v1/payments", paymentsRouter);
app.use("/api/v1/yookassa", yookassaRouter);
app.use("/api/v1/admin", adminRouter);

module.exports = { app };
