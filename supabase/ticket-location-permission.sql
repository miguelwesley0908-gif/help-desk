-- The ticket form sends the optional location column with every insert.
-- Run once in the Supabase SQL Editor for existing projects.
grant insert (title, description, category, priority, office_id, location, requester_id)
on public.tickets to authenticated;
