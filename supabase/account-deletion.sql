-- Preserve historical records while allowing the linked Auth account to be deleted.
-- Run after supabase-schema.sql and, when installed, room-reservations.sql.

alter table public.tickets alter column requester_id drop not null;
alter table public.tickets drop constraint if exists tickets_requester_id_fkey;
alter table public.tickets
  add constraint tickets_requester_id_fkey
  foreign key (requester_id) references public.profiles(id) on delete set null;

alter table public.ticket_comments alter column author_id drop not null;
alter table public.ticket_comments drop constraint if exists ticket_comments_author_id_fkey;
alter table public.ticket_comments
  add constraint ticket_comments_author_id_fkey
  foreign key (author_id) references public.profiles(id) on delete set null;

do $$
begin
  if to_regclass('public.room_bookings') is not null then
    execute 'alter table public.room_bookings alter column organizer_id drop not null';
    execute 'alter table public.room_bookings drop constraint if exists room_bookings_organizer_id_fkey';
    execute 'alter table public.room_bookings
      add constraint room_bookings_organizer_id_fkey
      foreign key (organizer_id) references public.profiles(id) on delete set null';
  end if;
end;
$$;
