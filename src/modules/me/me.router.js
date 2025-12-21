const express = require("express");
const { getDb } = require("../../db");
const { requireAuth } = require("../../shared/http/authMiddleware");

const meRouter = express.Router();

meRouter.get("/", requireAuth, async (req, res) => {
  const db = getDb();
  const user = await db("users").where({ id: req.user.sub }).first();
  if (!user) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "User not found" } });

  res.json({
    id: user.id,
    email: user.email,
    tokenBalance: user.token_balance
  });
});

module.exports = { meRouter };
