require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── LINE (ใช้แค่แจ้งเตือนแอดมิน) ───────────────────────────
const LINE_API = 'https://api.line.me/v2/bot/message';

// อ่าน admin UIDs จาก env — รองรับหลายคนคั่นด้วย comma
// รองรับทั้งชื่อเก่า ADMIN_LINE_UID และชื่อใหม่ ADMIN_LINE_UIDS
function getAdminUids() {
  const raw = process.env.ADMIN_LINE_UIDS || process.env.ADMIN_LINE_UID || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

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

// ส่งให้แอดมินทุกคนพร้อมกัน (ไม่ fail ถ้ามีบางคนล้มเหลว)
async function notifyAllAdmins(messages) {
  const uids = getAdminUids();
  if (!uids.length) {
    console.warn('⚠️ ไม่มี ADMIN_LINE_UIDS / ADMIN_LINE_UID ตั้งไว้');
    return { sent: 0, failed: 0 };
  }
  const results = await Promise.allSettled(uids.map(uid => linePush(uid, messages)));
  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) console.warn(`⚠️ ส่งแอดมิน ${sent}/${uids.length} สำเร็จ`);
  return { sent, failed };
}

// ตอบกลับใน LINE webhook (ใช้ replyToken)
async function lineReply(replyToken, messages) {
  const res = await fetch(`${LINE_API}/reply`, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${process.env.LINE_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn('LINE reply failed:', err.message || res.status);
  }
}

// normalize เบอร์โทร — เอาเฉพาะตัวเลข
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// ─── Helpers ──────────────────────────────────────────────
function genOrderId() {
  return 'ORD' + Date.now().toString().slice(-6);
}

function statusLabel(s) {
  return ({
    pending  : '⏳ รอดำเนินการ',
    sent     : '📬 ร้านได้รับออเดอร์แล้ว',
    confirmed: '✅ ยืนยันแล้ว',
    shipped  : '🚚 กำลังจัดส่ง',
    done     : '🎉 เสร็จสิ้น',
    cancelled: '❌ ยกเลิก',
    failed   : '💥 ผิดพลาด'
  })[s] || s;
}

function buildAdminMsg(order) {
  const { customer_name, items, total, order_id, created_at, phone, address, note } = order;
  const date = new Date(created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short' });
  let msg = `🛒 ออเดอร์ใหม่! #${order_id}\n`;
  msg += `${'─'.repeat(24)}\n`;
  msg += `👤 ${customer_name}\n`;
  if (phone)   msg += `📞 ${phone}\n`;
  if (address) msg += `📍 ${address}\n`;
  msg += `📅 ${date}\n`;
  msg += `${'─'.repeat(24)}\n`;
  (items || []).forEach(i => {
    msg += `${i.emoji || '•'} ${i.name}\n`;
    msg += `   ${i.qty} × ฿${i.price.toLocaleString()} = ฿${(i.qty * i.price).toLocaleString()}\n`;
  });
  msg += `${'─'.repeat(24)}\n`;
  msg += `💰 ยอดรวม: ฿${total.toLocaleString()}\n`;
  if (note) msg += `\n📝 ${note}\n`;
  msg += `\n📲 ติดต่อลูกค้าผ่านหน้า Admin Panel ได้เลยค่ะ`;
  return msg;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api', (req, res) => res.json({
  status   : 'ok',
  service  : 'Maejai Shop Backend v3',
  supabase : process.env.SUPABASE_URL ? '✅' : '❌',
  lineToken: process.env.LINE_TOKEN  ? '✅' : '❌'
}));

// ── POST /send-order ──────────────────────────────────────
app.post('/send-order', async (req, res) => {
  const {
    customerId, customerName, phone, address, note,
    items, total, orderType, extra
  } = req.body;

  if (!customerId || !customerName || !items?.length || total == null)
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (customerId/customerName/items/total)' });

  const order_id   = genOrderId();
  const created_at = new Date().toISOString();
  const order      = {
    order_id, customer_id: customerId, customer_name: customerName,
    phone: phone || null, address: address || null, note: note || extra || null,
    items, total, status: 'pending', created_at,
    order_type: orderType || 'pickup'
  };

  const { error: dbErr } = await supabase.from('orders').insert([order]);
  if (dbErr) {
    console.error('DB insert error:', dbErr.message);
    return res.status(500).json({ error: 'บันทึกออเดอร์ไม่ได้: ' + dbErr.message });
  }

  // บันทึก system message ในแชทลูกค้า — สรุปออเดอร์
  const summaryMsg =
    `🎉 ขอบคุณสำหรับการสั่งซื้อ คุณ ${customerName}\n\n` +
    `📦 ออเดอร์ #${order_id}\n` +
    items.map(i => `• ${i.emoji||''} ${i.name} ×${i.qty} = ฿${(i.qty*i.price).toLocaleString()}`).join('\n') +
    `\n\n💰 ยอดรวม: ฿${total.toLocaleString()}\n` +
    `\nร้านจะยืนยันและแจ้งสถานะให้ทราบเร็วๆ นี้ค่ะ 🙏`;

  await supabase.from('messages').insert([{
    order_id, customer_id: customerId,
    sender: 'system', text: summaryMsg,
    created_at: new Date().toISOString()
  }]).then(({ error }) => {
    if (error) console.warn('insert summary msg:', error.message);
  });

  // แจ้งแอดมินทุกคนผ่าน LINE OA
  if (process.env.LINE_TOKEN) {
    try {
      const { sent } = await notifyAllAdmins([{ type: 'text', text: buildAdminMsg(order) }]);
      if (sent > 0) {
        await supabase.from('orders').update({ status: 'sent' }).eq('order_id', order_id);
        console.log(`✅ ${order_id} → admin LINE (${sent} คน)`);
      }
    } catch (e) {
      console.error(`⚠️ ${order_id} LINE notify failed:`, e.message);
    }
  }

  res.json({ success: true, orderId: order_id });
});

