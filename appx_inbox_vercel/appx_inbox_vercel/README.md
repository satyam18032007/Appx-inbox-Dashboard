# AppX Inbox (Vercel + Supabase + Meta WhatsApp Cloud API)

100% real, multi-user **WhatsApp Marketing & Lead CRM** with **zero static/fake data** — built specifically for **Vercel** hosting so you can share one live URL with anyone.

## What You Need (All Free Tier)
No MCP is required. You only need **2 free connections**:
1. **Supabase** (Free PostgreSQL database — stores every user's leads, chats, and credentials)
2. **Meta WhatsApp Cloud API** (Official WhatsApp API — each user connects their own number inside the app!)

---

## Step 1: Setup Supabase Database (2 Minutes, One-Time)
1. Go to **https://supabase.com** → **Start your project** → Create a free project.
2. In the left sidebar, click **SQL Editor** → **New query**.
3. Open `supabase_schema.sql` from this zip, copy-paste everything into the SQL Editor, and click **Run**.
4. Go to **Project Settings → API** and copy:
   - **Project URL** (`SUPABASE_URL`)
   - **service_role secret key** (`SUPABASE_SERVICE_ROLE_KEY`)

---

## Step 2: Deploy to Vercel (2 Minutes, One-Time)
1. Upload this folder (`appx_inbox_vercel`) to a new GitHub repository.
2. Go to **https://vercel.com** → **Add New → Project** → Import your GitHub repo.
3. Under **Environment Variables**, add the 2 keys from Step 1:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Click **Deploy**. You will get a live link like `https://appx-inbox.vercel.app`.

---

## Step 3: How YOU or ANY Other User Sets Up Their WhatsApp (Inside the App — 2 Minutes)
Share your Vercel link with anyone! They just do this:
1. Open the Vercel link → Click **Create Account** (Sign Up with email & password).
2. The app automatically opens the **3-Step WhatsApp Setup** popup showing their **personal Webhook URL** (`https://your-app.vercel.app/webhook/<their-user-id>`) and **Verify Token**.
3. In **https://developers.facebook.com** → Your App → **WhatsApp → Configuration → Webhook → Edit**:
   - Paste the **Webhook URL** and **Verify Token** → Click **Verify and Save** → Subscribe to **`messages`**.
4. In Meta → **WhatsApp → API Setup**, copy **Access Token** + **Phone Number ID** → paste inside the app → click **Save & Verify Connection**.

Done! Now:
- Incoming WhatsApp replies auto-appear in **Inbox** (auto-tagged `Interested`, `Free text`, `Not interested`, `Opted out`).
- Unreplied bulk CSV contacts stay in **No response** until they reply.
- Replies sent from the app go straight to the customer's WhatsApp.
- **Dashboard** tracks Demos Booked/Done, Follow-ups, and App Sold, and **Download Excel (.xlsx)** exports a real formatted workbook anytime.
