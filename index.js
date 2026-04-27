require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── LINE ──────────────────────────────────────────────────
const LINE_API = 'https://api.line.me/v2/bot/message';

async function linePush(userId, messages) {
  const res = await fetch(`${LINE_API}/push`, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${process.env.LINE_TOKEN}`
    },
    body: JSON.stringify({ to: userId, messages })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'LINE push failed');
  }
}

async function lineReply(replyToken, messages) {
  await fetch(`${LINE_API}/reply`, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${process.env.LINE_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  }).catch(console.error);
}

// บันทึกข้อความลง messages table (ใช้ในแชท)
async function saveMessage({ order_id, user_id, sender, text }) {
  if (!order_id || !text) return;
  await supabase.from('messages').insert([{
    order_id, user_id, sender, text,
    created_at: new Date().toISOString()
  }]).then(({ error }) => {
    if (error) console.error('saveMessage error:', error.message);
  }).catch(console.error);
}

// หา order_id ล่าสุดของ user นี้ (สำหรับผูกข้อความเข้ากับออเดอร์ล่าสุด)
async function getLatestOrderId(userId) {
  const { data } = await supabase
    .from('orders')
    .select('order_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.order_id || null;
}

// ─── Helpers ──────────────────────────────────────────────
function genOrderId() {
  return 'ORD' + Date.now().toString().slice(-6);
}

function buildOrderMsg(order) {
  const { customer_name, items, total, order_id, created_at } = order;
  const date = new Date(created_at).toLocaleString('th-TH', {
    dateStyle: 'short', timeStyle: 'short'
  });
  let msg = `🛒 ออเดอร์ใหม่! #${order_id}\n`;
  msg += `${'─'.repeat(24)}\n`;
  msg += `👤 ลูกค้า: ${customer_name}\n`;
  msg += `📅 ${date}\n`;
  msg += `${'─'.repeat(24)}\n`;
  items.forEach(i => {
    msg += `${i.emoji || '•'} ${i.name}\n`;
    msg += `   ${i.qty} × ฿${i.price.toLocaleString()} = ฿${(i.qty * i.price).toLocaleString()}\n`;
  });
  msg += `${'─'.repeat(24)}\n`;
  msg += `💰 ยอดรวม: ฿${total.toLocaleString()}\n`;
  msg += `\n📲 กรุณาติดต่อลูกค้ากลับด้วยนะคะ 🙏`;
  return msg;
}

// ─── Routes ───────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'LINE Shop Backend v2',
  supabase: process.env.SUPABASE_URL ? '✅' : '❌',
  lineToken: process.env.LINE_TOKEN  ? '✅' : '❌'
}));

