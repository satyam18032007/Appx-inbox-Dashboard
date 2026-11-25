const { getSupabase, requireUser } = require("./_lib");

async function resolveWabaId(user) {
  const version = user.graph_version || "v21.0";
  let wabaId = String(user.waba_id || "").trim();
  if (!wabaId && user.whatsapp_token) {
    try {
      const dbgResp = await fetch(
        `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(user.whatsapp_token)}&access_token=${encodeURIComponent(user.whatsapp_token)}`
      );
      const dbg = await dbgResp.json();
      const scopes = dbg?.data?.granular_scopes || [];
      const wabaScope = scopes.find((s) => s.scope === "whatsapp_business_messaging" || s.scope === "whatsapp_business_management");
      if (wabaScope?.target_ids?.length) {
        wabaId = wabaScope.target_ids[0];
        const sb = getSupabase();
        await sb.from("users").update({ waba_id: wabaId }).eq("id", user.id);
      }
    } catch (e) {}
  }
  return wabaId;
}

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res, "templates");
    if (!user) return;
    if (!user.whatsapp_token) {
      return res.status(400).json({ error: "Connect Meta WhatsApp Cloud API first." });
    }

    const version = user.graph_version || "v21.0";
    const wabaId = await resolveWabaId(user);
    if (!wabaId) {
      return res.status(400).json({
        error: "WABA ID required. Save your WABA ID (e.g. 1527892642504824) in 'WhatsApp Cloud API' settings.",
      });
    }

    // GET: Fetch all live Meta templates + approval statuses
    if (req.method === "GET") {
      const url = `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,category,language,components&limit=100`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${user.whatsapp_token}` } });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(400).json({ error: data?.error?.message || "Failed to fetch Meta templates" });
      }
      const templates = (data.data || []).map((t) => {
        const bodyComp = (t.components || []).find((c) => c.type === "BODY");
        const bodyText = bodyComp?.text || "";
        const uniqueVars = [...new Set(bodyText.match(/\{\{\d+\}\}/g) || [])].length;
        return {
          name: t.name,
          status: t.status,
          category: t.category,
          language: t.language,
          body: bodyText,
          var_count: uniqueVars,
        };
      });
      return res.status(200).json({ waba_id: wabaId, templates });
    }

    // POST: Create & Submit a NEW Meta Template directly from AppX Inbox!
    if (req.method === "POST") {
      const {
        name = "",
        category = "MARKETING",
        language = "en",
        body_text = "",
        sample_values = "",
        quick_replies = "",
      } = req.body || {};

      const cleanName = String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const cleanBody = String(body_text).trim();

      if (!cleanName || !cleanBody) {
        return res.status(400).json({ error: "Template name and message body are required." });
      }

      const bodyComponent = { type: "BODY", text: cleanBody };
      const varMatches = [...new Set(cleanBody.match(/\{\{\d+\}\}/g) || [])];
      if (varMatches.length > 0) {
        const samples = String(sample_values || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        while (samples.length < varMatches.length) {
          samples.push(`Sample${samples.length + 1}`);
        }
        bodyComponent.example = { body_text: [samples.slice(0, varMatches.length)] };
      }

      const components = [bodyComponent];
      const qrList = String(quick_replies || "")
        .split(",")
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (qrList.length > 0) {
        components.push({
          type: "BUTTONS",
          buttons: qrList.map((text) => ({ type: "QUICK_REPLY", text: text.slice(0, 25) })),
        });
      }

      const payload = {
        name: cleanName,
        category: ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(String(category).toUpperCase())
          ? String(category).toUpperCase()
          : "MARKETING",
        language: String(language || "en").trim(),
        components,
      };

      const url = `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.whatsapp_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(400).json({ error: data?.error?.error_user_msg || data?.error?.message || "Meta rejected template submission" });
      }

      return res.status(201).json({
        submitted: true,
        id: data.id,
        name: cleanName,
        status: data.status || "PENDING",
        category: data.category || payload.category,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Template operation failed" });
  }
};
