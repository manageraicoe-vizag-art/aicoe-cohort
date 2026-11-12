# AI Builders Cohort: registration and admin

The website students reach from the poster QR code, and the admin pages RTIH and the colleges use to
confirm payments, form teams and send API keys. The website is hosted free on GitHub Pages; everything
that needs a server (database, sign-in, files, emails) runs on Supabase.

```
web/                     the website (GitHub Pages)
  index.html             landing page the QR opens
  register.html          registration (3 steps)
  pay.html               payment page, opened by each student's personal link
  admin.html             staff sign-in and admin
  js/config.js           the only file to edit: Supabase address, public key, robot-check key
supabase/
  migrations/            database tables and access rules (run once)
  functions/             server functions: register, payment, staff, reminders
  tests/                 database access-rule tests (plain Postgres)
.github/workflows/       automatic deploys of the website and the functions
```

## How it works

| Step | Who | What happens | Email |
| --- | --- | --- | --- |
| 1 | Student | Scans the QR, reads the landing page, registers | "Registration received", with their personal payment link |
| 2 | Student | Is taken to the payment page: their college's UPI, QR, bank or cash options. Enters the last 6 digits of the UTR and a screenshot | "Registration complete" |
| 3 | College coordinator or RTIH admin | Opens the student in the admin, views the proof, confirms or rejects with a reason | "Place confirmed" or "We could not confirm your payment" with a link to fix it |
| 4 | Daily job | Students who registered but haven't paid, 2 days before the deadline | Reminder |
| 5 | RTIH admin | Per college: generate teams (mixed by skill, friends apart, GitHub-ready key holder, automatic team names), adjust, save, publish | "You're in Team Godavari": teammates, roles, how to start |
| 6 | RTIH admin | Pastes each team's OpenAI key (stored encrypted), sends keys | Key email to the team's Infra and testing person only |

Colleges whose students don't pay skip step 2: the coordinator simply confirms each place.

Student statuses: **Not paid yet** → **To check** → **Confirmed** (or **Rejected**, and back to To check after they fix it) → in a team. Staff can also **withdraw** a student.

Who can do what:

| | RTIH admin | College coordinator |
| --- | --- | --- |
| See students | All colleges | Own college only |
| Confirm or reject payments, withdraw, resend emails | Yes | Own college only |
| Teams, keys, colleges, staff, settings | Yes | No |

## One-time setup (about an hour)

### 1. Supabase project
1. Create a project at supabase.com (region: Mumbai).
2. **SQL editor**: paste and run `supabase/migrations/20261112000000_cohort.sql`.
3. Still in the SQL editor, add yourself as the first admin:
   ```sql
   insert into staff (email, name, role) values ('you@rtih.co.in', 'Your Name', 'admin');
   ```
4. **Authentication > URL configuration**: set Site URL to your website address (e.g. `https://cohort.rtih.co.in`) and add `https://cohort.rtih.co.in/admin.html` to the redirect URLs.
5. **Authentication > Emails**: set up custom SMTP (the same email service as below). Supabase's built-in sender is limited to a few emails an hour, which is not enough for sign-in links.
6. **Settings > API**: copy the Project URL and the `anon` public key into `web/js/config.js`.

### 2. Email service (Resend)
1. Create an account at resend.com, add the domain `rtih.co.in` (or a subdomain such as `mail.rtih.co.in`) and ask your IT team to add the DNS records it shows. Mail sent without them lands in spam.
2. Create an API key.
3. Free plan limits are about 100 emails a day; take the smallest paid plan for registration week and team-announcement day.

### 3. Robot check (Cloudflare Turnstile, free)
Create a Turnstile widget for your website's domain. Put the **site key** in `web/js/config.js` and keep the **secret key** for the next step.

### 4. Server functions
Install the Supabase CLI, then from this folder:
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set RESEND_API_KEY=re_xxx MAIL_FROM="RTIH AI CoE <no-reply@rtih.co.in>" \
  MAIL_REPLY_TO=head.aicoe-vizag@rtih.co.in TURNSTILE_SECRET=0x_xxx CRON_SECRET=$(openssl rand -hex 24) \
  SITE_URL=https://cohort.rtih.co.in ALLOWED_ORIGINS=https://cohort.rtih.co.in
supabase functions deploy
```
If you skip Turnstile while testing, also set `ALLOW_NO_CAPTCHA=1`; without either, registration is refused. Remove it before going live.

After this, pushes to `main` that change `supabase/functions` redeploy them automatically (add repo secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`).

### 5. Daily reminder job
In the SQL editor (enable the `pg_cron` and `pg_net` extensions first, under Database > Extensions):
```sql
select cron.schedule('payment-reminders', '30 3 * * *', $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'THE_CRON_SECRET_YOU_SET'),
    body := '{}'::jsonb)
$$);
```
`30 3 * * *` is 9:00 am IST.

### 6. Website on GitHub Pages
1. Push this folder to a GitHub repository.
2. Repo **Settings > Pages > Source: GitHub Actions**. Every push to `main` that changes `web/` redeploys the site.
3. Optional custom domain: in Settings > Pages add `cohort.rtih.co.in`, and ask IT for a CNAME record pointing to `<your-org>.github.io`.
4. Make the registration QR from the landing page address with the toolkit: `python3 make_qr.py https://cohort.rtih.co.in --out registration_qr`.

### 7. In the admin
Sign in at `/admin.html` with your email, then:
1. **Colleges**: add each college: who pays, official UPI ID, bank-issued QR link if any, bank details, cash counter.
2. **Staff**: add each college's coordinator (their email and college). They sign in the same way.
3. **Settings**: deadline, website address, session line and links. Tick "Registration is open".
4. Register yourself as a test student for each college, pay ₹1 or use a test reference, confirm it in the admin, then withdraw the test student.

## Running the cohort
- **During registration**: coordinators work through **Students > To check** daily. The Overview shows, per college, how much was collected and how much OpenAI credit to buy.
- **After registration closes**: untick "Registration is open". Each college buys credit in its own OpenAI organisation and invites RTIH. Per college: **Teams and keys > Generate teams**, review warnings, move people if needed, **Save draft**, **Publish and email teams**. Then create one OpenAI project per team (hard limit on), paste the keys, **Email keys to key holders**.
- **After the cohort**: **Delete this college's keys** (and revoke them in OpenAI). Delete the payment screenshots once payments are settled (the registration page promises this): Supabase dashboard > Storage > `payment-proofs`, select the college folder, Delete. Deleting rows from `storage.objects` with SQL would leave the files behind.

## Testing the database rules
`supabase/tests/` runs the migration on plain Postgres with stand-ins for Supabase's own schemas and checks that the public key can't read students, a coordinator only sees their own college, the payment token is hidden from staff, and keys can only be read by the server.

## Before going live
- The site loads two libraries from CDNs (supabase-js from jsdelivr, a QR library from cdnjs) at pinned versions. For extra safety, download both into the repo and point the pages at the local copies.
- Seat limits are checked just before saving, so two students registering in the same second could take one seat more than the limit.

## Not built yet
- Certificate generation and the `/verify` page that certificate QR codes open (the toolkit's `certificates.py` can be pointed at the exported list in the meantime).
- Weekly progress from GitHub and the top-25% shortlist (the toolkit's `contribution_report.py` works on the exported team list).
- Automatic OpenAI project and key creation: keys are created by hand and pasted in.
