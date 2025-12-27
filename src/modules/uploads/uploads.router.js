const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { requireAuth } = require("../../shared/http/authMiddleware");
const sharp = require("sharp");

const uploadsRouter = express.Router();
uploadsRouter.use(requireAuth);

const maxBytes = parseInt(process.env.UPLOAD_MAX_BYTES || "8000000", 10);
const allowed = String(
  process.env.UPLOAD_ALLOWED_MIME || "image/jpeg,image/png,image/webp,image/heic,image/heif,image/tiff,image/x-tiff"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const photosDir = path.join(__dirname, "../../../public/uploads/photos");
fs.mkdirSync(photosDir, { recursive: true });

const convertibleFormats = {
  "image/heic": "heif",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/x-tiff": "tiff"
};

function hasDecoderFor(mime) {
  const formatKey = convertibleFormats[mime];
  if (!formatKey) return true;
  const format = sharp.format[formatKey];
  return Boolean(format && format.input && (format.input.file || format.input.buffer));
}

async function cleanup(paths) {
  await Promise.allSettled(
    paths.filter(Boolean).map((p) =>
      fs.promises
        .unlink(p)
        .catch(() => {})
    )
  );
}

function isDecoderError(err) {
  const message = String(err && err.message).toLowerCase();
  return message.includes("no decoding plugin installed") || message.includes("heif:");
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, photosDir);
  },
  filename: function (_req, file, cb) {
    const ext = (path.extname(file.originalname) || "").toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `${uuidv4()}${safeExt}`);
  }
});

function fileFilter(_req, file, cb) {
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("UNSUPPORTED_MEDIA_TYPE"));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: maxBytes },
  fileFilter
});

/**
 * POST /api/v1/uploads/photo
 * multipart/form-data: photo=file
 * returns { imageUrl }
 */
uploadsRouter.post("/photo", upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "photo file required" } });
  let filename = req.file.filename;
  const mime = (req.file.mimetype || "").toLowerCase();
  if (["image/heic", "image/heif", "image/tiff", "image/x-tiff"].includes(mime)) {
    if (!hasDecoderFor(mime)) {
      await cleanup([req.file.path]);
      return res
        .status(415)
        .json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "This server cannot decode the provided image format" } });
    }
    try {
      const inputBuffer = await sharp(req.file.path).toBuffer();
      const parsed = path.parse(req.file.filename);
      filename = `${parsed.name}.jpg`;
      const convertedPath = path.join(photosDir, filename);
      const tempPath = path.join(photosDir, `${parsed.name}-tmp.jpg`);
      await sharp(inputBuffer).jpeg().toFile(tempPath);
      await fs.promises.unlink(req.file.path);
      await fs.promises.rename(tempPath, convertedPath);
    } catch (err) {
      console.error("Failed to convert uploaded file", err);
      await cleanup([path.join(photosDir, `${path.parse(req.file.filename).name}-tmp.jpg`), req.file.path]);
      if (isDecoderError(err)) {
        return res.status(415).json({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Decoder for the provided image format is unavailable"
          }
        });
      }
      return res.status(500).json({ error: { code: "CONVERSION_FAILED", message: "Could not convert image" } });
    }
  }
  const imageUrl = `/uploads/photos/${filename}`;
  res.json({ imageUrl });
});

// Error handler for multer
uploadsRouter.use((err, _req, res, _next) => {
  if (err && err.message === "UNSUPPORTED_MEDIA_TYPE") {
    return res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Only jpeg/png/webp/heic/heif/tiff allowed" } });
  }
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "File too large" } });
  }
  return res.status(500).json({ error: { code: "INTERNAL", message: "Upload error" } });
});

module.exports = { uploadsRouter };
