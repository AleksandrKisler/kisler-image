const express = require("express");

const plansRouter = express.Router();

// Fixed product: 5 seconds, 3 simple emotions
const EMOTIONS = [
  {
    code: "smile",
    title: "Улыбка",
    prompt: "Make a natural gentle smile. Subtle facial motion only. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds."
  },
  {
    code: "blink",
    title: "Моргание",
    prompt: "Make a natural blink once or twice. Subtle facial motion only. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds."
  },
  {
    code: "surprised",
    title: "Лёгкое удивление",
    prompt: "Show a mild surprised expression: slightly raised eyebrows and soft widened eyes. Subtle facial motion only. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds."
  }
];

const PLANS = [
  { id: "one", title: "1 видео", videos: 1, priceRub: 199 },
  { id: "three", title: "3 видео", videos: 3, priceRub: 499 }
];

plansRouter.get("/", (req, res) => {
  res.json({ plans: PLANS, emotions: EMOTIONS, durationSeconds: 5 });
});

module.exports = { plansRouter };