// ── GET /my-orders/:customerId ────────────────────────────
app.get('/my-orders/:customerId', async (req, res) => {
  const { customerId } = req.params;
  if (!customerId) return res.status(400).json({ error: 'missing customerId' });

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data || [] });
});

// ── GET /messages/:orderId ────────────────────────────────
app.get('/messages/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data || [] });
});

// ── POST /messages ────────────────────────────────────────
app.post('/messages', async (req, res) => {
  const { order_id, customer_id, sender, text } = req.body;
  if (!order_id || !sender || !text)
    return res.status(400).json({ error: 'missing fields' });

  const { data, error } = await supabase.from('messages').insert([{
    order_id, customer_id, sender, text,
    created_at: new Date().toISOString()
  }]).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // โหลด order มาดู line_user_id และ customer_name
  const { data: order } = await supabase.from('orders')
    .select('customer_name, order_id, line_user_id')
    .eq('order_id', order_id).maybeSingle();

  // ลูกค้าทัก → แจ้งแอดมินทุกคนผ่าน LINE
  if (sender === 'customer' && process.env.LINE_TOKEN) {
    const name = order?.customer_name || 'ลูกค้า';
    const notifyText = `💬 ${name} ส่งข้อความ (#${order_id}):\n\n${text.slice(0,500)}\n\n📲 เปิด Admin Panel เพื่อตอบกลับ`;
    notifyAllAdmins([{ type:'text', text: notifyText }]).catch(console.error);
  }

  // แอดมินตอบ → ส่ง LINE หาลูกค้า (ถ้าผูก line_user_id)
  if (sender === 'admin' && order?.line_user_id && process.env.LINE_TOKEN) {
    const customerMsg = `💬 ข้อความจากร้าน (#${order_id}):\n\n${text.slice(0,4500)}`;
    linePush(order.line_user_id, [{ type:'text', text: customerMsg }])
      .then(() => console.log(`📤 admin reply → ${order.line_user_id.slice(0,12)}…`))
      .catch(e => console.warn('LINE push to customer failed:', e.message));
  }

  res.json({ success: true, message: data });
});

