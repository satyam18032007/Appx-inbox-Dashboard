const ExcelJS = require("exceljs");
const { getSupabase, requireUser, getCampaignDateLeads } = require("./_lib");

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    const user = await requireUser(req, res, "export");
    if (!user) return;
    const sb = getSupabase();

    const sentDate = req.query.sent_date;
    let leads;
    if (sentDate !== undefined) {
      const results = await getCampaignDateLeads(sb, user.id, sentDate);
      if (!results) return res.status(400).json({ error: "Choose a valid campaign send date." });
      leads = results.leads;
    } else {
      const { data, error } = await sb
        .from("leads")
        .select("*")
        .eq("user_id", user.id)
        .order("has_responded", { ascending: false })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      leads = data || [];
    }

    const leadRows = leads.map((l) => ({
      ID: l.id,
      Name: l.name,
      "WhatsApp Phone": `+${l.phone}`,
      "Business / Academy": l.business_name || "",
      Campaign: l.campaign_name || "",
      ...(sentDate ? { "Campaign Send Date (IST)": sentDate } : {}),
      "Responded?": l.has_responded ? "Yes" : "No",
      "Reply Category": l.reply_type || "",
      "Sales Status": l.status || "",
      "Demo Date": l.demo_date || "",
      "Follow-up Date": l.followup_date || "",
      "Deal Value (INR)": Number(l.deal_value || 0),
      "Last Message": l.last_message || "",
      Notes: l.notes || "",
      "Updated At": l.updated_at || "",
    }));

    const total = leads.length;
    const responded = leads.filter((l) => l.has_responded).length;
    const sold = leads.filter((l) => l.status === "Sold").length;
    const revenue = leads.filter((l) => l.status === "Sold").reduce((s, l) => s + Number(l.deal_value || 0), 0);

    const summaryRows = [
      { Metric: "Total Campaign Leads", Value: total },
      { Metric: "Responded", Value: responded },
      { Metric: "No Response", Value: total - responded },
      { Metric: "Demo Requested", Value: leads.filter((l) => l.status === "Demo Requested").length },
      { Metric: "Demo Booked", Value: leads.filter((l) => l.status === "Demo Booked").length },
      { Metric: "Demo Done", Value: leads.filter((l) => l.status === "Demo Done").length },
      { Metric: "Follow-up Due", Value: leads.filter((l) => l.status === "Follow-up Due").length },
      { Metric: "App Sold", Value: sold },
      { Metric: "Total Revenue (INR)", Value: revenue },
    ];

    const wb = new ExcelJS.Workbook();
    for (const [title, rows] of [["Leads Tracker", leadRows.length ? leadRows : [{ Name: "No leads yet" }]], ["Dashboard Summary", summaryRows]]) {
      const sheet = wb.addWorksheet(title);
      const headers = Object.keys(rows[0]);
      sheet.addRow(headers).font = { bold: true };
      for (const row of rows) sheet.addRow(headers.map(header => row[header]));
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="appx_leads${sentDate ? "_" + sentDate : ""}.xlsx"`);
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Export failed" });
  }
};
