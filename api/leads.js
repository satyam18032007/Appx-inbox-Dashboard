const { getSupabase, requireUser, normalizePhone, sendMetaWhatsApp, getApprovedWhatsAppTemplate, formatSentTemplate, resolveTemplateHeader, CAMPAIGN_FOLLOW_UP_MARKER, getGeminiApiKey } = require("./_lib");

const VALID_STATUSES = [
  "No Response",
  "Interested",
  "Demo Requested",
  "Demo Booked",
  "Demo Done",
  "Follow-up Due",
  "Sold",
  "Not Interested",
];

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res, "leads");
    if (!user) return;
    const sb = getSupabase();

    if (req.method === "GET") {
      const { data: leads, error } = await sb
        .from("leads")
        .select("*")
        .eq("user_id", user.id)
        .order("has_responded", { ascending: false })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      let campaignSent;
      if (req.query.summary === "1") {
        const { count, error: countError } = await sb.from("messages")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id).eq("direction", "outgoing")
          .like("body", "[Template: %").neq("wa_message_id", "");
        if (countError) throw countError;
        campaignSent = count;
      }
      return res.status(200).json({ leads: leads || [], campaignSent });
    }

    if (req.method === "POST" && req.query.action === "bulk") {
      const {
        rows = [],
        campaign_name = "appx (Marketing)",
        send_template = false,
        coaching_follow_up = false,
        template_name = "",
        template_lang = "en",
        template_params,
        template_media_url = "",
        template_image_base64,
        template_var_mode = "none", // 'none' | 'name' | 'name_business'
      } = req.body || {};
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No contacts provided in CSV." });
      }
      if (send_template && !template_name) return res.status(400).json({ error: "Choose an approved template." });
      if (send_template && template_params !== undefined &&
          (!Array.isArray(template_params) || template_params.some(value => typeof value !== "string" || !value.trim()))) {
        return res.status(400).json({ error: "Fill all template values before running the campaign." });
      }
      const approvedTemplate = send_template
        ? await getApprovedWhatsAppTemplate(user, template_name, template_lang)
        : null;
      let templateButtons = [];
      if (coaching_follow_up === true) {
        const replies = approvedTemplate?.quick_replies || [];
        if (!replies.some(button => String(button.text).trim().toLowerCase() === "yes")) {
          return res.status(400).json({ error: "Select an approved template with a YES quick-reply button for the coaching follow-up." });
        }
        if (!user.ai_enabled || !getGeminiApiKey() || !normalizePhone(user.owner_alert_phone || "")) {
          return res.status(400).json({ error: "In AI Agent settings, enable AI replies and save your alert phone before starting this campaign." });
        }
        templateButtons = replies.map(button => ({
          type: "button", sub_type: "quick_reply", index: String(button.index),
          parameters: [{ type: "payload", payload: `appx_coaching_${button.index}` }],
        }));
      }
      let templateHeader = null;
      let fixedTemplateBody = null;
      if (approvedTemplate) {
        try {
          if (template_params !== undefined) fixedTemplateBody = formatSentTemplate(approvedTemplate, template_params);
          templateHeader = await resolveTemplateHeader(user, approvedTemplate, template_media_url, template_image_base64);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
      }
      const today = new Date().toISOString().slice(0, 10);
      let added = 0;
      let skipped = 0;
      let sent = 0;
      let failed = 0;
      let lastError = "";

      for (const r of rows) {
        const phone = normalizePhone(r.phone || r.whatsapp || r.mobile || r.number);
        if (!phone) {
          skipped++;
          continue;
        }
        const name = String(r.name || r.full_name || `+${phone}`).trim();
        const business = String(r.business_name || r.business || r.academy || "your institute").trim();

        const { data: existing, error: lookupError } = await sb
          .from("leads")
          .select("id, reply_type")
          .eq("user_id", user.id)
          .eq("phone", phone)
          .maybeSingle();

        if (lookupError) {
          failed++;
          lastError = "Could not check contact opt-out status.";
          continue;
        }
        if (existing?.reply_type === "Opted out") {
          skipped++;
          continue;
        }
        let leadId = existing ? existing.id : null;
        if (!leadId) {
          const { data: inserted, error: iErr } = await sb
            .from("leads")
            .insert({
              user_id: user.id,
              name,
              phone,
              business_name: business,
              campaign_name,
              reply_type: "No response",
              ticket_state: "Pending",
              status: "No Response",
              has_responded: false,
              followup_date: today,
              deal_value: 0,
              notes: "Imported from bulk campaign CSV",
            })
            .select("id")
            .single();
          if (iErr) {
            skipped++;
            continue;
          }
          leadId = inserted.id;
          added++;
        } else {
          skipped++;
        }

        if (send_template && template_name) {
          const params = template_params ?? (
            template_var_mode === "name"
              ? [name]
              : template_var_mode === "name_business"
              ? [name, business]
              : []);
          try {
            const storedBody = fixedTemplateBody ?? formatSentTemplate(approvedTemplate, params);
            const waId = await sendMetaWhatsApp({
              user,
              toPhone: phone,
              mode: "template",
              templateName: template_name,
              templateLang: template_lang,
              templateParams: params,
              templateHeader,
              templateButtons,
            });
            const { error: recordError } = await sb.from("messages").insert({
              user_id: user.id,
              lead_id: leadId,
              direction: "outgoing",
              body: coaching_follow_up === true ? storedBody + CAMPAIGN_FOLLOW_UP_MARKER : storedBody,
              wa_message_id: waId,
              delivery_status: "Sent",
            });
            sent++;
            if (recordError) {
              console.error("Bulk message accepted by Meta but could not be recorded:", waId, recordError.code);
              lastError = "A sent message could not be recorded in AppX.";
            }
          } catch (e) {
            failed++;
            lastError = e.message;
            await sb.from("leads").update({ ticket_state: "Failed" }).eq("id", leadId).eq("user_id", user.id);
          }
        }
      }

      return res.status(200).json({ added, skipped, sent, failed, lastError });
    }

    if (req.method === "POST") {
      const { name = "", phone = "", business_name = "", campaign_name = "appx (Marketing)", status = "No Response", demo_date = "", followup_date = "", deal_value = 0, notes = "" } = req.body || {};
      const normPhone = normalizePhone(phone);
      if (!normPhone) return res.status(400).json({ error: "Valid WhatsApp phone number required." });
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status." });

      const hasResp = status !== "No Response";
      const { data: created, error } = await sb
        .from("leads")
        .insert({
          user_id: user.id,
          name: String(name).trim() || `+${normPhone}`,
          phone: normPhone,
          business_name: String(business_name).trim(),
          campaign_name: String(campaign_name).trim(),
          reply_type: hasResp ? "Interested" : "No response",
          ticket_state: status === "Sold" ? "Resolved" : "Pending",
          status,
          has_responded: hasResp,
          demo_date,
          followup_date,
          deal_value: Number(deal_value || 0),
          notes: String(notes).trim(),
        })
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") return res.status(409).json({ error: "A lead with this WhatsApp number already exists." });
        throw error;
      }
      return res.status(201).json({ lead: created });
    }

    if (req.method === "PATCH") {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: "Lead id required." });

      const allowed = ["name", "business_name", "campaign_name", "reply_type", "ticket_state", "status", "demo_date", "followup_date", "deal_value", "notes", "unread_count", "ai_paused"];
      const updates = { updated_at: new Date().toISOString() };
      for (const k of allowed) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
          if (k === "deal_value" || k === "unread_count") updates[k] = Number(req.body[k] || 0);
          else if (k === "ai_paused") updates[k] = Boolean(req.body[k]);
          else updates[k] = req.body[k];
        }
      }
      if (updates.status && !VALID_STATUSES.includes(updates.status)) {
        return res.status(400).json({ error: "Invalid status." });
      }
      if (updates.status === "Sold" && !updates.ticket_state) {
        updates.ticket_state = "Resolved";
      }

      const { data: updated, error } = await sb
        .from("leads")
        .update(updates)
        .eq("id", id)
        .eq("user_id", user.id)
        .select("*")
        .single();
      if (error) throw error;
      return res.status(200).json({ lead: updated });
    }

    if (req.method === "DELETE") {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: "Lead id required." });
      const { error } = await sb.from("leads").delete().eq("id", id).eq("user_id", user.id);
      if (error) throw error;
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
};
