const express = require("express");

const plansRouter = express.Router();

// Fixed product: 5 seconds, 5 emotions
const EMOTIONS = [
  {
    code: "smile",
    title: "Лёгкая улыбка",
    tone: "Тёплая эмоция",
    description: "Естественная мягкая улыбка. Только едва заметное движение лица. Длительность — 5 секунд.",
    prompt:
      "Create a natural, soft smile with barely noticeable facial movement. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.",
    recommended: false
  },
  {
    code: "blink",
    title: "Моргание",
    tone: "Спокойный взгляд",
    description:
      "Естественное моргание один или два раза с лёгкой расслабленной улыбкой. Минимальное движение лица. Длительность — 5 секунд.",
    prompt:
      "Create a natural blink once or twice with a light, relaxed smile. Keep identity, skin texture and lighting consistent. Subtle facial motion only, no head movement. 5 seconds.",
    recommended: true
  },
  {
    code: "surprised",
    title: "Удивление",
    tone: "Игровая эмоция",
    description: "Лёгкое, сдержанное удивление. Только минимальное движение лица. Длительность — 5 секунд.",
    prompt:
      "Show a light, restrained surprise: slightly raised brows and softly widened eyes. Keep identity, skin texture and lighting consistent. Minimal facial motion, no head movement. 5 seconds.",
    recommended: false
  },
  {
    code: "calm",
    title: "Спокойствие",
    tone: "Нейтрально-дружелюбная",
    description:
      "Мягкое, уверенное выражение лица без резких движений. Сохранится естественный тон и плавность.",
    prompt:
      "Maintain a calm, confident, friendly-neutral expression. Keep face relaxed with smooth, minimal motion. Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.",
    recommended: false
  },
  {
    code: "joy",
    title: "Радость",
    tone: "Яркая эмоция",
    description:
      "Широкая тёплая улыбка и дружелюбный взгляд. Добавляет больше движения и энергии кадру.",
    prompt:
      "Show bright joy with a wide, warm smile and friendly gaze. Allow slightly more facial movement and energy while keeping identity, skin texture and lighting consistent. Minimal head movement. 5 seconds.",
    recommended: false
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
