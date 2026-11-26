const crypto = require("node:crypto");
const { getSupabase, normalizePhone, downloadMetaMediaBase64, sendMetaWhatsApp, sendOwnerAlert, getGeminiApiKey, runGeminiSalesAgent } = require("./_lib");

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

    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      const { data: user } = await sb.from("users").select("verify_token").eq("id", userId).maybeSingle();
      if (user && mode === "subscribe" && token === user.verify_token) {
        return res.status(200).send(String(challenge || ""));
      }
      return res.status(403).send("Webhook verification failed");
    }

    if (req.method === "POST") {
      const { data: user } = await sb.from("users").select("*").eq("id", userId).maybeSingle();
      if (!user) return res.status(404).json({ error: "User not found" });

      const secret = user.meta_app_secret;
      if (!secret) return res.status(503).json({ error: "Webhook signing secret is not configured." });
      const signature = req.headers["x-hub-signature-256"];
      if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
        return res.status(401).json({ error: "Invalid webhook signature." });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return res.status(413).json({ error: "Webhook payload too large." });
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks);
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
      if (!crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) {
        return res.status(401).json({ error: "Invalid webhook signature." });
      }
      let body;
      try { body = JSON.parse(rawBody.toString("utf8")); }
      catch { return res.status(400).json({ error: "Invalid webhook payload." }); }
      const entries = Array.isArray(body?.entry) ? body.entry : [];
      const today = new Date().toISOString().slice(0, 10);
      const nowIso = new Date().toISOString();
      let processed = 0;

      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const val = change.value || {};
          if (!user.phone_number_id || String(val.metadata?.phone_number_id || "") !== String(user.phone_number_id)) continue;
          const contactsMap = {};
          for (const c of val.contacts || []) {
            if (c.wa_id) contactsMap[c.wa_id] = c.profile?.name || "";
          }

          for (const st of val.statuses || []) {
            if (st.id && st.status) {
              const label = st.status.charAt(0).toUpperCase() + st.status.slice(1);
              await sb.from("messages").update({ delivery_status: label }).eq("wa_message_id", st.id).eq("user_id", userId);
            }
          }

          for (const msg of val.messages || []) {
            const fromPhone = normalizePhone(msg.from || "");
            const waId = msg.id || "";
            const mtype = msg.type || "text";
            let text = "";
            let audioMedia = null;
            if (mtype === "text") text = msg.text?.body || "";
            else if (mtype === "button") text = msg.button?.text || "[Button Reply]";
            else if (mtype === "interactive") {
              text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Interactive Reply]";
            } else if (mtype === "audio" && msg.audio?.id) {
              text = "[Voice Note received]";
              audioMedia = await downloadMetaMediaBase64(user, msg.audio.id);
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

            let lead;
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
                .select("*")
                .single();
              lead = inserted;
            } else {
              const nextStatus = ["No Response", "Interested"].includes(existing.status) ? auto_status : existing.status;
              const { data: updated } = await sb
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
                .eq("id", existing.id)
                .eq("user_id", userId)
                .select("*")
                .single();
              lead = updated;
            }

            if (!lead) continue;

            await sb.from("messages").insert({
              user_id: userId,
              lead_id: lead.id,
              direction: "incoming",
              body: text,
              wa_message_id: waId,
              delivery_status: "received",
            });
            processed++;

            // === AI SALES QUALIFIER AGENT (Gemini + Category Assets + Owner Demo Alert) ===
            if (user.ai_enabled && getGeminiApiKey() && !lead.ai_paused && reply_type !== "Opted out" && reply_type !== "Not interested") {
              try {
                const [{ data: history = [] }, { data: assetKits = [] }] = await Promise.all([
                  sb.from("messages").select("direction, body").eq("lead_id", lead.id).eq("user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(12),
                  sb.from("asset_kits").select("*").eq("user_id", userId),
                ]);

                const aiOut = await runGeminiSalesAgent({ user, lead, history: history.slice().reverse(), assetKits, audioMedia });
                if (aiOut) {
                  if (audioMedia && aiOut.voice_transcript) {
                    await sb.from("messages").insert({
                      user_id: userId,
                      lead_id: lead.id,
                      direction: "incoming",
                      body: `[Voice Note Transcript]: ${aiOut.voice_transcript}`,
                      delivery_status: "received",
                    });
                  }
                  const leadUpdates = { updated_at: new Date().toISOString() };
                  if (aiOut.detected_category) leadUpdates.detected_category = aiOut.detected_category;
                  const asked = Number(lead.ai_questions_asked || 0);
                  const ceiling = Number(user.ai_max_questions ?? 0);
                  const atCeiling = ceiling > 0 && asked >= ceiling;

                  if (aiOut.reply && !(atCeiling && aiOut.asked_a_question)) {
                    const replyWaId = await sendMetaWhatsApp({ user, toPhone: fromPhone, text: aiOut.reply, mode: "reply" });
                    await sb.from("messages").insert({
                      user_id: userId,
                      lead_id: lead.id,
                      direction: "outgoing",
                      body: aiOut.reply,
                      wa_message_id: replyWaId,
                      delivery_status: "AI Sent",
                    });
                    if (aiOut.asked_a_question) leadUpdates.ai_questions_asked = asked + 1;
                    leadUpdates.last_message = aiOut.reply;
                  }

                  // 2. Send Category-Based Brochure / Voucher / Assets once qualified
                  if (aiOut.send_assets && !lead.assets_sent && assetKits.length > 0) {
                    const targetCat = String(aiOut.detected_category || "").toLowerCase();
                    const matchedKit =
                      assetKits.find((k) => k.category_name.toLowerCase() === targetCat) ||
                      assetKits.find((k) => String(k.keywords || "").toLowerCase().split(",").some((kw) => kw.trim() && targetCat.includes(kw.trim()))) ||
                      assetKits.find((k) => k.category_name.toLowerCase() === "general");

                    if (matchedKit && (matchedKit.asset_url || matchedKit.message_text)) {
                      let assetWaId;
                      if (matchedKit.asset_url) {
                        try {
                          assetWaId = await sendMetaWhatsApp({
                            user,
                            toPhone: fromPhone,
                            text: matchedKit.message_text || `AppX ${matchedKit.category_name} Brochure`,
                            mode: "media",
                            mediaUrl: matchedKit.asset_url,
                            mediaType: matchedKit.asset_type || "document",
                          });
                        } catch (e) {
                          // Fallback to sending link as text if media fetch fails
                          assetWaId = await sendMetaWhatsApp({
                            user,
                            toPhone: fromPhone,
                            text: `${matchedKit.message_text || ""}\n${matchedKit.asset_url}`.trim(),
                            mode: "reply",
                          });
                        }
                      } else if (matchedKit.message_text) {
                        assetWaId = await sendMetaWhatsApp({ user, toPhone: fromPhone, text: matchedKit.message_text, mode: "reply" });
                      }
                      const assetBody = `[AI Sent ${matchedKit.category_name} Kit] ${matchedKit.message_text || matchedKit.asset_url}`;
                      await sb.from("messages").insert({
                        user_id: userId,
                        lead_id: lead.id,
                        direction: "outgoing",
                        body: assetBody,
                        wa_message_id: assetWaId,
                        delivery_status: "AI Sent",
                      });
                      leadUpdates.last_message = assetBody;
                      leadUpdates.assets_sent = true;
                      if (lead.ai_stage !== "demo_booked") leadUpdates.ai_stage = "awaiting_demo_time";
                    }
                  }

                  // 3. Demo Booked -> Update CRM + Instant Alert to Owner's Phone (SMS / WhatsApp)
                  if (aiOut.demo_booked && lead.ai_stage !== "demo_booked") {
                    const slotText = aiOut.demo_time_text || text;
                    leadUpdates.status = "Demo Booked";
                    leadUpdates.demo_date = today;
                    leadUpdates.ai_stage = "demo_booked";
                    leadUpdates.notes = `${lead.notes ? lead.notes + " | " : ""}Demo requested: ${slotText} (${aiOut.detected_category || lead.detected_category || "General"})`;

                    const alertMsg = `AppX Demo Alert! Lead: ${lead.name} (+${fromPhone}) | Category: ${aiOut.detected_category || lead.detected_category || "General"} | Requested Time: ${slotText}`;
                    await sendOwnerAlert({ user, message: alertMsg });
                  }

                  await sb.from("leads").update(leadUpdates).eq("id", lead.id).eq("user_id", userId);
                }
              } catch (aiErr) {
                // Never fail webhook acknowledgement if AI errors
                console.error("AI agent error:", aiErr.message);
              }
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
