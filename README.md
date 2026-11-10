# Group Trip Planner

A shared planner for a group trip (built for about 10 people), hosted free on GitHub Pages:
**https://itsmenyla.github.io/group-trip-planner/**

- **Itinerary:** activities by day, which only the **planning team** can add, edit or delete.
- **Suggestions:** everyone can suggest places, food spots or activities, mark interest in other people's ideas, and remove their own suggestions. Planners can remove any suggestion, and can move one into the itinerary with **Add to itinerary**.
- **Who's going:** everyone marks each activity Going, Maybe or Not going, with an optional note. A grid shows headcounts and who hasn't replied.
- **People:** who is on the trip, their roles, and the invite codes (planners only).

The page is plain HTML, CSS and JavaScript. The data lives in a free [Supabase](https://supabase.com) database. The database enforces who can change what (`supabase/schema.sql`), so the rules can't be bypassed from the browser.

## How people join

1. Open the site and enter your email. You'll get a sign-in link; open it on the same device.
2. Enter your name and the **invite code** a planner gave you:
   - the **planner code** makes you part of the planning team;
   - the **member code** makes you a suggester.

Planners can see both codes on the **People** tab, and can change roles or remove people there.

## One-time setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (the free plan is enough). Pick a region near the group.
2. **Create the tables and access rules:** in the project dashboard, open **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. **Get your invite codes:** in the SQL Editor, run `select * from public.trip_codes;`. Keep the planner code for yourself and the other planners.
4. **Allow sign-in links back to the site:** go to **Authentication → URL Configuration**:
   - set **Site URL** to `https://itsmenyla.github.io/group-trip-planner/`;
   - add the same address under **Redirect URLs**.
5. **Connect the site:** go to **Project Settings → API** (or **API Keys**), copy the **Project URL** and the **anon public** key (or **publishable** key), and paste them into [`js/config.js`](js/config.js). Commit and push; GitHub Pages updates within a minute.
   These two values are designed to be public. Never put the `service_role` / secret key in this repo.
6. Open the site, sign in, and join with the planner code. Then share the link and the member code with everyone else.

### Email limits

Supabase's built-in email service only sends a few sign-in emails per hour for the whole project. Each person normally signs in once per device and stays signed in, so this is usually fine for 10 people. If people get "too many sign-in emails", wait an hour or set up your own email provider under **Authentication → Emails → SMTP Settings** (for example, Resend's free tier).

## Changing the invite codes

To change a code (for example, if it was shared too widely), run this in the SQL Editor:

```sql
update public.trip_codes set code = 'your-new-code' where role = 'member';
```

People who already joined keep their access.

## Running it locally

Any static file server works, for example:

```bash
npx serve .
```

Then add `http://localhost:3000` to the Supabase **Redirect URLs** so sign-in links work locally.
