const express = require("express");
const axios = require("axios");
const { requireAuth } = require("../../shared/http/authMiddleware");

const filesRouter = express.Router();
filesRouter.use(requireAuth);

filesRouter.get("/download", async (req, res) => {
    const url = String(req.query.url || "");
    if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ message: "Invalid url" });
    }

    try {
        const r = await axios.get(url, {
            responseType: "stream",
            timeout: 30000,
            // иногда провайдеры режут без UA
            headers: { "User-Agent": "kisler-backend/1.0" },
            validateStatus: () => true,
        });

        if (r.status >= 400) {
            return res.status(502).json({ message: `Upstream error ${r.status}` });
        }

        // filename
        const filename = (req.query.filename && String(req.query.filename)) || "video.mp4";

        res.setHeader("Content-Type", r.headers["content-type"] || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);

        r.data.pipe(res);
    } catch (e) {
        return res.status(502).json({ message: e.message || "Download failed" });
    }
});

module.exports = { filesRouter };
