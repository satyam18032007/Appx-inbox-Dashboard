const { randomUUID } = require("node:crypto");
const { getSupabase, requireUser, sanitizeUser, getGeminiApiKey, generateGeminiText, runGeminiSalesAgent, ASSET_BUCKET, ASSET_MEDIA } = require("./_lib");

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res, "ai");
    if (!user) return;
    const sb = getSupabase();

    if (req.method === "GET") {
      const { data: kits = [], error } = await sb
        .from("asset_kits")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.status(200).json({ user: sanitizeUser(user), kits });
    }

    if (req.method === "PUT") {
      const {
        ai_enabled = user.ai_enabled,
        ai_max_questions = user.ai_max_questions ?? 0,
        ai_system_prompt = user.ai_system_prompt ?? "",
        owner_alert_phone = user.owner_alert_phone ?? "",
        fast2sms_api_key = "",
      } = req.body || {};

      const ceiling = Number(ai_max_questions);
      if (!Number.isInteger(ceiling) || ceiling < 0 || ceiling > 8) {
        return res.status(400).json({ error: "Set the optional question limit to 0 through 8." });
      }
      const updates = {
        ai_enabled: Boolean(ai_enabled),
        ai_max_questions: ceiling,
        ai_system_prompt: String(ai_system_prompt || "").trim(),
        owner_alert_phone: String(owner_alert_phone || "").trim(),
      };
      if (String(fast2sms_api_key).trim()) {
        updates.fast2sms_api_key = String(fast2sms_api_key).trim();
      }

      const { data: updated, error } = await sb
        .from("users")
        .update(updates)
        .eq("id", user.id)
        .select("*")
        .single();
      if (error) throw error;
      return res.status(200).json({ status: "saved", user: sanitizeUser(updated) });
    }

    if (req.method === "POST" && req.query.action === "asset_upload") {
      const { mime, size } = req.body || {};
      const format = Object.hasOwn(ASSET_MEDIA, mime) ? ASSET_MEDIA[mime] : null;
      if (!format || !Number.isSafeInteger(size) || size < 1 || size > format.maxMB * 1024 * 1024) {
        return res.status(400).json({ error: "Use JPG/PNG up to 5 MB, MP4 up to 16 MB, or PDF up to 25 MB." });
      }
      const { data: bucket } = await sb.storage.getBucket(ASSET_BUCKET);
      if (!bucket) {
        const { error } = await sb.storage.createBucket(ASSET_BUCKET, {
          public: false, fileSizeLimit: 25 * 1024 * 1024, allowedMimeTypes: Object.keys(ASSET_MEDIA),
        });
        if (error) {
          const { data: existing } = await sb.storage.getBucket(ASSET_BUCKET);
          if (!existing || existing.public) throw error;
        }
      } else if (bucket.public) {
        throw new Error("Brochure storage must be private.");
      }
      const path = `${user.id}/${randomUUID()}.${format.extension}`;
      const { data, error } = await sb.storage.from(ASSET_BUCKET).createSignedUploadUrl(path, { upsert: false });
      if (error) throw error;
      return res.status(200).json({ path, uploadUrl: data.signedUrl });
    }

    // 1-Click AI Suggest Script based on user's business goal
    if (req.method === "POST" && req.query.action === "suggest") {
      const { goal = "AppX branded teaching app and social media marketing for educators" } = req.body || {};
      const apiKey = getGeminiApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: "Gemini is not configured for this deployment." });
      }
      const prompt = `Write a concise, practical system instruction (max 5 lines) for a WhatsApp sales qualifier bot that uses professional English by default and Roman Hindi when the customer uses Hindi or Hinglish for this business: "${goal}". Ask one question only when the conversation needs it. Share a relevant kit as soon as the lead is ready, skip a separate reply when the kit is enough, and stay silent when nothing is needed. Return plain text only.`;
      const suggested = await generateGeminiText(apiKey, {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      return res.status(200).json({ suggested_prompt: suggested });
    }

    // Live Dry-Run Test of AI Sales Agent without messaging any real customer
    if (req.method === "POST" && req.query.action === "test") {
      const { message = "Haan interested hoon, main Physics padhata hoon" } = req.body || {};
      const apiKey = getGeminiApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: "Gemini is not configured for this deployment." });
      }
      const { data: kits = [] } = await sb.from("asset_kits").select("*").eq("user_id", user.id);
      const result = await runGeminiSalesAgent({
        user,
        lead: { name: "Test Teacher", ai_questions_asked: 1, assets_sent: false },
        history: [{ direction: "incoming", body: String(message) }],
        assetKits: kits,
      });
      if (!result) return res.status(400).json({ error: "Gemini did not return a valid response. Try again or check the Gemini deployment logs." });
      return res.status(200).json({ result });
    }

    if (req.method === "POST" || req.method === "PATCH") {
      const editing = req.method === "PATCH";
      const kitId = Number(req.query.id);
      let existing = null;
      if (editing) {
        if (!Number.isSafeInteger(kitId) || kitId < 1) return res.status(400).json({ error: "Valid asset kit id required." });
        const { data, error } = await sb.from("asset_kits").select("asset_url, asset_type").eq("id", kitId).eq("user_id", user.id).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Kit not found." });
        existing = data;
      }
      const { category_name = "", keywords = "", message_text = "", asset_url = "", asset_type = "document", asset_path = "" } = req.body || {};
      if (!String(category_name).trim()) {
        return res.status(400).json({ error: "Category name (e.g. Physics, UPSC, GPSC) is required." });
      }
      let attachment = String(asset_url).trim();
      let attachmentType = ["document", "image", "video"].includes(asset_type) ? asset_type : "document";
      if (asset_path) {
        const prefix = `${user.id}/`;
        if (attachment || typeof asset_path !== "string" || !asset_path.startsWith(prefix) ||
            !/^[a-f0-9-]{36}\.(jpg|png|mp4|pdf)$/.test(asset_path.slice(prefix.length))) {
          return res.status(400).json({ error: "Choose a local file or a public URL." });
        }
        const { data: file, error } = await sb.storage.from(ASSET_BUCKET).info(asset_path);
        if (error || !file) return res.status(400).json({ error: "File upload is missing. Select the file and try again." });
        const format = Object.hasOwn(ASSET_MEDIA, file.contentType) ? ASSET_MEDIA[file.contentType] : null;
        if (!format || !asset_path.endsWith("." + format.extension) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > format.maxMB * 1024 * 1024) {
          return res.status(400).json({ error: "The uploaded file type or size is not supported." });
        }
        attachment = "storage:" + asset_path;
        attachmentType = format.type;
      } else if (attachment && !/^https?:\/\//i.test(attachment)) {
        return res.status(400).json({ error: "Enter a public HTTP(S) URL or select a file." });
      }
      if (!attachment && !asset_path && existing) {
        attachment = existing.asset_url || "";
        attachmentType = existing.asset_type;
      }
      if (!attachment && !String(message_text).trim()) {
        return res.status(400).json({ error: "Add a brochure file, link, or message." });
      }

      const values = {
          user_id: user.id,
          category_name: String(category_name).trim(),
          keywords: String(keywords || category_name).trim(),
          message_text: String(message_text).trim(),
          asset_url: attachment,
          asset_type: attachmentType,
      };
      const table = sb.from("asset_kits");
      const query = editing ? table.update(values).eq("id", kitId).eq("user_id", user.id) : table.insert(values);
      const { data: kit, error } = await query.select("*").single();
      if (error) throw error;
      return res.status(editing ? 200 : 201).json({ kit });
    }

    if (req.method === "DELETE") {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: "Asset kit id required." });
      const { error } = await sb.from("asset_kits").delete().eq("id", id).eq("user_id", user.id);
      if (error) throw error;
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
};
