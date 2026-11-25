const { getSupabase, normalizePhone } = require("./_lib");

function classifyReply(text) {
  const lower = String(text || "").toLowerCase();
  if (["stop", "unsubscribe", "opt out", "opt-out"].some((k) => lower.includes(k))) {
    return { reply_type: "Opted out", auto_status: "Not Interested" };
  }
  if (["not interested", "nahi chahiye", "no thanks", "don't want"].some((k) => lower.includes(k))) {
    return { reply_type: "Not interested", auto_status: "Not Interested" };
  }
  if (["demo", "book", "slot", "schedule", "call me"].some((k) => lower.includes(k))) {
    return { reply_type: "Interested", auto_status: "Demo Booked" };
  }
  if (["price", "cost", "plan", "rate", "kitna", "interested", "details", "appx"].some((k) => lower.includes(k))) {
    return { reply_type: "Interested", auto_status: "Interested" };
  }
  return { reply_type: "Free text", auto_status: "Interested" };
}

module.exports = async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).send("Missing user_id");

    const sb = getSupabase();

    // 1. Meta Webhook Verification Handshake (GET)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      const { data: user } = await sb
        .from("users")
        .select("verify_token")
        .eq("id", userId)
        .maybeSingle();

      if (user && mode === "subscribe" && token === user.verify_token) {
        return res.status(200).send(String(challenge || ""));
      }
      return res.status(403).send("Webhook verification failed");
    }

    // 2. Incoming WhatsApp Messages & Delivery Statuses (POST)
    if (req.method === "POST") {
      const body = req.body || {};
      const entries = Array.isArray(body.entry) ? body.entry : [];
      const today = new Date().toISOString().slice(0, 10);
      const nowIso = new Date().toISOString();
      let processed = 0;

      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const val = change.value || {};
          const contactsMap = {};
          for (const c of val.contacts || []) {
            if (c.wa_id) contactsMap[c.wa_id] = c.profile?.name || "";
          }

          // Update delivery status ticks (sent -> delivered -> read -> failed)
          for (const st of val.statuses || []) {
            if (st.id && st.status) {
              const label = st.status.charAt(0).toUpperCase() + st.status.slice(1);
              await sb
                .from("messages")
                .update({ delivery_status: label })
                .eq("wa_message_id", st.id)
                .eq("user_id", userId);
            }
          }

          // Ingest incoming customer replies
          for (const msg of val.messages || []) {
            const fromPhone = normalizePhone(msg.from || "");
            const waId = msg.id || "";
            const mtype = msg.type || "text";
            let text = "";
            if (mtype === "text") text = msg.text?.body || "";
            else if (mtype === "button") text = msg.button?.text || "[Button Reply]";
            else if (mtype === "interactive") {
              text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Interactive Reply]";
            } else {
              text = `[${mtype} message]`;
            }

            if (!fromPhone || !text) continue;

            const { reply_type, auto_status } = classifyReply(text);
            const senderName = contactsMap[msg.from] || contactsMap[fromPhone] || `+${fromPhone}`;

            const { data: existing } = await sb
              .from("leads")
              .select("*")
              .eq("user_id", userId)
              .eq("phone", fromPhone)
              .maybeSingle();

            let leadId;
            if (!existing) {
              const { data: inserted } = await sb
                .from("leads")
                .insert({
                  user_id: userId,
                  name: senderName,
                  phone: fromPhone,
                  campaign_name: "Meta WhatsApp Campaign",
                  reply_type,
                  ticket_state: "Pending",
                  status: auto_status,
                  has_responded: true,
                  followup_date: today,
                  last_message: text,
                  last_incoming_at: nowIso,
                  unread_count: 1,
                  updated_at: nowIso,
                })
                .select("id")
                .single();
              leadId = inserted?.id;
            } else {
              leadId = existing.id;
              const nextStatus = ["No Response", "Interested"].includes(existing.status) ? auto_status : existing.status;
              await sb
                .from("leads")
                .update({
                  last_message: text,
                  last_incoming_at: nowIso,
                  has_responded: true,
                  reply_type,
                  ticket_state: "Pending",
                  status: nextStatus,
                  unread_count: (existing.unread_count || 0) + 1,
                  updated_at: nowIso,
                })
                .eq("id", leadId)
                .eq("user_id", userId);
            }

            if (leadId) {
              await sb.from("messages").insert({
                user_id: userId,
                lead_id: leadId,
                direction: "incoming",
                body: text,
                wa_message_id: waId,
                delivery_status: "received",
              });
              processed++;
            }
          }
        }
      }

      return res.status(200).json({ status: "ok", processed });
    }

    return res.status(405).send("Method not allowed");
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
