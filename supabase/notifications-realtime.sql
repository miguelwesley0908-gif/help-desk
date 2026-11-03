-- Enable Postgres Changes delivery for the notifications table.
-- Safe to run more than once. If this project does not have the standard
-- Supabase publication, configure Realtime for this table in the Dashboard.
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise notice 'Publication supabase_realtime is missing; enable public.notifications in the Supabase Dashboard.';
    return;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end
$$;
