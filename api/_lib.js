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
    ai_max_questions: Number(u.ai_max_questions ?? 0),
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

async function downloadMetaMediaBase64(user, mediaId, maxBytes = 12 * 1024 * 1024) {
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
  if (Number(binResp.headers.get("content-length")) > maxBytes) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of binResp.body) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return {
    mimeType: metaData.mime_type || "audio/ogg",
    base64: Buffer.concat(chunks).toString("base64"),
  };
}

async function uploadWhatsAppVoice(user, data) {
  if (!user.whatsapp_token || !/^\d+$/.test(user.phone_number_id || "")) throw new Error("Connect WhatsApp first.");
  const version = /^v\d+\.\d+$/.test(user.graph_version || "") ? user.graph_version : "v21.0";
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("file", new Blob([data], { type: "audio/ogg" }), "voice-note.ogg");
  const response = await fetch(`https://graph.facebook.com/${version}/${user.phone_number_id}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${user.whatsapp_token}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.id) throw new Error(result.error?.message || "Meta could not upload the voice note.");
  return String(result.id);
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
  audioMediaId = "",
}) {
  if (!user.whatsapp_token || !user.phone_number_id) {
    throw new Error("Meta WhatsApp Cloud API not connected.");
  }
  const version = user.graph_version || "v21.0";
  const url = `https://graph.facebook.com/${version}/${user.phone_number_id}/messages`;
  let payload;

  if (mode === "template" && templateName) {
    const tpl = { name: templateName, language: { code: templateLang || "en" } };
    if (!Array.isArray(templateParams) || templateParams.some(value => typeof value !== "string" || !value.trim())) {
      throw new Error("Fill all template values before sending.");
    }
    if (templateParams.length > 0) {
      tpl.components = [
        {
          type: "body",
          parameters: templateParams.map((p) => ({ type: "text", text: p.trim() })),
        },
      ];
    }
    payload = { messaging_product: "whatsapp", to: toPhone, type: "template", template: tpl };
  } else if (mode === "voice" && audioMediaId) {
    payload = { messaging_product: "whatsapp", to: toPhone, type: "audio", audio: { id: audioMediaId, voice: true } };
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
  if (!resp.ok) {
    const error = new Error(data?.error?.message || `Meta WhatsApp API error (${resp.status})`);
    error.metaCode = Number(data?.error?.code) || undefined;
    throw error;
  }
  return data?.messages?.[0]?.id || "";
}

function renderTemplateText(template, values) {
  const body = template.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (marker, index) => values[Number(index) - 1] ?? marker);
  return [template.header, body, template.footer].filter(Boolean).join("\n\n");
}

function describeWhatsAppTemplate(template) {
  const components = template.components || [];
  const text = type => components.find(component => component.type === type)?.text || "";
  const body = text("BODY");
  const positions = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => Number(match[1]));
  return {
    name: template.name, status: template.status, category: template.category, language: template.language,
    header: text("HEADER"), body, footer: text("FOOTER"), var_count: Math.max(0, ...positions),
  };
}

async function getApprovedWhatsAppTemplate(user, name, language) {
  if (!user.whatsapp_token || !/^\d+$/.test(user.waba_id || "")) {
    throw new Error("Sync templates or save your WABA ID before sending a template.");
  }
  const version = /^v\d+\.\d+$/.test(user.graph_version || "") ? user.graph_version : "v21.0";
  const query = new URLSearchParams({ name, language, fields: "name,status,language,components" });
  const response = await fetch(`https://graph.facebook.com/${version}/${user.waba_id}/message_templates?${query}`, {
    headers: { Authorization: `Bearer ${user.whatsapp_token}` },
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Could not verify template with Meta.");
  const template = (data.data || []).find(item =>
    item.name === name && item.language === language && item.status === "APPROVED");
  if (!template) throw new Error("Meta no longer lists this template and language as approved. Sync and select again.");
  return describeWhatsAppTemplate(template);
}

function formatSentTemplate(template, values) {
  if (!Array.isArray(values) || values.length !== template.var_count ||
      values.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error(`Template ${template.name} needs ${template.var_count} filled body values.`);
  }
  return `[Template: ${template.name}]\n${renderTemplateText(template, values.map(value => value.trim()))}`;
}

async function takeWhatsAppThread(user, phone) {
  if (!user.whatsapp_token || !/^\d+$/.test(user.phone_number_id || "") || !/^\d+$/.test(phone)) {
    throw new Error("Connect a valid WhatsApp number before taking chat control.");
  }
  const response = await fetch(`https://api.facebook.com/business/whatsapp/phone_numbers/${user.phone_number_id}/thread_control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.whatsapp_token}`,
      "Content-Type": "application/json",
      "X-API-Version": "1.0.0",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", action: "take", to: phone }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || data.error || data.messaging_product !== "whatsapp") {
    throw new Error(data.error?.message || "Meta did not confirm chat control.");
  }
  return data;
}

async function sendOwnerAlert({ user, message }) {
  const alertPhone = normalizePhone(user.owner_alert_phone || "");
  if (!alertPhone) return false;
  let accepted = false;

  if (user.fast2sms_api_key) {
    try {
      const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
        method: "POST",
        headers: { authorization: user.fast2sms_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ route: "q", message: message.slice(0, 300), language: "english", numbers: alertPhone.slice(-10) }),
      });
      accepted = response.ok && (await response.json()).return === true;
    } catch {}
  }

  if (user.whatsapp_token && user.phone_number_id) {
    try {
      const id = await sendMetaWhatsApp({ user, toPhone: alertPhone, text: message, mode: "reply" });
      accepted = Boolean(id) || accepted;
    } catch {}
  }
  return accepted;
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

