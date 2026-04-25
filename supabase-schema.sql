-- ══════════════════════════════════════════════════════════
--  LINE Shop — Supabase SQL Schema
--  รัน SQL นี้ใน Supabase → SQL Editor → New Query → Run
-- ══════════════════════════════════════════════════════════

-- ── ตาราง orders ──────────────────────────────────────────
create table if not exists orders (
  id           bigserial    primary key,
  order_id     text         not null unique,
  user_id      text         not null,
  customer_name text        not null,
  items        jsonb        not null,   -- array of { name, emoji, price, qty }
  total        numeric      not null,
  status       text         not null default 'pending',
  -- 'pending' | 'sent' | 'confirmed' | 'shipped' | 'done' | 'cancelled' | 'failed'
  created_at   timestamptz  not null default now()
);

-- ── ตาราง line_users ──────────────────────────────────────
create table if not exists line_users (
  id           bigserial    primary key,
  user_id      text         not null unique,
  display_name text,
  last_seen    timestamptz  not null default now(),
  created_at   timestamptz  not null default now()
);

-- ── Index ─────────────────────────────────────────────────
create index if not exists idx_orders_user_id    on orders(user_id);
create index if not exists idx_orders_created_at on orders(created_at desc);
create index if not exists idx_orders_status     on orders(status);

-- ── Row Level Security (RLS) ──────────────────────────────
-- เปิด RLS แล้วให้ service_role (backend) เข้าถึงได้เต็ม
alter table orders    enable row level security;
alter table line_users enable row level security;

-- Policy: service_role เข้าถึงได้ทุก operation
create policy "service_role full access on orders"
  on orders for all
  using (true)
  with check (true);

create policy "service_role full access on line_users"
  on line_users for all
  using (true)
  with check (true);
