const { getSupabase, requireUser, normalizePhone, downloadMetaMediaBase64, uploadWhatsAppVoice, sendMetaWhatsApp, getApprovedWhatsAppTemplate, formatSentTemplate, resolveTemplateHeader, takeWhatsAppThread, COACHING_TEST_MARKER, getGeminiApiKey } = require("./_lib");

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res, "messages");
    if (!user) return;
    const sb = getSupabase();

    if (req.method === "GET") {
      const leadId = Number(req.query.lead_id);
      if (!leadId) return res.status(400).json({ error: "lead_id required." });

      if (req.query.audio_id) {
        const id = String(req.query.audio_id);
        if (!/^[1-9]\d*$/.test(id)) return res.status(400).json({ error: "Invalid voice note ID." });
        const { data: message, error } = await sb.from("messages").select("audio_media_id")
          .eq("id", id).eq("lead_id", leadId).eq("user_id", user.id).maybeSingle();
        if (error) throw error;
        if (!message?.audio_media_id) return res.status(404).json({ error: "Voice note not found." });
        const audio = await downloadMetaMediaBase64(user, message.audio_media_id, 2 * 1024 * 1024);
        if (!audio || !/^audio\//i.test(audio.mimeType)) {
          return res.status(410).json({ error: "This voice note is unavailable from WhatsApp or is too large for playback here." });
        }
        return res.status(200).json({ audio });
      }

      if (user.team_role !== "viewer") await sb.from("leads").update({ unread_count: 0 }).eq("id", leadId).eq("user_id", user.id);
      const { data: messages, error } = await sb
        .from("messages")
        .select("*")
        .eq("lead_id", leadId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.status(200).json({ messages: messages || [] });
    }

    if (req.method === "POST") {
      const { lead_id, body = "", mode = "reply", template_name = "", template_lang = "en", template_params = [], template_media_url = "", template_image_base64, voice_base64, fresh_coaching_test = false } = req.body || {};
      const leadId = Number(lead_id);
      if (!leadId) return res.status(400).json({ error: "lead_id required." });

      if (!["reply", "template", "voice", "take_control"].includes(mode)) {
        return res.status(400).json({ error: "Invalid messaging action." });
      }
      if (mode === "take_control" && user.team_role) {
        return res.status(403).json({ error: "Only the workspace owner can take control." });
      }
      const cleanText = String(body).trim();
      if (mode === "reply" && !cleanText) {
        return res.status(400).json({ error: "Message text cannot be empty." });
      }
      if (mode === "template" && !template_name) {
        return res.status(400).json({ error: "Template name is required in Template mode." });
      }

      const { data: lead, error: lErr } = await sb
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (lErr || !lead) return res.status(404).json({ error: "Lead not found." });

      if (mode === "take_control") {
        const result = await takeWhatsAppThread(user, normalizePhone(lead.phone));
        return res.status(200).json({ control_taken: true, request_id: result.request_id });
      }

      if (lead.reply_type === "Opted out") {
        return res.status(409).json({ error: "This contact opted out of WhatsApp messages." });
      }

      const lastIncoming = Date.parse(lead.last_incoming_at);
      const now = Date.now();
      if (["reply", "voice"].includes(mode) && !(lastIncoming <= now && now - lastIncoming < 86400000)) {
        return res.status(400).json({ error: "Reply window closed. Choose an approved template to start the conversation.", code: "reply_window_closed" });
      }

      let audioMediaId;
      if (mode === "voice") {
        if (typeof voice_base64 !== "string" || voice_base64.length > 2800000) {
          return res.status(400).json({ error: "Record a voice note under 2 MB." });
        }
        const audio = Buffer.from(voice_base64, "base64");
        if (audio.length > 2 * 1024 * 1024 || audio.toString("ascii", 0, 4) !== "OggS" ||
            audio.indexOf("OpusHead") < 0 || audio.indexOf("OpusHead") > 128) {
          return res.status(400).json({ error: "A valid Ogg Opus voice note is required." });
        }
        audioMediaId = await uploadWhatsAppVoice(user, audio);
      }
      const approvedTemplate = mode === "template"
        ? await getApprovedWhatsAppTemplate(user, template_name, template_lang)
        : null;
      let templateButtons = [];
      if (fresh_coaching_test === true) {
        if (user.team_role) return res.status(403).json({ error: "Only the workspace owner can start a fresh test." });
        const replies = approvedTemplate?.quick_replies || [];
        if (!replies.some(button => String(button.text).trim().toLowerCase() === "yes")) {
          return res.status(400).json({ error: "A fresh coaching test needs an approved template with a YES button." });
        }
        if (!user.ai_enabled || !getGeminiApiKey() || lead.ai_paused) {
          return res.status(400).json({ error: "Enable AI and unpause this chat before starting a fresh coaching test." });
        }
        templateButtons = replies.map(button => ({
          type: "button", sub_type: "quick_reply", index: String(button.index),
          parameters: [{ type: "payload", payload: `appx_coaching_test_${button.index}` }],
        }));
      }
      let templateHeader = null;
      let storedBody = mode === "voice" ? "[Voice Note sent]" : cleanText;
      if (approvedTemplate) {
        try {
          storedBody = formatSentTemplate(approvedTemplate, template_params);
          templateHeader = await resolveTemplateHeader(user, approvedTemplate, template_media_url, template_image_base64);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
      }

      // Send live via Meta WhatsApp Cloud API (throws real error if not connected or Meta rejects)
      const waMsgId = await sendMetaWhatsApp({
        user,
        toPhone: lead.phone,
        text: cleanText,
        mode,
        templateName: template_name,
        templateLang: template_lang,
        templateParams: template_params,
        templateHeader,
        templateButtons,
        audioMediaId,
      });

      const { data: msg, error: mErr } = await sb
        .from("messages")
        .insert({
          user_id: user.id,
          lead_id: leadId,
          direction: "outgoing",
          body: fresh_coaching_test === true ? storedBody + COACHING_TEST_MARKER : storedBody,
          wa_message_id: waMsgId,
          ...(audioMediaId ? { audio_media_id: audioMediaId } : {}),
          delivery_status: "Sent",
        })
        .select("*")
        .single();
      if (mErr) throw mErr;

      await sb
        .from("leads")
        .update({ last_message: storedBody, unread_count: 0, updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .eq("user_id", user.id);

      return res.status(200).json({ message: msg });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    if (err.metaCode === 131070) {
      return res.status(409).json({ error: "Another app controls this chat. Ask the workspace owner to take control.", code: 131070 });
    }
    return res.status(400).json({ error: err.message || "WhatsApp action failed", code: err.metaCode });
  }
};
