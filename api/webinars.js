const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { getSupabase, requireUser, normalizePhone } = require("./_lib");

function attendanceSignature(ticket) {
  return crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY)
    .update("appx-webinar-attendance:" + ticket).digest("hex");
}

function issueAttendanceTicket(webinarId, phone) {
  const ticket = Buffer.from(JSON.stringify({ webinarId, phone, expires: Date.now() + 86400000 })).toString("base64url");
  return ticket + "." + attendanceSignature(ticket);
}

function readAttendanceTicket(value) {
  if (typeof value !== "string" || value.length > 500 || !/^[a-zA-Z0-9_-]+\.[a-f0-9]{64}$/.test(value)) return null;
  const [ticket, signature] = value.split(".");
  if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(attendanceSignature(ticket), "hex"))) return null;
  const data = JSON.parse(Buffer.from(ticket, "base64url").toString("utf8"));
  return data.expires > Date.now() ? data : null;
}

async function listRegistrations(sb, ownerId, webinarId) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    let query = sb.from("webinar_registrations").select("webinar_id,name,phone,email,created_at,attended")
      .eq("user_id", ownerId);
    if (webinarId) query = query.eq("webinar_id", webinarId);
    const { data, error } = await query.order("id", { ascending: false }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

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
        attendee_suffix: normPhone.slice(-4),
        attendance_ticket: issueAttendanceTicket(webinar_id, normPhone),
        room_slug: webinar.room_slug,
        webinar_title: webinar.title,
      });
    }

    if (req.method === "POST" && req.query.action === "attend") {
      const attendance = readAttendanceTicket(req.body?.ticket);
      if (!attendance) return res.status(403).json({ error: "Invalid or expired attendance ticket." });
      const { error } = await sb.from("webinar_registrations").update({ attended: true })
        .eq("webinar_id", attendance.webinarId).eq("phone", attendance.phone).or("attended.is.null,attended.eq.false");
      if (error) throw error;
      return res.status(200).json({ recorded: true });
    }

    // Authenticated host routes below
    const user = await requireUser(req, res, "webinars");
    if (!user) return;

    if (req.method === "GET" && req.query.action === "export") {
      const { data: webinar, error } = await sb.from("webinars").select("id,title,scheduled_at")
        .eq("id", req.query.id).eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!webinar) return res.status(404).json({ error: "Webinar not found." });
      const registrations = await listRegistrations(sb, user.id, webinar.id);
      const book = new ExcelJS.Workbook();
      const summary = book.addWorksheet("Summary");
      summary.addRows([["Webinar", webinar.title], ["Scheduled", webinar.scheduled_at],
        ["Registered", registrations.length], ["Joined", registrations.filter(row => row.attended).length]]);
      summary.columns = [{ width: 18 }, { width: 50 }];
      const list = book.addWorksheet("Attendees");
      list.columns = [{ header: "Name", width: 28 }, { header: "Phone", width: 20 },
        { header: "Email", width: 36 }, { header: "Registered (UTC)", width: 28 }, { header: "Join status", width: 24 }];
      list.getRow(1).font = { bold: true };
      for (const row of registrations) {
        list.addRow([row.name, row.phone, row.email || "", row.created_at, row.attended ? "Joined" : "Join not recorded"]);
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="appx_webinar_attendance.xlsx"');
      return res.status(200).send(Buffer.from(await book.xlsx.writeBuffer()));
    }

    if (req.method === "GET") {
      const { data: webinars = [], error } = await sb
        .from("webinars")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const regs = await listRegistrations(sb, user.id);

      const enriched = webinars.map((w) => {
        const list = regs.filter((r) => r.webinar_id === w.id);
        return { ...w, registration_count: list.length, joined_count: list.filter(row => row.attended).length, registrations: list };
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
