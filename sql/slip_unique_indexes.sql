-- ═══════════════════════════════════════════════════════════════════
--  กันใช้สลิปใบเดียวยืนยันหลายออเดอร์ที่ระดับฐานข้อมูล (ด่านสุดท้าย แม่นยำ 100%)
--  รันใน Supabase → SQL Editor  (ทำครั้งเดียว — รันซ้ำได้ ไม่พัง)
--
--  ⚠️ ก่อนรัน ตรวจว่ายังไม่มีข้อมูลซ้ำอยู่เดิม ไม่งั้นสร้าง index ไม่ได้:
--     select slip_image_hash, count(*) from orders
--       where slip_image_hash is not null group by 1 having count(*) > 1;
--     select slip_ref, count(*) from orders
--       where slip_ref is not null group by 1 having count(*) > 1;
--  ถ้ามีแถวซ้ำ ให้ตรวจ/เคลียร์ (เช่น set slip_image_hash = null ของแถวที่ซ้ำ) แล้วค่อยรัน
-- ═══════════════════════════════════════════════════════════════════

create unique index if not exists orders_slip_image_hash_uq
  on orders (slip_image_hash) where slip_image_hash is not null;

create unique index if not exists orders_slip_ref_uq
  on orders (slip_ref) where slip_ref is not null;
