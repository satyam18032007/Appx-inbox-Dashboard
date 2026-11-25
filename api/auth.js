const crypto = require("crypto");
const { getSupabase, hashPassword, verifyPassword, requireUser, getAuthToken, sessionDigest, setSessionCookie, sameOrigin, sanitizeUser } = require("./_lib");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const sb = getSupabase();

    if (req.method === "GET") {
      const user = await requireUser(req, res, "auth");
      if (!user) return;
      return res.status(200).json({ user: sanitizeUser(user) });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!sameOrigin(req)) return res.status(403).json({ error: "Invalid request origin." });
    const action = req.query.action || (req.body && req.body.action) || "login";

    if (action === "logout") {
      const token = getAuthToken(req);
      if (token) {
        const { error } = await sb.from("sessions").delete().eq("token", sessionDigest(token));
        if (error) throw error;
      }
      setSessionCookie(res);
      return res.status(200).json({ status: "signed_out" });
    }

    const { name = "", email = "", password = "" } = req.body || {};
    const cleanEmail = String(email).trim().toLowerCase();
    if (cleanEmail.length > 254 || String(password).length > 256 || String(name).length > 120) {
      return res.status(400).json({ error: "Account details exceed supported length." });
    }

    const ip = (req.headers["x-vercel-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    const { data: permitted, error: rateError } = await sb.rpc("appx_allow_auth_request", {
      p_key: sessionDigest(ip),
    });
    if (rateError) throw rateError;
    if (!permitted) {
      res.setHeader("Retry-After", "600");
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }

    if (action === "register") {
      if (!cleanEmail || !cleanEmail.includes("@") || String(password).length < 6) {
        return res.status(400).json({ error: "Valid email and password (minimum 6 characters) are required." });
      }
      const verifyToken = `appx_${crypto.randomBytes(6).toString("hex")}`;
      const { data: created, error: cErr } = await sb
        .from("users")
        .insert({
          name: String(name).trim() || cleanEmail.split("@")[0],
          email: cleanEmail,
          password_hash: hashPassword(String(password)),
          verify_token: verifyToken,
          graph_version: "v21.0",
        })
        .select("*")
        .single();

      if (cErr) {
        if (cErr.code === "23505") {
          return res.status(409).json({ error: "This email is already registered. Please sign in." });
        }
        throw cErr;
      }

      const token = crypto.randomBytes(32).toString("hex");
      const { error: sessionError } = await sb.from("sessions").insert({ token: sessionDigest(token), user_id: created.id });
      if (sessionError) throw sessionError;
      setSessionCookie(res, token);
      return res.status(201).json({ user: sanitizeUser(created) });
    }

    if (action === "login") {
      const { data: user, error: uErr } = await sb
        .from("users")
        .select("*")
        .eq("email", cleanEmail)
        .maybeSingle();

      if (uErr || !user || !verifyPassword(String(password), user.password_hash)) {
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const token = crypto.randomBytes(32).toString("hex");
      const { error: sessionError } = await sb.from("sessions").insert({ token: sessionDigest(token), user_id: user.id });
      if (sessionError) throw sessionError;
      setSessionCookie(res, token);
      return res.status(200).json({ user: sanitizeUser(user) });
    }

    return res.status(400).json({ error: "Invalid auth action." });
  } catch (err) {
    return res.status(500).json({ error: "Authentication service unavailable." });
  }
};