// ── POST /webhook ─────────────────────────────────────────
// LINE bot — ลูกค้าทักมา → ตอบสถานะออเดอร์
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];

  for (const ev of events) {
    const userId = ev.source?.userId;
    if (!userId) continue;

    if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
    const rawText = ev.message.text || '';
    const text = rawText.trim().toLowerCase();
    const replyToken = ev.replyToken;

    // อัปเดต LINE user_id ในออเดอร์ทั้งหมดที่มีเบอร์ตรงกัน (ผูกอัตโนมัติเมื่อพิมพ์เบอร์)
    // ตรวจว่า text เป็นเบอร์โทรไหม (8-12 หลัก)
    const phoneOnly = normalizePhone(rawText);
    if (phoneOnly.length >= 8 && phoneOnly.length <= 12 && /^\d+$/.test(phoneOnly)) {
      // จับคู่ออเดอร์ที่มีเบอร์นี้ → set line_user_id
      const { data: matched } = await supabase.from('orders')
        .select('order_id, phone, customer_name, status, total, customer_id')
        .order('created_at', { ascending: false })
        .limit(50);

      const matches = (matched || []).filter(o => normalizePhone(o.phone) === phoneOnly);

      if (matches.length) {
        // อัปเดต line_user_id ให้ทุกออเดอร์ที่เบอร์ตรงกัน
        await supabase.from('orders')
          .update({ line_user_id: userId })
          .in('order_id', matches.map(o => o.order_id))
          .then(({ error }) => { if (error) console.warn('link line_user_id:', error.message); });

        const lines = matches.slice(0, 5).map(o =>
          `${getStatusEmoji(o.status)} #${o.order_id}\n   ${STATUS_LABELS_TH[o.status] || o.status} • ฿${(o.total||0).toLocaleString()}`
        ).join('\n\n');

        await lineReply(replyToken, [{
          type: 'text',
          text: `✅ ผูกบัญชีสำเร็จ คุณ ${matches[0].customer_name || ''}\n\n` +
                `พบออเดอร์ ${matches.length} รายการ:\n\n${lines}\n\n` +
                `📲 ครั้งหน้าพิมพ์ "ออเดอร์" เพื่อเช็คสถานะได้เลย`
        }]);
        continue;
      } else {
        await lineReply(replyToken, [{
          type: 'text',
          text: `🔍 ไม่พบออเดอร์ที่ใช้เบอร์ ${rawText}\n\nกรุณาตรวจสอบเบอร์ที่กรอกตอนสั่ง หรือสั่งสินค้าใหม่ที่:\nhttps://lineoa-production-a8e8.up.railway.app/`
        }]);
        continue;
      }
    }

    // คำสั่ง: ออเดอร์ / order / สถานะ → ดูออเดอร์ของตัวเอง
    if (text.includes('ออเดอร์') || text.includes('order') || text.includes('สถานะ') || text.includes('status')) {
      // หาออเดอร์ที่ผูกกับ LINE user นี้
      const { data: myOrders } = await supabase.from('orders')
        .select('order_id, status, total, customer_name, created_at, items')
        .eq('line_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (!myOrders?.length) {
        await lineReply(replyToken, [{
          type: 'text',
          text: `📭 ยังไม่พบออเดอร์ของคุณในระบบ\n\n` +
                `🔗 วิธีผูกบัญชี: พิมพ์เบอร์โทรที่ใช้ตอนสั่งซื้อมาครับ\n` +
                `เช่น: 0812345678\n\n` +
                `หรือสั่งสินค้าได้ที่:\nhttps://lineoa-production-a8e8.up.railway.app/`
        }]);
        continue;
      }

      const lines = myOrders.map(o => {
        const date = new Date(o.created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short' });
        const itemsBrief = (o.items || []).slice(0, 2).map(i => `${i.emoji||''} ${i.name} ×${i.qty}`).join(', ');
        const moreItems = (o.items || []).length > 2 ? ` +${(o.items||[]).length - 2} รายการ` : '';
        return `${getStatusEmoji(o.status)} #${o.order_id}\n` +
               `   ${STATUS_LABELS_TH[o.status] || o.status}\n` +
               `   💰 ฿${(o.total||0).toLocaleString()} • ${date}\n` +
               `   ${itemsBrief}${moreItems}`;
      }).join('\n\n');

      await lineReply(replyToken, [{
        type: 'text',
        text: `📋 ออเดอร์ของคุณ ${myOrders[0].customer_name || ''} (${myOrders.length} รายการล่าสุด):\n\n${lines}\n\n` +
              `📲 ดูรายละเอียดเพิ่ม + แชทกับร้านได้ที่:\nhttps://lineoa-production-a8e8.up.railway.app/`
      }]);
      continue;
    }

    // คำสั่ง: help / ช่วยเหลือ / เริ่มต้น
    if (text.includes('help') || text.includes('ช่วย') || text === 'เริ่ม' || text === 'start' || text === 'menu' || text === 'เมนู') {
      await lineReply(replyToken, [{
        type: 'text',
        text: `🛍 สวัสดีค่ะ! ใช้งานได้ดังนี้:\n\n` +
              `📦 พิมพ์ "ออเดอร์" → ดูสถานะออเดอร์ของคุณ\n` +
              `🔗 พิมพ์เบอร์โทร → ผูกบัญชีกับออเดอร์ที่เคยสั่ง\n` +
              `🛒 สั่งสินค้า → https://lineoa-production-a8e8.up.railway.app/\n\n` +
              `ถ้ามีคำถาม พิมพ์มาได้เลย — ร้านจะตอบในแชทค่ะ 💬`
      }]);
      continue;
    }

    // ข้อความอื่นๆ: forward ไปแอดมิน + บันทึกในแชท (ถ้าผูกบัญชีแล้ว)
    const { data: linkedOrders } = await supabase.from('orders')
      .select('order_id, customer_id, customer_name')
      .eq('line_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    const latest = linkedOrders?.[0];

    if (latest) {
      // บันทึกข้อความลูกค้าในแชทออเดอร์ล่าสุด
      await supabase.from('messages').insert([{
        order_id   : latest.order_id,
        customer_id: latest.customer_id,
        sender     : 'customer',
        text       : rawText,
        created_at : new Date().toISOString()
      }]).then(({ error }) => { if (error) console.warn('insert msg:', error.message); });

      // แจ้งแอดมิน
      const notifyText = `💬 ${latest.customer_name || 'ลูกค้า'} ส่งข้อความใน LINE (#${latest.order_id}):\n\n${rawText.slice(0,500)}`;
      notifyAllAdmins([{ type:'text', text: notifyText }]).catch(console.error);

      // ตอบลูกค้าแบบสั้นๆ ว่ารับเรื่องแล้ว
      await lineReply(replyToken, [{
        type: 'text',
        text: `✅ ได้รับข้อความแล้วค่ะ ร้านจะตอบกลับเร็วๆ นี้\n\nหรือพิมพ์ "ออเดอร์" เพื่อดูสถานะ`
      }]);
    } else {
      // ยังไม่ผูกบัญชี
      await lineReply(replyToken, [{
        type: 'text',
        text: `สวัสดีค่ะ 👋\n\n` +
              `📦 พิมพ์ "ออเดอร์" → ดูสถานะ\n` +
              `🔗 พิมพ์เบอร์โทรที่ใช้สั่งซื้อ → ผูกบัญชี\n` +
              `🛒 สั่งสินค้า → https://lineoa-production-a8e8.up.railway.app/`
      }]);
    }
  }
});

