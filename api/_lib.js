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
  if (typeof stored !== "string" || !/^[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored)) return false;
  const [salt] = stored.split("$");
  const candidate = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  return digits;
}

const SESSION_SECONDS = 86400;

function getAuthToken(req) {
  const cookie = req.headers.cookie || "";
  return cookie.match(/(?:^|;\s*)__Host-appx_session=([a-f0-9]{64})(?:;|$)/)?.[1] || "";
}

function sessionDigest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res, token = "") {
  res.setHeader("Set-Cookie", `__Host-appx_session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}`);
}

function sameOrigin(req) {
  return req.headers.origin === `https://${req.headers.host}`;
}

async function requireUser(req, res, scope) {
  res.setHeader?.("Cache-Control", "no-store");
  if (req.method !== "GET" && !sameOrigin(req)) {
    res.status(403).json({ error: "Invalid request origin." });
    return null;
  }
  const token = getAuthToken(req);
  if (!token) {
    res.status(401).json({ error: "Not authenticated. Please sign in." });
    return null;
  }
  const sb = getSupabase();
  const { data: session, error: sErr } = await sb.from("sessions").select("user_id").eq("token", sessionDigest(token))
    .gt("created_at", new Date(Date.now() - SESSION_SECONDS * 1000).toISOString()).maybeSingle();
  if (sErr || !session) {
    res.status(401).json({ error: "Session expired. Please sign in again." });
    return null;
  }
  const { data: user, error: uErr } = await sb.from("users").select("*").eq("id", session.user_id).maybeSingle();
  if (uErr || !user) {
    res.status(401).json({ error: "User not found." });
    return null;
  }
  const workspace = scope && req.headers["x-appx-workspace"];
  if (!workspace || workspace === user.id) return user;
  if (typeof workspace !== "string" || !/^[0-9a-f-]{36}$/i.test(workspace)) {
    res.status(400).json({ error: "Invalid workspace." });
    return null;
  }

  const { data: member, error } = await sb.from("team_access").select("role")
    .eq("owner_id", workspace).eq("member_id", user.id).maybeSingle();
  if (error) throw error;
  const canRead = ["auth", "leads", "messages"].includes(scope) && req.method === "GET";
  const canOperate = member?.role === "operator" && (
    (scope === "messages" && req.method === "POST") ||
    (scope === "leads" && (req.method === "PATCH" || (req.method === "POST" && !req.query.action))) ||
    (scope === "templates" && req.method === "GET")
  );
  if (!member || (!canRead && !canOperate)) {
    res.status(403).json({ error: "Your workspace role does not allow this action." });
    return null;
  }

  const { data: owner, error: ownerError } = await sb.from("users").select("*").eq("id", workspace).single();
  if (ownerError) throw ownerError;
  return { ...owner, team_role: member.role, member_name: user.name };
}

function sanitizeUser(u) {
  if (u.team_role) {
    return {
      id: u.id, name: u.name, email: u.member_name, team_role: u.team_role,
      meta_configured: Boolean(u.whatsapp_token && u.phone_number_id),
    };
  }
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone_number_id: u.phone_number_id || "",
    waba_id: u.waba_id || "",
    verify_token: u.verify_token,
    graph_version: u.graph_version || "v21.0",
    connected_phone: u.connected_phone || "",
    meta_configured: Boolean(u.whatsapp_token && u.phone_number_id),
    webhook_path: `/webhook/${u.id}`,
    ai_enabled: Boolean(u.ai_enabled),
    ai_configured: Boolean(getGeminiApiKey()),
    ai_max_questions: Number(u.ai_max_questions || 3),
    ai_system_prompt: u.ai_system_prompt || "",
    owner_alert_phone: u.owner_alert_phone || "",
    fast2sms_configured: Boolean(u.fast2sms_api_key),
  };
}

async function verifyMetaCredentials(token, phoneNumberId, version = "v21.0") {
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Meta API returned ${resp.status}`);
  return {
    display_phone_number: data.display_phone_number || "",
    verified_name: data.verified_name || "",
  };
}

async function downloadMetaMediaBase64(user, mediaId) {
  if (!user.whatsapp_token || !mediaId) return null;
  const version = user.graph_version || "v21.0";
  const metaResp = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${user.whatsapp_token}` },
  });
  if (!metaResp.ok) return null;
  const metaData = await metaResp.json();
  if (!metaData.url) return null;

  const mediaUrl = new URL(metaData.url);
  if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password || mediaUrl.port ||
      !["lookaside.fbsbx.com", "graph.facebook.com"].includes(mediaUrl.hostname)) return null;
  const binResp = await fetch(mediaUrl, {
    redirect: "error",
    headers: { Authorization: `Bearer ${user.whatsapp_token}` },
  });
  if (!binResp.ok) return null;
  const arrayBuf = await binResp.arrayBuffer();
  return {
    mimeType: metaData.mime_type || "audio/ogg",
    base64: Buffer.from(arrayBuf).toString("base64"),
  };
}

