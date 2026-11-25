const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Server not configured: Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function hashPassword(password, salt = null) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, useSalt, 100000, 32, "sha256").toString("hex");
  return `${useSalt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes("$")) return false;
  const [salt] = stored.split("$");
  const candidate = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  return digits;
}

function getAuthToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return "";
}

async function requireUser(req, res) {
  const token = getAuthToken(req);
  if (!token) {
    res.status(401).json({ error: "Not authenticated. Please sign in." });
    return null;
  }
  const sb = getSupabase();
  const { data: session, error: sErr } = await sb
    .from("sessions")
    .select("user_id")
    .eq("token", token)
    .maybeSingle();

  if (sErr || !session) {
    res.status(401).json({ error: "Session expired. Please sign in again." });
    return null;
  }

  const { data: user, error: uErr } = await sb
    .from("users")
    .select("*")
    .eq("id", session.user_id)
    .maybeSingle();

  if (uErr || !user) {
    res.status(401).json({ error: "User not found." });
    return null;
  }
  return user;
}

function sanitizeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone_number_id: u.phone_number_id || "",
    verify_token: u.verify_token,
    graph_version: u.graph_version || "v21.0",
    connected_phone: u.connected_phone || "",
    meta_configured: Boolean(u.whatsapp_token && u.phone_number_id),
    webhook_path: `/webhook/${u.id}`,
  };
}

async function verifyMetaCredentials(token, phoneNumberId, version = "v21.0") {
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.error?.message || `Meta API returned ${resp.status}`;
    throw new Error(msg);
  }
  return {
    display_phone_number: data.display_phone_number || "",
    verified_name: data.verified_name || "",
  };
}

async function sendMetaWhatsApp({ user, toPhone, text, mode = "reply", templateName = "", templateLang = "en" }) {
  if (!user.whatsapp_token || !user.phone_number_id) {
    throw new Error("Meta WhatsApp Cloud API not connected. Click 'WhatsApp Cloud API' in the top bar to add your Access Token & Phone Number ID.");
  }
  const version = user.graph_version || "v21.0";
  const url = `https://graph.facebook.com/${version}/${user.phone_number_id}/messages`;
  const payload =
    mode === "template" && templateName
      ? {
          messaging_product: "whatsapp",
          to: toPhone,
          type: "template",
          template: { name: templateName, language: { code: templateLang || "en" } },
        }
      : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toPhone,
          type: "text",
          text: { preview_url: false, body: text },
        };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.whatsapp_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.error?.message || `Meta WhatsApp API error (${resp.status})`;
    throw new Error(msg);
  }
  return data?.messages?.[0]?.id || "";
}

module.exports = {
  getSupabase,
  hashPassword,
  verifyPassword,
  normalizePhone,
  getAuthToken,
  requireUser,
  sanitizeUser,
  verifyMetaCredentials,
  sendMetaWhatsApp,
};