function normalizeSalesDecision(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const text = key => typeof result[key] === "string" ? result[key].trim() : "";
  return {
    reply: text("reply"),
    voice_transcript: text("voice_transcript"),
    detected_category: text("detected_category"),
    send_assets: result.send_assets === true,
    demo_booked: result.demo_booked === true && Boolean(text("demo_time_text")),
    demo_time_text: text("demo_time_text"),
    asked_a_question: result.asked_a_question === true,
  };
}

async function runGeminiSalesAgent({ user, lead, history, assetKits, audioMedia = null }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  const categoriesList = (assetKits || []).map((k) => `${k.category_name} (keywords: ${k.keywords || k.category_name})`).join("; ");
  const maxQ = Number(user.ai_max_questions ?? 0);
  const customInstructions =
    user.ai_system_prompt ||
    "You are an official, professional sales qualifier for AppX (branded Android/iOS apps + social media handling for educators, coaching institutes, and creators).";

  const systemPrompt = `${customInstructions}

SALES GOAL: Help the customer understand why AppX is relevant to their business and move interested leads toward a demo or purchase. Answer their actual question first. When helpful, connect one real AppX benefit to a need they mentioned. Give one low-friction next step, such as sharing a relevant brochure or inviting them to a short demo, when it fits their interest. A useful reply and brochure can go together if both add value. When a customer is ready to buy, explain the next step and route them to the team for confirmed pricing or purchase terms. Never invent urgency, results, discounts, or commitments.

STRICT OFFICIAL SALES QUALIFIER GUARDRAILS:
1. STAY ON-TOPIC & PROFESSIONAL: Never make random/off-topic jokes, never fabricate prices, discounts, or fake promises. If asked exact pricing before demo, politely say pricing depends on their app & social media requirements and will be shared clearly on the 15-min live demo.
2. TURN DECISION: Read the conversation, including the latest text or voice note. Choose whichever action helps: a short reply, an asset alone, both if each adds value, or no outbound action. Set reply to an empty string for asset-only delivery, acknowledgements such as "thanks" or "ok" that need no answer, clear conversation endings, and opt-outs. Do not send assets on acknowledgements or opt-outs.
3. ADAPTIVE LANGUAGE MIRRORING:
   - If customer writes/speaks in Hindi (Devanagari), reply in polite Hindi (Devanagari).
   - If customer writes/speaks in Hinglish (Roman Hindi), reply in polite Hinglish.
   - If customer writes/speaks in English, reply in crisp professional English.
   - If customer sends a voice note, listen to it carefully, summarize what they said in "voice_transcript", and respond directly to their points.
4. ADAPTIVE QUALIFICATION: There is no target number of questions. Ask at most one useful question per turn, and only if the information is missing and matters to the next action. Skip questions already answered. If the customer asks for a relevant resource or the chat already establishes enough interest and context, send the matching asset now, even after zero questions. Available categories: [${categoriesList || "none"}]. Assets already sent: ${lead.assets_sent ? "yes" : "no"}. Select General only as a relevant fallback. Never send a random category.
   Optional safety ceiling: ${maxQ > 0 ? maxQ : "off"}. Qualification questions already asked: ${lead.ai_questions_asked || 0}. If the ceiling is reached, proceed with a useful answer or relevant asset, or stay silent. Do not ask another qualification question.
5. DEMO HANDOFF: Set demo_booked only when the customer proposes or accepts a specific demo slot. This flag requests a human follow-up. Put their stated date, time and timezone in demo_time_text as supplied. In the customer reply say the team will check availability and share the meeting link after confirming. Never state that a demo is booked, that a calendar invitation has been sent, or that a meeting link exists. Do not create or invent a meeting URL. A brochure request or a vague interest in a demo does not establish a slot. If date or time is unclear, ask one short scheduling question.

These guardrails take precedence over any suggested fixed questionnaire in the business script. Set asked_a_question only if reply contains a new qualification question. Asking for a demo time is a separate action.
Return STRICT JSON ONLY:
{
  "reply": "short reply in the customer language, or empty string",
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
    return normalizeSalesDecision(JSON.parse(raw));
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? normalizeSalesDecision(JSON.parse(match[0])) : null;
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
  uploadWhatsAppVoice,
  sendMetaWhatsApp,
  describeWhatsAppTemplate,
  getApprovedWhatsAppTemplate,
  formatSentTemplate,
  takeWhatsAppThread,
  sendOwnerAlert,
  getGeminiApiKey,
  generateGeminiText,
  runGeminiSalesAgent,
};