async function sendMetaWhatsApp({
  user,
  toPhone,
  text = "",
  mode = "reply",
  templateName = "",
  templateLang = "en",
  templateParams = [],
  mediaUrl = "",
  mediaType = "document",
}) {
  if (!user.whatsapp_token || !user.phone_number_id) {
    throw new Error("Meta WhatsApp Cloud API not connected.");
  }
  const version = user.graph_version || "v21.0";
  const url = `https://graph.facebook.com/${version}/${user.phone_number_id}/messages`;
  let payload;

  if (mode === "template" && templateName) {
    const tpl = { name: templateName, language: { code: templateLang || "en" } };
    if (Array.isArray(templateParams) && templateParams.length > 0) {
      tpl.components = [
        {
          type: "body",
          parameters: templateParams.map((p) => ({ type: "text", text: String(p || "-") })),
        },
      ];
    }
    payload = { messaging_product: "whatsapp", to: toPhone, type: "template", template: tpl };
  } else if (mode === "media" && mediaUrl) {
    const mType = ["image", "document", "video"].includes(mediaType) ? mediaType : "document";
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone,
      type: mType,
      [mType]: { link: mediaUrl, caption: text || undefined },
    };
  } else {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone,
      type: "text",
      text: { preview_url: true, body: text },
    };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${user.whatsapp_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Meta WhatsApp API error (${resp.status})`);
  return data?.messages?.[0]?.id || "";
}

async function sendOwnerAlert({ user, message }) {
  const alertPhone = normalizePhone(user.owner_alert_phone || "");
  if (!alertPhone) return;

  if (user.fast2sms_api_key) {
    try {
      await fetch("https://www.fast2sms.com/dev/bulkV2", {
        method: "POST",
        headers: { authorization: user.fast2sms_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ route: "q", message: message.slice(0, 300), language: "english", numbers: alertPhone.slice(-10) }),
      });
    } catch (e) {}
  }

  if (user.whatsapp_token && user.phone_number_id) {
    try {
      await sendMetaWhatsApp({ user, toPhone: alertPhone, text: message, mode: "reply" });
    } catch (e) {}
  }
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY?.trim() || "";
}

async function generateGeminiText(apiKey, request) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(request),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini request failed (${response.status}).`);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => !part.thought).map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no text.");
  return text;
}

async function runGeminiSalesAgent({ user, lead, history, assetKits, audioMedia = null }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  const categoriesList = (assetKits || []).map((k) => `${k.category_name} (keywords: ${k.keywords || k.category_name})`).join("; ");
  const maxQ = Number(user.ai_max_questions || 3);
  const customInstructions =
    user.ai_system_prompt ||
    "You are an official, professional sales qualifier for AppX (branded Android/iOS apps + social media handling for educators, coaching institutes, and creators).";

  const systemPrompt = `${customInstructions}

STRICT OFFICIAL SALES QUALIFIER GUARDRAILS:
1. STAY ON-TOPIC & PROFESSIONAL: Never make random/off-topic jokes, never fabricate prices, discounts, or fake promises. If asked exact pricing before demo, politely say pricing depends on their app & social media requirements and will be shared clearly on the 15-min live demo.
2. DYNAMIC, NON-STATIC REPLIES: Always acknowledge what the customer just said (including voice notes!) before moving to the next step. Never repeat the same generic message twice.
3. ADAPTIVE LANGUAGE MIRRORING:
   - If customer writes/speaks in Hindi (Devanagari), reply in polite Hindi (Devanagari).
   - If customer writes/speaks in Hinglish (Roman Hindi), reply in polite Hinglish.
   - If customer writes/speaks in English, reply in crisp professional English.
   - If customer sends a voice note, listen to it carefully, summarize what they said in "voice_transcript", and respond directly to their points.
4. STRUCTURED QUALIFICATION (Max ${maxQ} questions total — already asked: ${lead.ai_questions_asked || 0}):
   - Ask 1 short question at a time: (a) Subject/exam they teach (Physics, Chemistry, UPSC, GPSC, etc.), (b) Existing YouTube/WhatsApp/Facebook audience size, (c) Whether they also want Social Media handling with their branded app.
   - Do NOT keep asking questions endlessly. Once ${maxQ} questions are done OR customer already shared their subject & interest, set "send_assets": true (if assets_sent is currently ${lead.assets_sent ? "YES" : "NO"}) with the best matching "detected_category" from [${categoriesList || "General"}], and ask for their preferred demo date & time.
5. DEMO BOOKING DETECTION: If customer gives a preferred date/time (e.g., "kal 5 baje", "tomorrow 4 PM", "Monday morning"), set "demo_booked": true and put the time in "demo_time_text".

"asked_a_question" means you asked a new qualifying question about the customer's business. A scheduling request is a separate step. If the qualification limit has been reached, ask no further qualifying questions. Answer the customer and continue with assets or demo scheduling.
Return STRICT JSON ONLY:
{
  "reply": "natural, concise 2-3 line official sales reply matching customer language",
  "voice_transcript": "short summary/transcript if audio was attached, else empty string",
  "detected_category": "exact category_name from kits or empty string",
  "send_assets": false,
  "demo_booked": false,
  "demo_time_text": "",
  "asked_a_question": true
}`;

  const convoText = (history || [])
    .slice(-10)
    .map((m) => `${m.direction === "incoming" ? "Customer" : "Agent"}: ${m.body}`)
    .join("\n");

  const parts = [{ text: `${systemPrompt}\n\nConversation so far with ${lead.name}:\n${convoText}\n\nRespond with STRICT JSON:` }];
  if (audioMedia && audioMedia.base64) {
    parts.push({
      inlineData: {
        mimeType: audioMedia.mimeType || "audio/ogg",
        data: audioMedia.base64,
      },
    });
  }

  const raw = await generateGeminiText(apiKey, {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json" },
  });
  try {
    return JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

module.exports = {
  getSupabase,
  hashPassword,
  verifyPassword,
  normalizePhone,
  getAuthToken,
  sessionDigest,
  setSessionCookie,
  sameOrigin,
  requireUser,
  sanitizeUser,
  verifyMetaCredentials,
  downloadMetaMediaBase64,
  sendMetaWhatsApp,
  sendOwnerAlert,
  getGeminiApiKey,
  generateGeminiText,
  runGeminiSalesAgent,
};
