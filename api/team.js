const crypto = require("crypto");
const { getSupabase, requireUser } = require("./_lib");

const roles = ["operator", "viewer"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const sb = getSupabase();
    const table = () => sb.from("team_access");
    const body = req.body || {};

    if (req.method === "GET") {
      const [owned, joined] = await Promise.all([
        table().select("id,email,role,member_id,expires_at").eq("owner_id", user.id),
        table().select("owner_id,role,owner:users!team_access_owner_id_fkey(name)").eq("member_id", user.id),
      ]);
      if (owned.error || joined.error) throw owned.error || joined.error;
      return res.status(200).json({ members: owned.data, workspaces: joined.data });
    }

    if (req.method === "POST" && req.query.action === "accept") {
      const code = String(body.code || "");
      if (!/^[a-f0-9]{64}$/.test(code)) return res.status(400).json({ error: "Invalid invite." });
      const { data, error } = await table().update({ member_id: user.id, invite_hash: null, expires_at: null })
        .eq("invite_hash", hash(code)).eq("email", user.email.toLowerCase()).is("member_id", null)
        .gt("expires_at", new Date().toISOString()).select("owner_id").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Invite expired, already used, or issued to a different email." });
      return res.status(200).json({ workspace: data.owner_id });
    }

    if (req.method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === user.email || !roles.includes(body.role)) {
        return res.status(400).json({ error: "Enter a teammate email and valid role." });
      }
      const code = crypto.randomBytes(32).toString("hex");
      const { error } = await table().insert({
        owner_id: user.id, email, role: body.role, invite_hash: hash(code),
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      if (error?.code === "23505") return res.status(409).json({ error: "This email already has an invite or team access. Revoke the old invite to reissue it." });
      if (error) throw error;
      return res.status(201).json({ code });
    }

    if (req.method === "PATCH" || req.method === "DELETE") {
      if (req.method === "PATCH" && !roles.includes(body.role)) return res.status(400).json({ error: "Invalid role." });
      const mutation = req.method === "PATCH" ? table().update({ role: body.role }) : table().delete();
      const { data, error } = await mutation.eq("owner_id", user.id).eq("id", req.query.id)
        .select("id").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Team entry not found." });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("Team request failed", error.code || error.message);
    return res.status(500).json({ error: "Team request failed." });
  }
};
