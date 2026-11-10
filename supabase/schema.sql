-- Group Trip Planner: database schema and access rules.
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
--
-- Who can do what (enforced by the database, not just the web page):
--   planner : edits trip details and the itinerary, removes any suggestion, manages members
--   member  : views everything, adds suggestions and removes their own, RSVPs, marks interest
-- People join by signing in and entering an invite code. There is one code per role;
-- read them afterwards with:  select * from public.trip_codes;

-- ---------------------------------------------------------------- tables

create table public.members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  role         text not null check (role in ('planner', 'member')),
  joined_at    timestamptz not null default now()
);

-- One row only (id = 1): the trip's name, place and dates.
create table public.trip (
  id          int primary key default 1 check (id = 1),
  name        text not null default 'Our group trip' check (char_length(name) <= 80),
  destination text check (char_length(destination) <= 120),
  start_date  date,
  end_date    date,
  group_size  int check (group_size between 1 and 200),
  updated_at  timestamptz not null default now()
);
insert into public.trip (id) values (1);

-- Invite codes. No access rules are granted on this table, so the web page can never read it;
-- join_trip() checks codes and planner_invite_codes() shows them to planners.
create table public.trip_codes (
  role text primary key check (role in ('planner', 'member')),
  code text not null unique
);
insert into public.trip_codes (role, code) values
  ('planner', 'plan-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  ('member',  'join-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8));

-- Table 1: the itinerary (planners only).
create table public.itinerary (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  day        date,
  start_time time,
  end_time   time,
  location   text check (char_length(location) <= 160),
  link       text check (link is null or link ~* '^https?://' and char_length(link) <= 500),
  notes      text check (char_length(notes) <= 1000),
  created_by uuid default auth.uid() references public.members (user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Table 2: suggestions (everyone adds; authors and planners remove).
create table public.suggestions (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(btrim(title)) between 1 and 120),
  kind        text not null default 'activity' check (kind in ('activity', 'place', 'food', 'stay', 'other')),
  location    text check (char_length(location) <= 160),
  link        text check (link is null or link ~* '^https?://' and char_length(link) <= 500),
  why         text check (char_length(why) <= 600),
  created_by  uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  created_at  timestamptz not null default now(),
  promoted_to uuid references public.itinerary (id) on delete set null
);

-- Who is going to each itinerary activity.
create table public.rsvps (
  item_id    uuid not null references public.itinerary (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  status     text not null check (status in ('going', 'maybe', 'no')),
  note       text check (char_length(note) <= 140),
  updated_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

-- "I'm interested" marks on suggestions.
create table public.suggestion_votes (
  suggestion_id uuid not null references public.suggestions (id) on delete cascade,
  user_id       uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  primary key (suggestion_id, user_id)
);

-- ---------------------------------------------------------------- helpers

create function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid())
$$;

create function public.is_planner() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'planner')
$$;

-- Join the trip with an invite code. A planner code always gives the planner role;
-- re-joining with a member code never demotes a planner.
create function public.join_trip(invite_code text, name text) returns text
  language plpgsql security definer set search_path = public as $$
declare
  new_role text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select role into new_role from public.trip_codes where code = btrim(invite_code);
  if new_role is null then
    raise exception 'That invite code is not valid.';
  end if;
  insert into public.members (user_id, display_name, role)
  values (auth.uid(), btrim(name), new_role)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        role = case when public.members.role = 'planner' then 'planner' else excluded.role end;
  return (select role from public.members where user_id = auth.uid());
end $$;

-- Planners can read the invite codes to pass them on.
create function public.planner_invite_codes() returns table (role text, code text)
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_planner() then
    raise exception 'Only planners can see invite codes.';
  end if;
  return query select c.role, c.code from public.trip_codes c order by c.role;
end $$;

-- Planners can change someone's role, but never leave the trip without a planner.
create function public.set_member_role(target uuid, new_role text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_planner() then
    raise exception 'Only planners can change roles.';
  end if;
  if new_role not in ('planner', 'member') then
    raise exception 'Unknown role.';
  end if;
  if new_role = 'member'
     and (select count(*) from public.members where role = 'planner' and user_id <> target) = 0 then
    raise exception 'The trip needs at least one planner.';
  end if;
  update public.members set role = new_role where user_id = target;
end $$;

-- Lock helper functions down to signed-in users.
revoke execute on function public.is_member(), public.is_planner(), public.join_trip(text, text),
  public.planner_invite_codes(), public.set_member_role(uuid, text) from public, anon;
grant execute on function public.is_member(), public.is_planner(), public.join_trip(text, text),
  public.planner_invite_codes(), public.set_member_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------- access rules

alter table public.members          enable row level security;
alter table public.trip             enable row level security;
alter table public.trip_codes       enable row level security;
alter table public.itinerary        enable row level security;
alter table public.suggestions      enable row level security;
alter table public.rsvps            enable row level security;
alter table public.suggestion_votes enable row level security;

-- Signed-out visitors get nothing at all.
revoke all on public.members, public.trip, public.trip_codes, public.itinerary,
  public.suggestions, public.rsvps, public.suggestion_votes from anon;
revoke all on public.trip_codes from authenticated;

-- members: everyone in the trip sees the list; people may rename themselves; planners remove people.
-- Joining and role changes only happen through join_trip() and set_member_role().
revoke insert, update on public.members from authenticated;
grant update (display_name) on public.members to authenticated;
create policy "members: read"         on public.members for select to authenticated using (public.is_member());
create policy "members: rename self"  on public.members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members: planner removes" on public.members for delete to authenticated
  using (public.is_planner() and user_id <> auth.uid());

-- trip details
create policy "trip: read"          on public.trip for select to authenticated using (public.is_member());
create policy "trip: planner edits" on public.trip for update to authenticated
  using (public.is_planner()) with check (public.is_planner());

-- itinerary
create policy "itinerary: read"           on public.itinerary for select to authenticated using (public.is_member());
create policy "itinerary: planner adds"   on public.itinerary for insert to authenticated with check (public.is_planner());
create policy "itinerary: planner edits"  on public.itinerary for update to authenticated
  using (public.is_planner()) with check (public.is_planner());
create policy "itinerary: planner removes" on public.itinerary for delete to authenticated using (public.is_planner());

-- suggestions
create policy "suggestions: read" on public.suggestions for select to authenticated using (public.is_member());
create policy "suggestions: members add own" on public.suggestions for insert to authenticated
  with check (public.is_member() and created_by = auth.uid() and promoted_to is null);
create policy "suggestions: planner edits" on public.suggestions for update to authenticated
  using (public.is_planner()) with check (public.is_planner());
create policy "suggestions: author or planner removes" on public.suggestions for delete to authenticated
  using (created_by = auth.uid() or public.is_planner());

-- RSVPs: everyone reads; each person writes only their own.
create policy "rsvps: read" on public.rsvps for select to authenticated using (public.is_member());
create policy "rsvps: own insert" on public.rsvps for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
create policy "rsvps: own update" on public.rsvps for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "rsvps: own delete" on public.rsvps for delete to authenticated using (user_id = auth.uid());

-- interest marks on suggestions
create policy "votes: read" on public.suggestion_votes for select to authenticated using (public.is_member());
create policy "votes: own insert" on public.suggestion_votes for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
create policy "votes: own delete" on public.suggestion_votes for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- live updates

-- Lets open pages refresh when someone else changes something (access rules still apply).
alter publication supabase_realtime add table
  public.members, public.trip, public.itinerary, public.suggestions, public.rsvps, public.suggestion_votes;
