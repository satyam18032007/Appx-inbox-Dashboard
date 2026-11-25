const { getSupabase, requireUser, sanitizeUser, verifyMetaCredentials } = require("./_lib");

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method !== "PUT") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { whatsapp_token = "", phone_number_id = "", verify_token = "", graph_version = "v21.0" } = req.body || {};
    const finalToken = String(whatsapp_token).trim() || user.whatsapp_token || "";
    const finalPhoneId = String(phone_number_id).trim();
    const finalVerify = String(verify_token).trim() || user.verify_token;
    const finalVersion = String(graph_version).trim() || "v21.0";

    if (!finalToken || !finalPhoneId) {
      return res.status(400).json({ error: "Both Meta WhatsApp Access Token and Phone Number ID are required." });
    }

    // Verify live against Meta Graph API before saving so user gets instant feedback
    const metaInfo = await verifyMetaCredentials(finalToken, finalPhoneId, finalVersion);

    const sb = getSupabase();
    const { data: updated, error } = await sb
      .from("users")
      .update({
        whatsapp_token: finalToken,
        phone_number_id: finalPhoneId,
        verify_token: finalVerify,
        graph_version: finalVersion,
        connected_phone: metaInfo.display_phone_number || finalPhoneId,
      })
      .eq("id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(200).json({
      status: "connected",
      meta_info: metaInfo,
      user: sanitizeUser(updated),
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Meta verification failed" });
  }
};
