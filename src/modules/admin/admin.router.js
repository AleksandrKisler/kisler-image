const express = require("express");
const { getDb } = require("../../db");

const adminRouter = express.Router();

adminRouter.use((req, res, next) => {
  if (req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
});

adminRouter.get("/users", async (_, res) => {
  res.json(await getDb()("users"));
});

adminRouter.get("/jobs", async (_, res) => {
  res.json(await getDb()("jobs"));
});

module.exports = { adminRouter };
