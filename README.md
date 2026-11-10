# Group Trip Planner

A shared planner for a group trip (built for about 10 people), hosted free on GitHub Pages:
**https://itsmenyla.github.io/group-trip-planner/**

There's no setup and nobody needs an account. Open the link and start.

- **Itinerary:** activities by day, which only the **planning team** can add, edit or delete.
- **Suggestions:** everyone can suggest places, food spots or activities, mark interest in other people's ideas, and remove their own suggestions. Planners can remove any suggestion, and can move one into the itinerary with **Add to itinerary**.
- **Who's going:** everyone marks each activity Going, Maybe or Not going, with an optional note. A grid shows headcounts and who hasn't replied.
- **People:** everyone who has joined. Planners can remove people, change the passcode, and download or restore backups here.

## How it works

1. **The first person to open the site starts the trip.** They enter the trip name, their name and a **planner passcode**, and they're on the planning team.
2. **Share the link with everyone.** On their first visit, people pick or type their name. Planners also enter the passcode. Each device remembers who it is; use **Switch person** to change.
3. Planners on another device enter the passcode when they pick their name, or later under **People → I'm on the planning team**.

Open pages check for other people's changes every 10 seconds.

## Things to know

This version trades security for zero setup:

- **The data is public to anyone who finds the storage address.** The trip is one JSON document on [textdb.dev](https://textdb.dev), a free service that needs no account. Its address is in [`js/config.js`](js/config.js), and this repository is public. **Don't store anything private,** such as passport numbers, phone numbers or home addresses.
- **Roles are honor-system.** The planner passcode decides which buttons the page shows. Someone technical could change the data directly, and anyone can choose any name.
- **The storage is a free hobby service with no guarantees.** Planners should use **Download backup** on the People tab after big changes. **Restore from backup** puts a saved copy back.
- **Changes are last-write-wins.** Each change re-reads the latest data before saving, so collisions are rare. But if two people save at exactly the same moment, one change can be lost.

If you later want real privacy and enforced permissions, the planner can be moved to a database with logins (for example, Supabase).

## Starting a separate trip

Replace the id at the end of `storeUrl` in [`js/config.js`](js/config.js) with a new random one (for example, from https://www.uuidgenerator.net/), then commit and push. The next visitor starts a fresh trip.

## Running it locally

Any static file server works, for example:

```bash
npx serve .
```
