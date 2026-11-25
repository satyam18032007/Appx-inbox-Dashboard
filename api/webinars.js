const crypto = require("crypto");
const { getSupabase, requireUser, normalizePhone } = require("./_lib");

module.exports = async (req, res) => {
  try {
    const sb = getSupabase();

    // Public endpoint: load webinar details for registration/live room page
    if (req.method === "GET" && req.query.public_id) {
      const { data: webinar, error } = await sb
        .from("webinars")
        .select("id, title, host_name, description, scheduled_at, room_slug, cta_text, cta_url, status")
        .eq("id", req.query.public_id)
        .maybeSingle();
      if (error || !webinar) return res.status(404).json({ error: "Webinar not found." });

      const { count } = await sb
        .from("webinar_registrations")
        .select("id", { count: "exact", head: true })
        .eq("webinar_id", webinar.id);
      return res.status(200).json({ webinar: { ...webinar, registration_count: count || 0 } });
    }

    // Public endpoint: register attendee for a webinar & auto-sync to host's CRM Leads
    if (req.method === "POST" && req.query.action === "register") {
      const { webinar_id = "", name = "", phone = "", email = "" } = req.body || {};
      const normPhone = normalizePhone(phone);
      if (!webinar_id || !String(name).trim() || !normPhone) {
        return res.status(400).json({ error: "Name and valid WhatsApp phone are required." });
      }

      const { data: webinar, error } = await sb.rpc("register_webinar_attendee", {
        p_webinar_id: webinar_id,
        p_name: String(name).trim(),
        p_phone: normPhone,
        p_email: String(email).trim(),
      }).maybeSingle();
      if (error) {
        if (error.code === "22P02") return res.status(400).json({ error: "Invalid webinar ID." });
        throw error;
      }
      if (!webinar) return res.status(404).json({ error: "Webinar not found." });

      return res.status(200).json({
        registered: true,
        room_slug: webinar.room_slug,
        webinar_title: webinar.title,
      });
    }

    // Authenticated host routes below
    const user = await requireUser(req, res, "webinars");
    if (!user) return;

    if (req.method === "GET") {
      const { data: webinars = [], error } = await sb
        .from("webinars")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const { data: regs = [] } = await sb
        .from("webinar_registrations")
        .select("webinar_id, name, phone, email, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      const enriched = webinars.map((w) => {
        const list = regs.filter((r) => r.webinar_id === w.id);
        return { ...w, registration_count: list.length, registrations: list };
      });
      return res.status(200).json({ webinars: enriched });
    }

    if (req.method === "POST") {
      const { title = "", host_name = "", description = "", scheduled_at = "", cta_text = "Book Free AppX Demo", cta_url = "" } = req.body || {};
      if (!String(title).trim() || !String(scheduled_at).trim()) {
        return res.status(400).json({ error: "Webinar title and date/time are required." });
      }
      const slug = `AppXWebinar-${crypto.randomBytes(4).toString("hex")}`;
      const { data: created, error } = await sb
        .from("webinars")
        .insert({
          user_id: user.id,
          title: String(title).trim(),
          host_name: String(host_name).trim() || user.name,
          description: String(description).trim(),
          scheduled_at: String(scheduled_at).trim(),
          room_slug: slug,
          cta_text: String(cta_text).trim() || "Book Free AppX Demo",
          cta_url: String(cta_url).trim(),
          status: "Scheduled",
        })
        .select("*")
        .single();
      if (error) throw error;
      return res.status(201).json({ webinar: created });
    }

    if (req.method === "DELETE") {
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ error: "Webinar id required." });
      const { error } = await sb.from("webinars").delete().eq("id", id).eq("user_id", user.id);
      if (error) throw error;
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
};
