const { getSupabase, requireUser, sanitizeUser, getGeminiApiKey, generateGeminiText, runGeminiSalesAgent } = require("./_lib");

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
        ai_enabled = false,
        ai_max_questions = 3,
        ai_system_prompt = "",
        owner_alert_phone = "",
        fast2sms_api_key = "",
      } = req.body || {};

      const updates = {
        ai_enabled: Boolean(ai_enabled),
        ai_max_questions: Math.max(1, Math.min(8, Number(ai_max_questions || 3))),
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

    // 1-Click AI Suggest Script based on user's business goal
    if (req.method === "POST" && req.query.action === "suggest") {
      const { goal = "AppX branded teaching app and social media marketing for educators" } = req.body || {};
      const apiKey = getGeminiApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: "Gemini is not configured for this deployment." });
      }
      const prompt = `Write a concise, practical system instruction (max 5 lines) for a Hinglish WhatsApp sales qualifier bot for this business: "${goal}". It should ask 2-3 short friendly questions one by one (subject/niche, audience size on YouTube/WhatsApp/FB, interest in app + social media handling), then share matching category brochures/vouchers, and finally ask for a convenient 15-min demo time. Return plain text only.`;
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
      if (!result) return res.status(400).json({ error: "Gemini did not return a valid response. Check your API key." });
      return res.status(200).json({ result });
    }

    if (req.method === "POST") {
      const { category_name = "", keywords = "", message_text = "", asset_url = "", asset_type = "document" } = req.body || {};
      if (!String(category_name).trim()) {
        return res.status(400).json({ error: "Category name (e.g. Physics, UPSC, GPSC) is required." });
      }
      const { data: kit, error } = await sb
        .from("asset_kits")
        .insert({
          user_id: user.id,
          category_name: String(category_name).trim(),
          keywords: String(keywords || category_name).trim(),
          message_text: String(message_text).trim(),
          asset_url: String(asset_url).trim(),
          asset_type: ["document", "image", "video"].includes(asset_type) ? asset_type : "document",
        })
        .select("*")
        .single();
      if (error) throw error;
      return res.status(201).json({ kit });
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