// ── POST /send-order ──────────────────────────────────────
// Body: { userId, customerName, items:[{name,emoji,price,qty}], total }
app.post('/send-order', async (req, res) => {
  const { userId, customerName, items, total } = req.body;

  if (!userId || !customerName || !items?.length || total == null)
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

  const order_id   = genOrderId();
  const created_at = new Date().toISOString();
  const order      = { order_id, user_id: userId, customer_name: customerName,
                       items, total, status: 'pending', created_at };

  // บันทึกลง Supabase
  const { error: dbErr } = await supabase.from('orders').insert([order]);
  if (dbErr) {
    console.error('DB insert error:', dbErr.message);
  }

  // ส่งแจ้งเตือนไปหาเจ้าของร้าน (ADMIN_LINE_UID)
  const adminUid = process.env.ADMIN_LINE_UID;
  if (!adminUid) {
    console.error('❌ ADMIN_LINE_UID ไม่ได้ตั้งค่า');
    return res.status(500).json({ error: 'ADMIN_LINE_UID not configured' });
  }

  try {
    await linePush(adminUid, [{ type: 'text', text: buildOrderMsg(order) }]);
    await supabase.from('orders').update({ status: 'sent' }).eq('order_id', order_id);
    console.log(`✅ ${order_id} → admin`);
    res.json({ success: true, orderId: order_id });
  } catch (e) {
    await supabase.from('orders').update({ status: 'failed' }).eq('order_id', order_id);
    console.error(`❌ ${order_id}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ── POST /notify ──────────────────────────────────────────
// Admin → ส่งข้อความหาลูกค้าทาง LINE (เรียกจาก admin.html)
// Body: { user_id, order_id?, text }
// admin.html จัดการ insert ลง messages table เองอยู่แล้ว
// (ป้องกัน duplicate) endpoint นี้แค่ทำหน้าที่ push LINE อย่างเดียว
// ═══════════════════════════════════════════════════════════
app.post('/notify', async (req, res) => {
  const { user_id, order_id, text } = req.body;
  if (!user_id || !text)
    return res.status(400).json({ error: 'missing user_id or text' });

  try {
    await linePush(user_id, [{
      type: 'text',
      text: String(text).slice(0, 5000)   // LINE limit 5000 chars
    }]);
    console.log(`📤 notify → ${user_id.slice(0,12)}… (order ${order_id || '-'})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('/notify error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /webhook ─────────────────────────────────────────
// LINE Platform → เก็บ userId, บันทึกข้อความลูกค้าลง messages, ตอบกลับ
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const events = req.body?.events || [];
  for (const ev of events) {
    const userId = ev.source?.userId;
    if (!userId) continue;

    // upsert user ลง Supabase
    await supabase.from('line_users').upsert(
      [{ user_id: userId, last_seen: new Date().toISOString() }],
      { onConflict: 'user_id' }
    );

    if (ev.type !== 'message' || ev.message?.type !== 'text') continue;

    const incomingText = ev.message.text;
    const text = incomingText.trim().toLowerCase();

    // ★ บันทึกข้อความลูกค้าลง messages (ผูกกับออเดอร์ล่าสุดของ user)
    //   — ทำให้แอดมินเห็นข้อความในช่องแชทแบบเรียลไทม์
    const latestOrderId = await getLatestOrderId(userId);
    if (latestOrderId) {
      await saveMessage({
        order_id: latestOrderId,
        user_id : userId,
        sender  : 'customer',
        text    : incomingText
      });
    }

    let reply = '';

    if (text.includes('id') || text === 'uid') {
      reply = `📋 LINE User ID ของคุณ:\n\n${userId}\n\nนำ ID นี้ไปใส่ในหน้าเว็บร้านค้าตอนสั่งซื้อค่ะ`;

    } else if (text.includes('ออเดอร์') || text.includes('order')) {
      const { data: myOrders } = await supabase
        .from('orders')
        .select('order_id, total, status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      reply = !myOrders?.length
        ? '📭 ยังไม่มีออเดอร์ในระบบค่ะ'
        : '📋 ออเดอร์ล่าสุดของคุณ:\n\n' +
          myOrders.map(o => {
            const icon = o.status === 'sent' ? '✅' : o.status === 'failed' ? '❌' : '⏳';
            return `${icon} #${o.order_id}\n฿${o.total.toLocaleString()}`;
          }).join('\n\n');

    } else {
      reply = `สวัสดีค่ะ! 👋\nยินดีต้อนรับสู่ร้านของเรา\n\nพิมพ์ว่า:\n• "id" → ดู User ID ของคุณ\n• "ออเดอร์" → ดูสถานะสั่งซื้อ`;
    }

    await lineReply(ev.replyToken, [{ type: 'text', text: reply }]);

    // บันทึก auto-reply ของบอทลง messages ด้วย (sender=system)
    if (latestOrderId) {
      await saveMessage({
        order_id: latestOrderId,
        user_id : userId,
        sender  : 'system',
        text    : reply
      });
    }
  }
});

// ── GET /orders ───────────────────────────────────────────
app.get('/orders', async (req, res) => {
  const limit  = parseInt(req.query.limit)  || 50;
  const offset = parseInt(req.query.offset) || 0;

  const { data, error, count } = await supabase
    .from('orders')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ total: count, orders: data });
});

// ── PATCH /orders/:orderId/status ─────────────────────────
// Admin: อัปเดตสถานะออเดอร์
//   ⚠️ admin.html ตอนนี้อัปเดต Supabase ตรงๆ และส่งข้อความผ่าน /notify เอง
//   จึงไม่ได้เรียก endpoint นี้แล้ว — แต่เก็บไว้เผื่อเรียกจากที่อื่น
//   ใส่ ?silent=1 จะไม่ส่ง LINE auto-message
app.patch('/orders/:orderId/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'sent', 'confirmed', 'shipped', 'done', 'cancelled', 'failed'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status ต้องเป็น: ${allowed.join(', ')}` });

  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('order_id', req.params.orderId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // แจ้งลูกค้าผ่าน LINE (เฉพาะถ้าไม่ได้ใส่ ?silent=1)
  const silent = req.query.silent === '1';
  if (!silent && data?.user_id) {
    const statusTh = {
      confirmed : '✅ ร้านค้ายืนยันออเดอร์แล้ว',
      shipped   : '🚚 สินค้าอยู่ระหว่างจัดส่ง',
      done      : '🎉 จัดส่งเสร็จสมบูรณ์ ขอบคุณค่ะ',
      cancelled : '❌ ออเดอร์ถูกยกเลิก กรุณาติดต่อร้านค้า'
    }[status];
    if (statusTh) {
      const msgText = `📦 อัปเดตออเดอร์ #${data.order_id}\n${statusTh}`;
      await linePush(data.user_id, [{ type: 'text', text: msgText }]).catch(console.error);
      await saveMessage({
        order_id: data.order_id,
        user_id : data.user_id,
        sender  : 'system',
        text    : msgText
      });
    }
  }

  res.json({ success: true, order: data });
});

// ── GET /users ────────────────────────────────────────────
app.get('/users', async (req, res) => {
  const { data, error } = await supabase
    .from('line_users')
    .select('*')
    .order('last_seen', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ total: data.length, users: data });
});

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 LINE Shop Backend v2 — port ${PORT}`);
  console.log(`🗄  Supabase : ${process.env.SUPABASE_URL  ? '✅' : '❌'}`);
  console.log(`💬 LINE     : ${process.env.LINE_TOKEN     ? '✅' : '❌'}\n`);
});
