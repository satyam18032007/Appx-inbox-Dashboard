const crypto = require("node:crypto");
const { getSupabase, normalizePhone, downloadMetaMediaBase64, sendMetaWhatsApp, sendOwnerAlert, getGeminiApiKey, runGeminiSalesAgent, ASSET_BUCKET, selectAssetKit, matchCoachingSubject, COACHING_TEST_MARKER, COACHING_TEST_USED, CAMPAIGN_FOLLOW_UP_MARKER, CAMPAIGN_FEATURES, CAMPAIGN_SUBJECT_QUESTION } = require("./_lib");

function classifyReply(text) {
  const lower = String(text || "").toLowerCase();
  if (/^(?:please\s+)?(?:stop(?:\s+(?:sending (?:me )?messages|messaging me|contacting me))?|unsubscribe(?: me)?|opt[ -]out)[\s.!?]*$/i.test(lower.trim())) {
    return { reply_type: "Opted out", auto_status: "Not Interested" };
  }
  if (["not interested", "nahi chahiye", "no thanks", "don't want"].some((k) => lower.includes(k))) {
    return { reply_type: "Not interested", auto_status: "Not Interested" };
  }
  if (["demo", "book", "slot", "schedule", "call me"].some((k) => lower.includes(k))) {
    return { reply_type: "Interested", auto_status: "Interested" };
  }
  if (["price", "cost", "plan", "rate", "kitna", "interested", "details", "appx"].some((k) => lower.includes(k))) {
    return { reply_type: "Interested", auto_status: "Interested" };
  }
  return { reply_type: "Free text", auto_status: "Interested" };
}

