const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing Bearer token" } });

    try {
        const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        req.user = payload; // { sub, email, iat, exp }
        next();
    } catch (e) {
        if (e?.name === "TokenExpiredError") {
            return res.status(401).json({ error: { code: "TOKEN_EXPIRED", message: "Access token expired" } });
        }
        return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } });
    }
}

module.exports = { requireAuth };