// helper สำหรับ webhook
const STATUS_LABELS_TH = {
  pending  : '⏳ รอดำเนินการ',
  sent     : '📬 ร้านได้รับแล้ว',
  confirmed: '✅ ยืนยันแล้ว',
  shipped  : '🚚 กำลังจัดส่ง',
  done     : '🎉 เสร็จสิ้น',
  cancelled: '❌ ยกเลิก',
  failed   : '💥 ผิดพลาด'
};
function getStatusEmoji(s) {
  return ({
    pending:'⏳', sent:'📬', confirmed:'✅',
    shipped:'🚚', done:'🎉', cancelled:'❌', failed:'💥'
  })[s] || '📦';
}

// ── GET /orders (admin) ──────────────────────────────────
app.get('/orders', async (req, res) => {
  const limit  = parseInt(req.query.limit)  || 100;
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
app.patch('/orders/:orderId/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'sent', 'confirmed', 'shipped', 'done', 'cancelled', 'failed'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status must be: ${allowed.join(', ')}` });

  const { data, error } = await supabase
    .from('orders').update({ status }).eq('order_id', req.params.orderId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (data) {
    // 1) บันทึก system message ในแชทเว็บ
    await supabase.from('messages').insert([{
      order_id   : data.order_id,
      customer_id: data.customer_id,
      sender     : 'system',
      text       : `📦 ออเดอร์ #${data.order_id} อัปเดตสถานะ: ${statusLabel(status)}`,
      created_at : new Date().toISOString()
    }]).catch(console.error);

    // 2) ส่ง LINE หาลูกค้า (ถ้าผูก line_user_id แล้ว)
    if (data.line_user_id && process.env.LINE_TOKEN) {
      const customerMsg =
        `📦 อัปเดตออเดอร์ #${data.order_id}\n\n` +
        `${statusLabel(status)}\n\n` +
        `💰 ยอดรวม: ฿${(data.total||0).toLocaleString()}\n\n` +
        `ดูรายละเอียดเพิ่ม:\nhttps://lineoa-production-a8e8.up.railway.app/`;
      linePush(data.line_user_id, [{ type:'text', text: customerMsg }])
        .then(() => console.log(`📤 status update → ${data.line_user_id.slice(0,12)}…`))
        .catch(e => console.warn('LINE push to customer failed:', e.message));
    }
  }

  res.json({ success: true, order: data });
});

// ═══════════════════════════════════════════════════════════
//  STATIC FILES
// ═══════════════════════════════════════════════════════════
//  หน้าร้านลูกค้า อยู่ที่ index.html (อยู่บน Railway/GitHub)
//  หน้าแอดมิน admin.html เก็บไว้ในเครื่องเจ้าของร้าน — เปิดจาก browser ตรงๆ
//  (admin.html จะเรียก API ของ backend ที่นี่ผ่าน CORS)

// fallback: ทุก URL ที่ไม่ match route ข้างบน → ส่งหน้าร้าน
app.use(express.static(__dirname));

app.get('/shop', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const adminCount = getAdminUids().length;
  console.log(`\n🚀 Maejai Shop Backend v3 — port ${PORT}`);
  console.log(`🗄  Supabase  : ${process.env.SUPABASE_URL  ? '✅' : '❌'}`);
  console.log(`💬 LINE      : ${process.env.LINE_TOKEN     ? '✅' : '❌'}`);
  console.log(`👥 Admins    : ${adminCount} คน`);
  console.log(`📍 Routes    : /shop, /admin, /api`);
});