async function sendCoachingFollowUp({ sb, user, lead, fromPhone }) {
  const stage = lead.ai_stage ?? null;
  if (["coaching_intro_sending", "awaiting_coaching_subject", "awaiting_demo_time", "demo_requested", "demo_booked"].includes(stage)) return;
  let claim = sb.from("leads").update({ ai_stage: "coaching_intro_sending" })
    .eq("user_id", user.id).eq("id", lead.id).neq("reply_type", "Opted out").or("ai_paused.is.null,ai_paused.eq.false");
  claim = stage === null ? claim.is("ai_stage", null) : claim.eq("ai_stage", stage);
  const { data: claimed, error: claimError } = await claim.select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;

  let nextStage = stage;
  try {
    const replies = stage === "coaching_subject_pending"
      ? [CAMPAIGN_SUBJECT_QUESTION] : [CAMPAIGN_FEATURES, CAMPAIGN_SUBJECT_QUESTION];
    for (const body of replies) {
      const id = await sendMetaWhatsApp({ user, toPhone: fromPhone, text: body, mode: "reply" });
      nextStage = body === CAMPAIGN_FEATURES ? "coaching_subject_pending" : "awaiting_coaching_subject";
      const { error } = await sb.from("messages").insert({
        user_id: user.id, lead_id: lead.id, direction: "outgoing", body, wa_message_id: id, delivery_status: "AI Sent",
      });
      if (error) throw error;
    }
  } finally {
    const { error } = await sb.from("leads").update({ ai_stage: nextStage })
      .eq("user_id", user.id).eq("id", lead.id).eq("ai_stage", "coaching_intro_sending");
    if (error) throw error;
  }
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
            const audioId = mtype === "audio" ? msg.audio?.id : null;
            if (mtype === "text") text = msg.text?.body || "";
            else if (mtype === "button") text = msg.button?.text || "[Button Reply]";
            else if (mtype === "interactive") {
              text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Interactive Reply]";
            } else if (mtype === "audio" && msg.audio?.id) {
              text = "[Voice Note received]";
            } else {
              text = `[${mtype} message]`;
            }

            if (!fromPhone || !text || !waId) continue;

            const { data: duplicate, error: lookupError } = await sb.from("messages")
              .select("id").eq("user_id", userId).eq("direction", "incoming")
              .eq("wa_message_id", waId).limit(1).maybeSingle();
            if (lookupError) throw lookupError;
            if (duplicate) continue;

            const { reply_type, auto_status } = classifyReply(text);
            const senderName = contactsMap[msg.from] || contactsMap[fromPhone] || `+${fromPhone}`;

            const { data: existing, error: leadLookupError } = await sb
              .from("leads")
              .select("*")
              .eq("user_id", userId)
              .eq("phone", fromPhone)
              .maybeSingle();

            if (leadLookupError) throw leadLookupError;

            let lead;
            if (!existing) {
              const { data: inserted, error: leadError } = await sb
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
              if (leadError) throw leadError;
              lead = inserted;
            } else {
              lead = existing;
            }

            const { error: insertError } = await sb.from("messages").insert({
              user_id: userId,
              lead_id: lead.id,
              direction: "incoming",
              body: text,
              wa_message_id: waId,
              ...(audioId ? { audio_media_id: String(audioId) } : {}),
              delivery_status: "received",
            });
            if (insertError?.code === "23505") continue;
            if (insertError) throw insertError;

            const optedOut = reply_type === "Opted out";
            let confirmOptOut = optedOut && !existing;
            if (existing) {
              const alreadyOptedOut = existing.reply_type === "Opted out";
              const nextStatus = ["No Response", "Interested"].includes(existing.status) ? auto_status : existing.status;
              const update = sb
                .from("leads")
                .update({
                  last_message: text,
                  last_incoming_at: nowIso,
                  has_responded: true,
                  ...(alreadyOptedOut ? {} : { reply_type, status: nextStatus }),
                  ticket_state: "Pending",
                  unread_count: (existing.unread_count || 0) + 1,
                  updated_at: nowIso,
                })
                .eq("id", existing.id)
                .eq("user_id", userId);
              const guardedUpdate = alreadyOptedOut
                ? update.eq("reply_type", "Opted out")
                : update.or("reply_type.is.null,reply_type.neq.Opted out");
              const { data: updated, error: updateError } = await guardedUpdate.select("*").maybeSingle();
              confirmOptOut = optedOut && !alreadyOptedOut && Boolean(updated);
              if (updateError) console.error("WhatsApp lead update failed:", updateError.code);
              lead = updated || existing;
            }

            processed++;

            if (confirmOptOut) {
              const confirmation = "Okay, you've been unsubscribed. We won't send you any more WhatsApp messages. Thank you.";
              try {
                const confirmationId = await sendMetaWhatsApp({ user, toPhone: fromPhone, text: confirmation, mode: "reply" });
                const { error: recordError } = await sb.from("messages").insert({
                  user_id: userId,
                  lead_id: lead.id,
                  direction: "outgoing",
                  body: confirmation,
                  wa_message_id: confirmationId,
                  delivery_status: "Sent",
                });
                if (recordError) throw recordError;
              } catch (error) {
                console.error("WhatsApp opt-out confirmation failed:", waId, error.message);
              }
            }

            if (optedOut || lead.reply_type === "Opted out" || (existing && lead === existing)) continue;

            const answer = text.trim().toLowerCase().replace(/[.!]+$/, "");
            const buttonReply = ["button", "interactive"].includes(mtype);
            const interested = (buttonReply || mtype === "text") &&
              /^(yes|yes[, ]+interested|interested|i['’]?m interested|i am interested|haan|ha|हाँ|हां)$/.test(answer);
            const decline = buttonReply && msg.context?.id && answer === "no";
            if (interested || decline) {
              try {
                const outgoing = sb.from("messages").select("body, wa_message_id")
                  .eq("user_id", user.id).eq("lead_id", lead.id).eq("direction", "outgoing");
                const lookup = msg.context?.id
                  ? outgoing.eq("wa_message_id", msg.context.id)
                  : outgoing.like("body", "[Template:%").order("created_at", { ascending: false }).order("id", { ascending: false });
                const { data: campaign, error } = await lookup.limit(1).maybeSingle();
                if (error) throw error;
                if (campaign?.body?.endsWith(COACHING_TEST_USED)) continue;
                const freshTest = campaign?.body?.endsWith(COACHING_TEST_MARKER);
                if (freshTest || campaign?.body?.endsWith(CAMPAIGN_FOLLOW_UP_MARKER)) {
                  if (interested && user.ai_enabled && !lead.ai_paused) {
                    if (freshTest) {
                      const { data: testClaim, error: testError } = await sb.from("messages")
                        .update({ body: campaign.body.slice(0, -COACHING_TEST_MARKER.length) + COACHING_TEST_USED })
                        .eq("user_id", user.id).eq("lead_id", lead.id).eq("wa_message_id", campaign.wa_message_id)
                        .eq("body", campaign.body).select("id").maybeSingle();
                      if (testError) throw testError;
                      if (!testClaim) continue;
                      const { data: reset, error: resetError } = await sb.from("leads")
                        .update({ ai_stage: "qualifying", assets_sent: false, ai_questions_asked: 0, detected_category: "", status: "Interested" })
                        .eq("user_id", user.id).eq("id", lead.id).neq("reply_type", "Opted out").select("*").maybeSingle();
                      if (resetError) throw resetError;
                      if (!reset) continue;
                      lead = reset;
                    }
                    await sendCoachingFollowUp({ sb, user, lead, fromPhone });
                  } else if (decline) {
                    const { error: declineError } = await sb.from("leads")
                      .update({ reply_type: "Not interested" })
                      .eq("user_id", user.id).eq("id", lead.id).neq("reply_type", "Opted out");
                    if (declineError) throw declineError;
                  }
                  continue;
                }
              } catch (error) {
                console.error("Coaching campaign follow-up failed:", waId, error.message);
                continue;
              }
            }

            // === AI SALES QUALIFIER AGENT (Gemini + Category Assets + Owner Demo Alert) ===
            if (user.ai_enabled && getGeminiApiKey() && !lead.ai_paused && reply_type !== "Opted out" && reply_type !== "Not interested") {
              try {
                const [{ data: history, error: historyError }, { data: assetKits, error: kitsError }] = await Promise.all([
                  sb.from("messages").select("direction, body").eq("lead_id", lead.id).eq("user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(12),
                  sb.from("asset_kits").select("*").eq("user_id", userId),
                ]);

                if (historyError || kitsError) throw new Error("AI context lookup failed");
                const audioMedia = audioId ? await downloadMetaMediaBase64(user, audioId) : null;
                const directCategory = mtype === "text" && lead.ai_stage === "awaiting_coaching_subject" && !lead.assets_sent
                  ? matchCoachingSubject(assetKits, text) : "";
                const aiOut = directCategory
                  ? { detected_category: directCategory, send_assets: true }
                  : await runGeminiSalesAgent({
                    user, lead, assetKits, audioMedia, latestMessage: text,
                    history: (() => {
                      const subjectQuestion = history.findIndex(entry => entry.direction === "outgoing" && entry.body === CAMPAIGN_SUBJECT_QUESTION);
                      return (subjectQuestion >= 0 ? history.slice(0, subjectQuestion + 1) : history.slice()).reverse();
                    })(),
                  });
                if (!aiOut) throw new Error("Gemini returned no usable sales decision");
                console.info("AI agent decision", { messageId: waId, reply: Boolean(aiOut.reply), assets: aiOut.send_assets, demo: aiOut.demo_booked });
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

                  const qualificationAllowed = !atCeiling || !aiOut.asked_a_question;
                  let reply = qualificationAllowed ? aiOut.reply : "";
                  if (!reply && aiOut.demo_booked) {
                    reply = aiOut.reply_language === "roman_hindi"
                      ? "Demo time share karne ke liye thanks. Team availability check karke slot confirm karegi aur meeting link share karegi."
                      : "Thanks for sharing your preferred time. Our team will check availability and confirm the slot and meeting link.";
                  }
                  const reschedule = /^reschedule[.!?]?$/i.test(text.trim());
                  if (!reply && (reschedule || aiOut.demo_requested)) {
                    reply = aiOut.reply_language === "roman_hindi"
                      ? "Ji, demo ke liye apni preferred date aur time bata dijiye."
                      : "What date and time would work best for your demo?";
                  }
                  if (reply) {
                    const replyWaId = await sendMetaWhatsApp({ user, toPhone: fromPhone, text: reply, mode: "reply" });
                    await sb.from("messages").insert({
                      user_id: userId,
                      lead_id: lead.id,
                      direction: "outgoing",
                      body: reply,
                      wa_message_id: replyWaId,
                      delivery_status: "AI Sent",
                    });
                    if (qualificationAllowed && aiOut.asked_a_question) leadUpdates.ai_questions_asked = asked + 1;
                    leadUpdates.last_message = reply;
                  }

                  // 2. Send Category-Based Brochure / Voucher / Assets once qualified
                  if (aiOut.send_assets && !lead.assets_sent && assetKits.length > 0) {
                    const matchedKit = selectAssetKit(assetKits, aiOut.detected_category);

                    if (matchedKit) {
                      const { data: claim, error: claimError } = await sb.from("leads").update({ assets_sent: true })
                        .eq("user_id", userId).eq("id", lead.id).neq("reply_type", "Opted out")
                        .or("assets_sent.is.null,assets_sent.eq.false").select("id").maybeSingle();
                      if (claimError) throw claimError;
                      if (claim) {
                        let assetWaId;
                        try {
                          let assetUrl = matchedKit.asset_url;
                          if (assetUrl?.startsWith("storage:")) {
                            const path = assetUrl.slice("storage:".length);
                            if (!path.startsWith(`${userId}/`)) throw new Error("Invalid brochure file ownership.");
                            const { data, error } = await sb.storage.from(ASSET_BUCKET).createSignedUrl(path, 3600);
                            if (error) throw error;
                            assetUrl = data.signedUrl;
                          }
                          if (matchedKit.asset_url) {
                            try {
                              assetWaId = await sendMetaWhatsApp({
                                user,
                                toPhone: fromPhone,
                                text: matchedKit.message_text || `AppX ${matchedKit.category_name} Brochure`,
                                mode: "media",
                                mediaUrl: assetUrl,
                                mediaType: matchedKit.asset_type || "document",
                              });
                            } catch (e) {
                              // Fallback to sending link as text if media fetch fails
                              assetWaId = await sendMetaWhatsApp({
                                user,
                                toPhone: fromPhone,
                                text: `${matchedKit.message_text || ""}\n${assetUrl}`.trim(),
                                mode: "reply",
                              });
                            }
                          } else if (matchedKit.message_text) {
                            assetWaId = await sendMetaWhatsApp({ user, toPhone: fromPhone, text: matchedKit.message_text, mode: "reply" });
                          }
                          if (!assetWaId) throw new Error("Meta did not accept the brochure send.");
                          const assetBody = `[AI Sent ${matchedKit.category_name} Kit] ${matchedKit.message_text || (matchedKit.asset_url?.startsWith("storage:") ? "Uploaded brochure" : matchedKit.asset_url)}`;
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
                          if (!["demo_requested", "demo_booked"].includes(lead.ai_stage)) leadUpdates.ai_stage = "awaiting_demo_time";
                        } catch (error) {
                          if (!assetWaId) {
                            const { error: releaseError } = await sb.from("leads").update({ assets_sent: false })
                              .eq("user_id", userId).eq("id", lead.id);
                            if (releaseError) console.error("Brochure claim release failed:", releaseError.code);
                          }
                          throw error;
                        }
                      }
                    }
                  }

                  // Notify the owner and keep proposed slots separate from confirmed bookings.
                  if ((reschedule || aiOut.demo_requested || aiOut.demo_booked) && !["Demo Done", "Sold"].includes(lead.status)) {
                    const slotText = aiOut.demo_booked ? aiOut.demo_time_text : "Awaiting preferred date and time";
                    const category = aiOut.detected_category || lead.detected_category || "General";
                    const requestNote = `Demo requested: ${slotText} (${category})`;
                    if (lead.reply_type !== "Opted out" && !String(lead.notes || "").split(" | ").includes(requestNote)) {
                      leadUpdates.status = "Demo Requested";
                      leadUpdates.ai_stage = "demo_requested";
                      const alertMsg = `AppX demo request: ${lead.name} (+${fromPhone})
Proposed slot: ${slotText}
Check availability, send the Google Meet/video link and confirm the slot with the lead. Then mark Demo Booked in AppX.`;
                      const accepted = await sendOwnerAlert({ user, message: alertMsg });
                      leadUpdates.notes = [lead.notes, requestNote, accepted ? "" : "Owner alert unavailable. Check the demo request in AppX."].filter(Boolean).join(" | ");
                    }
                  }

                  await sb.from("leads").update(leadUpdates).eq("id", lead.id).eq("user_id", userId);
                }
              } catch (aiErr) {
                // Never fail webhook acknowledgement if AI errors
                console.error("AI agent error:", waId, aiErr.message);
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
