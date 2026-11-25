const crypto = require("crypto");
const { getSupabase, hashPassword, verifyPassword, requireUser, getAuthToken, sanitizeUser } = require("./_lib");

module.exports = async (req, res) => {
  try {
    const sb = getSupabase();

    if (req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      return res.status(200).json({ user: sanitizeUser(user) });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const action = req.query.action || (req.body && req.body.action) || "login";

    if (action === "logout") {
      const token = getAuthToken(req);
      if (token) await sb.from("sessions").delete().eq("token", token);
      return res.status(200).json({ status: "signed_out" });
    }

    const { name = "", email = "", password = "" } = req.body || {};
    const cleanEmail = String(email).trim().toLowerCase();

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
      await sb.from("sessions").insert({ token, user_id: created.id });
      return res.status(201).json({ token, user: sanitizeUser(created) });
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
      await sb.from("sessions").insert({ token, user_id: user.id });
      return res.status(200).json({ token, user: sanitizeUser(user) });
    }

    return res.status(400).json({ error: "Invalid auth action." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
};
