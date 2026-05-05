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

// ─── LINE Flex Message Builders ───────────────────────────
const SHOP_URL = 'https://lineoa-production-a8e8.up.railway.app/';

// ─── LINE OA Auto-Reply Keywords ───
// ถ้าลูกค้าพิมพ์ตรงกับ keyword เหล่านี้ → ระบบไม่แจ้งแอดมิน LINE
// (เพราะ LINE OA ตั้ง auto-reply ตอบให้แล้ว — ไม่ต้องรบกวนแอดมิน)
//
// แก้ list ได้ 2 ทาง:
// 1. แก้ตรงนี้แล้ว redeploy
// 2. ตั้ง ENV variable LINE_OA_AUTOREPLY_KEYWORDS ใน Railway (ใช้ , แยก)
//    ตัวอย่าง: วิธีสั่งสินค้า,สั่งยังไง,วิธีใช้,ราคาเท่าไหร่
const DEFAULT_AUTOREPLY_KEYWORDS = [
  'วิธีสั่งสินค้า',
  'สั่งยังไง',
  'วิธีสั่ง',
  'วิธีใช้',
  'วิธีใช้งาน',
  'ราคาเท่าไหร่',
  'มีโปรไหม',
  'โปรโมชั่น',
  'สวัสดี',
  'สวัสดีครับ',
  'สวัสดีค่ะ',
  'hello',
  'hi'
];

const AUTOREPLY_KEYWORDS = (
  process.env.LINE_OA_AUTOREPLY_KEYWORDS
    ? process.env.LINE_OA_AUTOREPLY_KEYWORDS.split(',')
    : DEFAULT_AUTOREPLY_KEYWORDS
).map(k => k.trim().toLowerCase()).filter(Boolean);

function isAutoReplyKeyword(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  // exact match
  if (AUTOREPLY_KEYWORDS.includes(t)) return true;
  // เผื่อมี whitespace/symbol เกินมา
  const cleaned = t.replace(/[\s\?\!\.\,]+/g, '');
  return AUTOREPLY_KEYWORDS.some(k => k.replace(/\s+/g, '') === cleaned);
}


// สีตามสถานะ
function statusColor(s) {
  return ({
    pending  : '#F39C12',
    sent     : '#3498DB',
    confirmed: '#27AE60',
    shipped  : '#8E44AD',
    done     : '#16A085',
    cancelled: '#95A5A6',
    failed   : '#E74C3C'
  })[s] || '#7F8C8D';
}

// Flex: สรุปออเดอร์ใหม่ (ส่งหาลูกค้าหลังสั่ง)
function buildOrderSummaryFlex(order) {
  // ป้องกันค่า undefined/NaN
  const safe = (v, fallback = '') => (v === undefined || v === null ? fallback : v);
  const safeNum = (v) => {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  };

  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.slice(0, 6).map(i => {
    const qty   = safeNum(i.qty) || 1;
    const price = safeNum(i.price);
    const lineTotal = qty * price;
    const emoji = String(safe(i.emoji, '•')).trim() || '•';
    const name  = String(safe(i.name, 'สินค้า')).trim() || 'สินค้า';
    return {
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type:'text', text:`${emoji} ${name}`, size:'sm', color:'#333333', flex:5, wrap:true },
        { type:'text', text:`×${qty}`, size:'sm', color:'#888888', flex:1, align:'end' },
        { type:'text', text:`฿${lineTotal.toLocaleString()}`, size:'sm', color:'#C0392B', weight:'bold', flex:2, align:'end' }
      ]
    };
  });

  // ถ้าไม่มี items เลย → ใส่ placeholder
  if (!itemRows.length) {
    itemRows.push({
      type: 'text', text: '— ไม่มีรายการสินค้า —',
      size: 'sm', color: '#888888', align: 'center', margin: 'sm'
    });
  }

  const moreItems = items.length > 6
    ? [{ type:'text', text:`+${items.length - 6} รายการ`, size:'xs', color:'#888888', margin:'sm' }]
    : [];

  const total = safeNum(order.total);
  const orderId = String(safe(order.order_id, '-'));
  const customerName = String(safe(order.customer_name, '-')).trim() || '-';

  return {
    type: 'flex',
    altText: `ออเดอร์ #${orderId} ของคุณ ฿${total.toLocaleString()}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: '#C0392B',
        paddingAll: 'lg',
        contents: [
          { type:'text', text:'🎉 ขอบคุณสำหรับการสั่งซื้อ', color:'#ffffff', size:'sm', weight:'regular' },
          { type:'text', text:`#${orderId}`, color:'#ffffff', size:'xl', weight:'bold', margin:'sm' },
          { type:'text', text:`คุณ ${customerName}`, color:'#ffffff', size:'sm', margin:'xs' }
        ]
      },
      body: {
        type:'box', layout:'vertical', spacing:'md', paddingAll:'lg',
        contents: [
          { type:'text', text:'📦 รายการสินค้า', size:'sm', color:'#888888', weight:'bold' },
          ...itemRows,
          ...moreItems,
          { type:'separator', margin:'lg' },
          { type:'box', layout:'horizontal', margin:'md',
            contents:[
              { type:'text', text:'ยอดรวม', size:'md', color:'#333333', flex:1 },
              { type:'text', text:`฿${total.toLocaleString()}`, size:'lg', color:'#C0392B', weight:'bold', align:'end' }
            ]
          },
          { type:'text', text:'⏳ ร้านกำลังตรวจสอบและจะแจ้งให้ทราบเร็วๆ นี้', size:'xs', color:'#888888', wrap:true, margin:'lg', align:'center' }
        ]
      },
      footer: {
        type:'box', layout:'vertical', spacing:'sm', paddingAll:'lg', paddingTop:'none',
        contents: [
          { type:'button', style:'primary', color:'#C0392B', height:'sm',
            action: { type:'postback', label:'📋 ดูสถานะออเดอร์',
                      data:`action=view_order&id=${orderId}`,
                      displayText:`📋 ดูสถานะ #${orderId}` }
          },
          { type:'button', style:'secondary', height:'sm',
            action: { type:'uri', label:'🛒 สั่งซื้อเพิ่ม', uri: SHOP_URL }
          }
        ]
      }
    }
  };
}

// Flex: อัปเดตสถานะออเดอร์
function buildStatusUpdateFlex(order, status) {
  const labels = {
    pending  : { emoji:'⏳', text:'รอดำเนินการ', desc:'ร้านกำลังตรวจสอบออเดอร์ของคุณ' },
    sent     : { emoji:'📬', text:'ร้านได้รับแล้ว', desc:'ร้านได้รับออเดอร์ของคุณเรียบร้อยแล้ว' },
    confirmed: { emoji:'✅', text:'ยืนยันแล้ว', desc:'ร้านยืนยันออเดอร์เรียบร้อย กำลังจัดเตรียม' },
    shipped  : { emoji:'🚚', text:'กำลังจัดส่ง', desc:'สินค้าออกจากร้านแล้ว รอรับได้เลย' },
    done     : { emoji:'🎉', text:'เสร็จสิ้น', desc:'ขอบคุณที่อุดหนุนร้านเรา ❤️' },
    cancelled: { emoji:'❌', text:'ยกเลิก', desc:'ออเดอร์ถูกยกเลิก ติดต่อร้านหากมีข้อสงสัย' },
    failed   : { emoji:'💥', text:'ผิดพลาด', desc:'มีข้อผิดพลาดเกิดขึ้น กรุณาติดต่อร้าน' }
  };
  const lbl = labels[status] || { emoji:'📦', text:status, desc:'' };

  return {
    type:'flex',
    altText: `${lbl.emoji} ออเดอร์ #${order.order_id} — ${lbl.text}`,
    contents: {
      type:'bubble',
      header: {
        type:'box', layout:'vertical',
        backgroundColor: statusColor(status),
        paddingAll:'lg',
        contents: [
          { type:'text', text:`${lbl.emoji} อัปเดตสถานะ`, color:'#ffffff', size:'sm' },
          { type:'text', text: lbl.text, color:'#ffffff', size:'xl', weight:'bold', margin:'sm' }
        ]
      },
      body: {
        type:'box', layout:'vertical', spacing:'md', paddingAll:'lg',
        contents: [
          { type:'box', layout:'horizontal',
            contents: [
              { type:'text', text:'ออเดอร์', size:'sm', color:'#888888', flex:1 },
              { type:'text', text:`#${order.order_id}`, size:'sm', color:'#333333', weight:'bold', align:'end', flex:2 }
            ]
          },
          { type:'box', layout:'horizontal',
            contents: [
              { type:'text', text:'ยอดรวม', size:'sm', color:'#888888', flex:1 },
              { type:'text', text:`฿${(order.total||0).toLocaleString()}`, size:'sm', color:'#C0392B', weight:'bold', align:'end', flex:2 }
            ]
          },
          { type:'separator', margin:'md' },
          { type:'text', text: lbl.desc, size:'sm', color:'#555555', wrap:true, margin:'md' }
        ]
      },
      footer: {
        type:'box', layout:'vertical', paddingAll:'lg', paddingTop:'none',
        contents: [
          { type:'button', style:'primary', color:'#C0392B', height:'sm',
            action:{ type:'postback', label:'📋 ดูรายละเอียด',
                     data:`action=view_order&id=${order.order_id}`,
                     displayText:`📋 ดูรายละเอียด #${order.order_id}` }
          }
        ]
      }
    }
  };
}

// Flex: ข้อความจากร้าน (chat)
function buildChatFlex(order, text) {
  return {
    type:'flex',
    altText: `💬 ข้อความจากร้าน: ${text.slice(0,80)}`,
    contents: {
      type:'bubble',
      header: {
        type:'box', layout:'vertical',
        backgroundColor:'#C0392B',
        paddingAll:'md',
        contents:[
          { type:'text', text:'💬 ข้อความจากร้าน', color:'#ffffff', size:'sm', weight:'bold' },
          ...(order?.order_id && !String(order.order_id).startsWith('LINE-')
              ? [{ type:'text', text:`#${order.order_id}`, color:'#ffffff', size:'xs', margin:'xs' }]
              : [])
        ]
      },
      body: {
        type:'box', layout:'vertical', paddingAll:'lg',
        contents: [
          { type:'text', text: text.slice(0, 1500), size:'sm', color:'#333333', wrap:true }
        ]
      },
      footer: {
        type:'box', layout:'vertical', paddingAll:'lg', paddingTop:'none',
        contents: [
          { type:'button', style:'primary', color:'#C0392B', height:'sm',
            action:{ type:'uri', label:'💬 ตอบในเว็บ', uri: SHOP_URL }
          }
        ]
      }
    }
  };
}

// หา line_user_id ของ customer (จากออเดอร์ใดๆ ของเขาที่ผูกบัญชีแล้ว)
async function findLineUserIdByCustomer(customerId) {
  if (!customerId) return null;
  const { data } = await supabase.from('orders')
    .select('line_user_id')
    .eq('customer_id', customerId)
    .not('line_user_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.line_user_id || null;
}

// ─── LINE Auto-Link System ─────────────────────────────────
// เก็บ token แบบ in-memory (อายุสั้น 30 นาที — กันคนแอบใช้ของคนอื่น)
const linkTokens = new Map(); // token → { lineUserId, expiresAt }

function genLinkToken() {
  // 24-char random string
  return 'L' + Math.random().toString(36).slice(2, 12) +
         Math.random().toString(36).slice(2, 14);
}

function createLinkToken(lineUserId) {
  const token = genLinkToken();
  linkTokens.set(token, {
    lineUserId,
    expiresAt: Date.now() + 30 * 60 * 1000  // 30 นาที
  });
  // cleanup expired tokens (เก็บ map ไม่ให้บวม)
  if (linkTokens.size > 1000) {
    const now = Date.now();
    for (const [k, v] of linkTokens) {
      if (v.expiresAt < now) linkTokens.delete(k);
    }
  }
  return token;
}

function consumeLinkToken(token) {
  const entry = linkTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    linkTokens.delete(token);
    return null;
  }
  // ใช้ครั้งเดียวแล้วลบ (one-time use)
  linkTokens.delete(token);
  return entry.lineUserId;
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
    customerId, customerName, lineName, phone, address, note,
    items, total, orderType, extra,
    mapLat, mapLng                              // 📍 พิกัด GPS
  } = req.body;

  if (!customerId || !customerName || !items?.length || total == null)
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (customerId/customerName/items/total)' });

  const order_id   = genOrderId();
  const created_at = new Date().toISOString();
  const order      = {
    order_id, customer_id: customerId,
    customer_name: customerName,             // ชื่อจริง — สำหรับจ่าหน้าพัสดุ
    line_name: lineName || customerName,     // ✨ ชื่อ LINE — สำหรับผูกแชท
    phone: phone || null, address: address || null, note: note || extra || null,
    items, total, status: 'pending', created_at,
    order_type: orderType || 'pickup',
    // 📍 พิกัด GPS (ถ้ามี)
    map_lat: (mapLat !== null && mapLat !== undefined && !isNaN(mapLat)) ? Number(mapLat) : null,
    map_lng: (mapLng !== null && mapLng !== undefined && !isNaN(mapLng)) ? Number(mapLng) : null
  };

  const { error: dbErr } = await supabase.from('orders').insert([order]);
  if (dbErr) {
    console.error('DB insert error:', dbErr.message);
    return res.status(500).json({ error: 'บันทึกออเดอร์ไม่ได้: ' + dbErr.message });
  }

  // ✂️ ลด stock ของแต่ละ item (ถ้า products มี stock tracking)
  for (const it of items) {
    if (!it.productId || !it.sizeName) continue; // skip ถ้า items เก่าไม่มี productId
    try {
      // ใช้ RPC function ที่สร้างไว้
      await supabase.rpc('deduct_stock', {
        p_product_id: it.productId,
        p_size_name : it.sizeName,
        p_qty       : it.qty
      }).then(({ error }) => {
        if (error) console.warn(`deduct_stock ${it.productId}/${it.sizeName}:`, error.message);
      });
    } catch (e) {
      console.warn('stock deduct skipped:', e.message);
    }
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

  // ✨ Auto-link: หา ghost LINE chat ที่ลูกค้าเคยทักไว้ → ผูก line_user_id ให้ออเดอร์ใหม่
  // ใช้เบอร์โทรเป็น matching key ก่อน (แม่นกว่า) — fallback ใช้ customer_name
  let autoLinkedLineUid = null;
  try {
    // หา ghost orders ที่อาจจะเป็นลูกค้าคนเดียวกัน
    const { data: ghostOrders } = await supabase.from('orders')
      .select('order_id, line_user_id, customer_name, line_name, phone')
      .like('order_id', 'LINE-%')
      .not('line_user_id', 'is', null);

    if (ghostOrders?.length) {
      // matching: phone, ชื่อ LINE (สำคัญสุด!), หรือ ชื่อจริง
      const normPhone = (p) => String(p || '').replace(/\D/g, '');
      const norm = (s) => String(s || '').trim().toLowerCase();
      const myPhone = normPhone(phone);
      const myLineName = norm(lineName);          // ✨ ใช้ชื่อ LINE เป็นหลัก
      const myCustName = norm(customerName);

      const matched = ghostOrders.find(g => {
        const gLine = norm(g.line_name);
        const gCust = norm(g.customer_name);
        return (myPhone && normPhone(g.phone) === myPhone) ||
               (myLineName && gLine && gLine === myLineName) ||
               (myLineName && gCust && gCust === myLineName) ||  // ghost เก่าอาจเก็บใน customer_name
               (myCustName && gCust && gCust === myCustName);
      });

      if (matched?.line_user_id) {
        autoLinkedLineUid = matched.line_user_id;
        // อัปเดตออเดอร์ใหม่ + ทุกออเดอร์ของ customer_id ให้มี line_user_id
        await supabase.from('orders')
          .update({ line_user_id: autoLinkedLineUid })
          .eq('customer_id', customerId)
          .then(({ error }) => { if (!error) console.log(`🔗 auto-linked ${customerId} ↔ LINE`); });
      }
    }
  } catch (e) {
    console.warn('auto-link failed:', e.message);
  }

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

  // ✨ ส่ง Flex Message ออเดอร์สรุปหาลูกค้า (ถ้าเคยผูกบัญชีไว้ หรือเพิ่ง auto-link)
  if (process.env.LINE_TOKEN) {
    const customerLineUid = autoLinkedLineUid || await findLineUserIdByCustomer(customerId);
    if (customerLineUid) {
      const flex = buildOrderSummaryFlex({ ...order, status: 'sent' });
      linePush(customerLineUid, [flex])
        .then(() => console.log(`📤 order summary → ${customerLineUid.slice(0,12)}…`))
        .catch(e => console.warn('LINE flex to customer failed:', e.message));
    } else {
      console.log(`ℹ️ ${order_id} ลูกค้ายังไม่ได้ผูกบัญชี LINE — จะส่ง flex หลังผูกบัญชี`);
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

// ── POST /link-line ───────────────────────────────────────
// ผูก customer_id (จาก shop browser) ↔ line_user_id อัตโนมัติ
// shop เรียกตอนลูกค้าเปิดด้วย ?lid=TOKEN
app.post('/link-line', async (req, res) => {
  const { customer_id, link_token } = req.body;
  if (!customer_id || !link_token)
    return res.status(400).json({ error: 'missing customer_id or link_token' });

  const lineUserId = consumeLinkToken(link_token);
  if (!lineUserId)
    return res.status(400).json({ error: 'token invalid or expired' });

  // อัปเดต line_user_id ในออเดอร์ของ customer นี้
  const { error } = await supabase.from('orders')
    .update({ line_user_id: lineUserId })
    .eq('customer_id', customer_id);
  if (error) console.warn('link orders failed:', error.message);

  // ดึงโปรไฟล์ LINE มาเพิ่ม customer_name (ถ้าออเดอร์ยังไม่มีชื่อ)
  let displayName = null;
  try {
    const profRes = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
      headers: { 'Authorization': `Bearer ${process.env.LINE_TOKEN}` }
    });
    if (profRes.ok) {
      const profile = await profRes.json();
      displayName = profile.displayName || null;
    }
  } catch(e) { /* ignore */ }

  console.log(`🔗 linked customer ${customer_id} ↔ LINE ${lineUserId.slice(0,12)}…`);
  res.json({ success: true, lineUserId: lineUserId.slice(0,12) + '…', displayName });
});

// ── POST /backfill-line-links ─────────────────────────────
// แก้ครั้งเดียวสำหรับออเดอร์เก่าที่ยังไม่ผูก line_user_id
// จับคู่ ghost orders (LINE-) กับ ออเดอร์จริง โดยใช้ phone เป็น matching key
app.post('/backfill-line-links', async (req, res) => {
  const { data: ghosts } = await supabase.from('orders')
    .select('line_user_id, customer_name, phone')
    .like('order_id', 'LINE-%')
    .not('line_user_id', 'is', null);

  if (!ghosts?.length) return res.json({ updated: 0, message: 'no ghost orders' });

  const normPhone = (p) => String(p || '').replace(/\D/g, '');

  let totalUpdated = 0;
  const linked = [];
  for (const g of ghosts) {
    const phone = normPhone(g.phone);
    const name  = (g.customer_name || '').trim().toLowerCase();

    // หาออเดอร์จริงที่ phone หรือ name ตรงกัน แต่ยังไม่มี line_user_id
    const { data: realOrders } = await supabase.from('orders')
      .select('order_id, customer_id, customer_name, phone')
      .not('order_id', 'like', 'LINE-%')
      .is('line_user_id', null);

    const matches = (realOrders || []).filter(o =>
      (phone && normPhone(o.phone) === phone) ||
      (name && (o.customer_name || '').trim().toLowerCase() === name)
    );

    if (matches.length) {
      // get all customer_ids
      const customerIds = [...new Set(matches.map(m => m.customer_id).filter(Boolean))];
      if (customerIds.length) {
        const { count } = await supabase.from('orders')
          .update({ line_user_id: g.line_user_id }, { count: 'exact' })
          .in('customer_id', customerIds);
        totalUpdated += count || 0;
        linked.push({ name: g.customer_name, lineUid: g.line_user_id.slice(0,12)+'…', count });
      }
    }
  }
  res.json({ updated: totalUpdated, linked });
});

// ── POST /resend-order/:orderId ───────────────────────────
// แอดมิน trigger ส่ง Flex สรุปออเดอร์ไปหาลูกค้าใน LINE
// ถ้าลูกค้ายังไม่ผูก → ลอง auto-link ด้วย phone/name ก่อน
app.post('/resend-order/:orderId', async (req, res) => {
  const { orderId } = req.params;
  if (!process.env.LINE_TOKEN)
    return res.status(500).json({ error: 'LINE_TOKEN not set' });

  // โหลดข้อมูลออเดอร์
  const { data: order, error: orderErr } = await supabase
    .from('orders').select('*').eq('order_id', orderId).maybeSingle();

  if (orderErr) return res.status(500).json({ error: orderErr.message });
  if (!order)   return res.status(404).json({ error: 'order not found' });
  if (String(order.order_id).startsWith('LINE-'))
    return res.status(400).json({ error: 'cannot resend ghost chat thread' });

  // หา line_user_id หลายทาง
  let targetUid = order.line_user_id;
  let linkedHow = targetUid ? 'direct' : null;

  // fallback 1: หาจาก customer_id
  if (!targetUid && order.customer_id) {
    targetUid = await findLineUserIdByCustomer(order.customer_id);
    if (targetUid) linkedHow = 'customer_id';
  }

  // fallback 2: หาจาก phone/name match กับ ghost orders
  if (!targetUid) {
    const normPhone = (p) => String(p || '').replace(/\D/g, '');
    const myPhone = normPhone(order.phone);
    const myName  = (order.customer_name || '').trim().toLowerCase();

    if (myPhone || myName) {
      const { data: ghosts } = await supabase.from('orders')
        .select('line_user_id, customer_name, phone')
        .like('order_id', 'LINE-%')
        .not('line_user_id', 'is', null);

      const matched = (ghosts || []).find(g =>
        (myPhone && normPhone(g.phone) === myPhone) ||
        (myName && (g.customer_name || '').trim().toLowerCase() === myName)
      );

      if (matched?.line_user_id) {
        targetUid = matched.line_user_id;
        linkedHow = matched.phone === order.phone ? 'phone' : 'name';

        // backfill ให้ออเดอร์ของ customer คนนี้ทุกตัว
        if (order.customer_id) {
          await supabase.from('orders')
            .update({ line_user_id: targetUid })
            .eq('customer_id', order.customer_id);
        } else {
          await supabase.from('orders')
            .update({ line_user_id: targetUid })
            .eq('order_id', order.order_id);
        }
      }
    }
  }

  if (!targetUid) {
    return res.status(404).json({
      error: 'no LINE user linked',
      hint: 'ลูกค้ายังไม่ผูกบัญชี LINE — กดปุ่ม 🔗 ที่ ghost chat row เพื่อใส่เบอร์/ชื่อให้ตรงกัน'
    });
  }

  try {
    const flex = buildOrderSummaryFlex(order);
    await linePush(targetUid, [flex]);
    console.log(`📤 resend order ${orderId} → ${targetUid.slice(0,12)}… (via ${linkedHow})`);
    res.json({
      success: true,
      sentTo: targetUid.slice(0, 12) + '…',
      linkedVia: linkedHow
    });
  } catch (e) {
    console.warn(`❌ resend failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
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

  // แอดมินตอบ → ส่ง Flex Message LINE หาลูกค้า
  if (sender === 'admin' && process.env.LINE_TOKEN) {
    let targetUserId = order?.line_user_id;
    console.log(`[admin reply] order_id=${order_id}, order.line_user_id=${targetUserId || 'null'}`);

    // ถ้า order_id มาในรูปแบบ "LINE-..." แต่ไม่มี line_user_id
    if (!targetUserId && order_id.startsWith('LINE-')) {
      const { data: ghostOrder } = await supabase.from('orders')
        .select('line_user_id').eq('order_id', order_id).maybeSingle();
      if (ghostOrder?.line_user_id) {
        targetUserId = ghostOrder.line_user_id;
        console.log(`[admin reply] found via ghost lookup: ${targetUserId.slice(0,12)}…`);
      }
    }

    // fallback 1: หาจาก customer_id
    if (!targetUserId && customer_id) {
      targetUserId = await findLineUserIdByCustomer(customer_id);
      if (targetUserId) console.log(`[admin reply] found via customer_id: ${targetUserId.slice(0,12)}…`);
    }

    // fallback 2: ถ้า order_id แบบ "LINE-{prefix16}" — scan หา full userId ใน DB ที่ขึ้นต้นด้วย prefix นี้
    if (!targetUserId && order_id.startsWith('LINE-')) {
      const prefix = order_id.slice(5); // เอาส่วนหลัง "LINE-"
      const { data: scanRows } = await supabase.from('orders')
        .select('line_user_id')
        .not('line_user_id', 'is', null)
        .like('line_user_id', `${prefix}%`)
        .limit(1);
      if (scanRows?.[0]?.line_user_id) {
        targetUserId = scanRows[0].line_user_id;
        console.log(`[admin reply] found via prefix scan: ${targetUserId.slice(0,12)}…`);

        // backfill ghost order ให้มี line_user_id
        await supabase.from('orders')
          .update({ line_user_id: targetUserId })
          .eq('order_id', order_id)
          .then(({ error }) => { if (!error) console.log('[admin reply] backfilled ghost order'); });
      }
    }

    if (targetUserId) {
      try {
        const flex = buildChatFlex(order, text);
        await linePush(targetUserId, [flex]);
        console.log(`📤 admin reply → ${targetUserId.slice(0,12)}…`);
      } catch (e) {
        console.warn(`❌ LINE push failed for ${targetUserId.slice(0,12)}…: ${e.message}`);
      }
    } else {
      console.warn(`❌ no target LINE user found for order ${order_id}`);
    }
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

    // ── FOLLOW EVENT (ลูกค้าเพิ่ม bot เป็นเพื่อน / unblock) ──
    if (ev.type === 'follow') {
      const replyToken = ev.replyToken;
      const token = createLinkToken(userId);
      const shopLink = `${SHOP_URL}?lid=${token}`;

      await lineReply(replyToken, [
        {
          type: 'text',
          text: `🛍 สวัสดีค่ะ! ยินดีต้อนรับสู่ มนชิน ซัพพลาย\n\n` +
                `กดลิงก์ด้านล่างเพื่อเริ่มสั่งซื้อ ระบบจะจดจำคุณอัตโนมัติ ไม่ต้องลงทะเบียน 🚀\n\n` +
                `${shopLink}\n\n` +
                `ครั้งหน้าพิมพ์ "เปิดร้าน" เพื่อรับลิงก์ใหม่ได้ตลอดค่ะ`
        }
      ]);
      continue;
    }

    // ── POSTBACK EVENTS (กดปุ่มใน Flex Message) ──
    if (ev.type === 'postback') {
      const replyToken = ev.replyToken;
      const data = ev.postback?.data || '';
      const params = new URLSearchParams(data);
      const action = params.get('action');

      if (action === 'view_order') {
        const orderId = params.get('id');
        if (!orderId) { await lineReply(replyToken, [{ type:'text', text:'❌ ไม่พบเลขออเดอร์' }]); continue; }

        const { data: order } = await supabase.from('orders')
          .select('*').eq('order_id', orderId).maybeSingle();

        if (!order) {
          await lineReply(replyToken, [{ type:'text', text:`❌ ไม่พบออเดอร์ #${orderId}` }]);
          continue;
        }

        // ตอบกลับด้วยข้อความสรุป + Flex รายละเอียด
        const st = order.status || 'pending';
        const itemsList = (order.items || []).map(i =>
          `${i.emoji||'•'} ${i.name} ×${i.qty} = ฿${(i.qty*i.price).toLocaleString()}`
        ).join('\n');
        const date = new Date(order.created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short' });

        let detailText =
          `📦 ออเดอร์ #${order.order_id}\n` +
          `${'─'.repeat(20)}\n` +
          `${getStatusEmoji(st)} สถานะ: ${STATUS_LABELS_TH[st] || st}\n\n` +
          `👤 ${order.customer_name || '-'}\n`;

        if (order.phone)   detailText += `📞 ${order.phone}\n`;
        if (order.address) detailText += `📍 ${order.address}\n`;
        detailText += `📅 ${date}\n`;
        detailText += `${'─'.repeat(20)}\n`;
        if (itemsList) detailText += `${itemsList}\n${'─'.repeat(20)}\n`;
        detailText += `💰 ยอดรวม: ฿${(order.total||0).toLocaleString()}`;
        if (order.note) detailText += `\n\n📝 ${order.note}`;

        // ส่งทั้ง text และ flex update (สถานะปัจจุบัน)
        const messages = [{ type:'text', text: detailText }];
        if (Array.isArray(order.items) && order.items.length > 0) {
          messages.push(buildStatusUpdateFlex(order, st));
        }
        await lineReply(replyToken, messages);
        continue;
      }

      // postback อื่นๆ ที่ไม่รู้จัก
      continue;
    }

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

        // ดึงออเดอร์ล่าสุดเต็มข้อมูล (มี items) เพื่อส่ง Flex summary
        const { data: fullLatest } = await supabase.from('orders')
          .select('*')
          .eq('order_id', matches[0].order_id)
          .maybeSingle();

        // ตอบลูกค้าด้วย text+flex รวมกัน
        const replyMessages = [
          {
            type: 'text',
            text: `✅ ผูกบัญชีสำเร็จ คุณ ${matches[0].customer_name || ''}\n\n` +
                  `พบออเดอร์ทั้งหมด ${matches.length} รายการ\n\n` +
                  `📲 พิมพ์ "ออเดอร์" เพื่อดูทั้งหมด หรือดูออเดอร์ล่าสุดด้านล่าง 👇`
          }
        ];
        if (fullLatest && fullLatest.items?.length) {
          replyMessages.push(buildOrderSummaryFlex(fullLatest));
        }

        await lineReply(replyToken, replyMessages);
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
        .select('*')
        .eq('line_user_id', userId)
        .not('items', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

      // กรอง ghost orders ออก (ที่ items เป็น array ว่าง)
      const realOrders = (myOrders || []).filter(o =>
        Array.isArray(o.items) && o.items.length > 0
      );

      if (!realOrders.length) {
        await lineReply(replyToken, [{
          type: 'text',
          text: `📭 ยังไม่พบออเดอร์ของคุณในระบบ\n\n` +
                `🔗 วิธีผูกบัญชี: พิมพ์เบอร์โทรที่ใช้ตอนสั่งซื้อมาครับ\n` +
                `เช่น: 0812345678\n\n` +
                `หรือสั่งสินค้าได้ที่:\n${SHOP_URL}`
        }]);
        continue;
      }

      // ส่ง Flex carousel (สูงสุด 10 bubble ใน carousel)
      const bubbles = realOrders.slice(0, 10).map(o => ({
        type:'bubble', size:'kilo',
        header: {
          type:'box', layout:'vertical',
          backgroundColor: statusColor(o.status),
          paddingAll:'md',
          contents:[
            { type:'text', text:`${getStatusEmoji(o.status)} ${STATUS_LABELS_TH[o.status]||o.status}`, color:'#ffffff', size:'sm', weight:'bold' },
            { type:'text', text:`#${o.order_id}`, color:'#ffffff', size:'xs', margin:'xs' }
          ]
        },
        body: {
          type:'box', layout:'vertical', spacing:'sm', paddingAll:'md',
          contents: [
            ...((o.items||[]).slice(0,3).map(i => ({
              type:'text',
              text:`${i.emoji||'•'} ${i.name} ×${i.qty}`,
              size:'xs', color:'#555555', wrap:true
            }))),
            ...((o.items||[]).length > 3 ? [{ type:'text', text:`+${o.items.length-3} รายการ`, size:'xxs', color:'#888888' }] : []),
            { type:'separator', margin:'md' },
            { type:'box', layout:'horizontal', margin:'md',
              contents:[
                { type:'text', text:'รวม', size:'xs', color:'#888888', flex:1 },
                { type:'text', text:`฿${(o.total||0).toLocaleString()}`, size:'sm', color:'#C0392B', weight:'bold', align:'end', flex:2 }
              ]
            },
            { type:'text', text: new Date(o.created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short' }), size:'xxs', color:'#aaaaaa', margin:'xs' }
          ]
        },
        footer: {
          type:'box', layout:'vertical', paddingAll:'md', paddingTop:'none',
          contents:[
            { type:'button', style:'primary', color:'#C0392B', height:'sm',
              action:{ type:'postback', label:'📋 ดูรายละเอียด',
                       data:`action=view_order&id=${o.order_id}`,
                       displayText:`📋 ดูรายละเอียด #${o.order_id}` }
            }
          ]
        }
      }));

      await lineReply(replyToken, [
        {
          type:'text',
          text: `📋 ออเดอร์ของคุณ ${realOrders[0].customer_name || ''} (${realOrders.length} รายการล่าสุด)`
        },
        {
          type:'flex',
          altText:`ออเดอร์ของคุณ ${realOrders.length} รายการ`,
          contents:{ type:'carousel', contents: bubbles }
        }
      ]);
      continue;
    }

    // คำสั่ง: เปิดร้าน / shop / สั่ง / ซื้อ → ส่งลิงก์ shop พร้อม token
    if (text === 'เปิดร้าน' || text === 'shop' || text === 'สั่ง' || text === 'ซื้อ' || text === 'สั่งซื้อ' || text === 'เปิด' || text === 'ร้าน') {
      const token = createLinkToken(userId);
      const shopLink = `${SHOP_URL}?lid=${token}`;
      await lineReply(replyToken, [{
        type: 'text',
        text: `🛍 กดลิงก์ด้านล่างเพื่อเปิดร้านค้า ระบบจะจดจำคุณอัตโนมัติ\n\n${shopLink}\n\n⏰ ลิงก์มีอายุ 30 นาที`
      }]);
      continue;
    }

    // คำสั่ง: help / ช่วยเหลือ / เริ่มต้น
    if (text.includes('help') || text.includes('ช่วย') || text === 'เริ่ม' || text === 'start' || text === 'menu' || text === 'เมนู') {
      const token = createLinkToken(userId);
      const shopLink = `${SHOP_URL}?lid=${token}`;
      await lineReply(replyToken, [{
        type: 'text',
        text: `🛍 สวัสดีค่ะ! ใช้งานได้ดังนี้:\n\n` +
              `🛒 สั่งสินค้า → ${shopLink}\n` +
              `📦 พิมพ์ "ออเดอร์" → ดูสถานะออเดอร์\n` +
              `🔗 พิมพ์เบอร์โทร → ผูกออเดอร์เก่า\n` +
              `📲 พิมพ์ "เปิดร้าน" → รับลิงก์ใหม่\n\n` +
              `ถ้ามีคำถาม พิมพ์มาได้เลย — ร้านจะตอบในแชทค่ะ 💬`
      }]);
      continue;
    }

    // ข้อความอื่นๆ: forward ไปแอดมิน + บันทึกในแชท (ถ้าผูกบัญชีแล้ว)
    // ✨ กรอง ghost order (LINE-xxx) ออก — นับเฉพาะออเดอร์จริงที่ลูกค้าสั่งของแล้ว
    const { data: linkedOrders } = await supabase.from('orders')
      .select('order_id, customer_id, customer_name')
      .eq('line_user_id', userId)
      .not('order_id', 'like', 'LINE-%')
      .order('created_at', { ascending: false })
      .limit(1);

    const latest = linkedOrders?.[0];

    // ดึงโปรไฟล์ LINE มาดูชื่อ (ถ้าไม่ได้ผูกบัญชี)
    let displayName = latest?.customer_name || 'ลูกค้า LINE';
    if (!latest) {
      try {
        const profRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
          headers: { 'Authorization': `Bearer ${process.env.LINE_TOKEN}` }
        });
        if (profRes.ok) {
          const profile = await profRes.json();
          if (profile.displayName) displayName = profile.displayName;
        }
      } catch(e) { /* ignore */ }
    }

    // บันทึกข้อความลูกค้าลง messages
    // - ถ้ามีออเดอร์: ผูกกับ order_id ล่าสุด
    // - ถ้าไม่มี: ใช้ thread_id แบบ LINE-{userId} เพื่อให้ admin ยังเห็นได้
    const threadOrderId = latest?.order_id || `LINE-${userId.slice(0,16)}`;
    const threadCustomerId = latest?.customer_id || `LINE-${userId.slice(0,16)}`;

    await supabase.from('messages').insert([{
      order_id   : threadOrderId,
      customer_id: threadCustomerId,
      sender     : 'customer',
      text       : rawText,
      created_at : new Date().toISOString()
    }]).then(({ error }) => { if (error) console.warn('insert msg:', error.message); });

    // ถ้ายังไม่มีออเดอร์ → สร้าง "ghost order" เพื่อให้แสดงในแอดมิน panel
    if (!latest) {
      await supabase.from('orders').upsert([{
        order_id     : threadOrderId,
        customer_id  : threadCustomerId,
        customer_name: displayName,
        line_user_id : userId,
        items        : [],
        total        : 0,
        status       : 'pending',
        created_at   : new Date().toISOString(),
        note         : '💬 แชทเข้ามาทาง LINE OA (ยังไม่มีออเดอร์)'
      }], { onConflict: 'order_id' }).then(({ error }) => {
        if (error) console.warn('upsert ghost order:', error.message);
      });
    }

    // ✨ แจ้งแอดมินเฉพาะลูกค้าที่มีออเดอร์จริง + ไม่ใช่ keyword auto-reply
    if (latest) {
      // ถ้าตรงกับ keyword auto-reply ของ LINE OA → ไม่แจ้ง (LINE OA ตอบให้แล้ว)
      if (isAutoReplyKeyword(rawText)) {
        console.log(`💬 ${displayName} ส่ง "${rawText.slice(0,30)}" ตรงกับ auto-reply keyword — ไม่แจ้งแอดมิน`);
      } else {
        const notifyText = `💬 ${displayName} ส่งข้อความใน LINE (#${latest.order_id}):\n\n${rawText.slice(0,500)}`;
        notifyAllAdmins([{ type:'text', text: notifyText }]).catch(console.error);
      }
    } else {
      console.log(`💬 ${displayName} ทักเข้ามาใน LINE (ยังไม่มีออเดอร์) — ไม่แจ้งแอดมิน`);
    }

    // ✨ ไม่ตอบ auto-reply — ปล่อยให้แอดมินตอบเอง ลูกค้าจะไม่เห็น "ได้รับข้อความแล้ว..." spam
    // (ถ้าลูกค้าอยากเปิดร้าน/ดูออเดอร์ → กด Rich Menu หรือพิมพ์ keyword)
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

    // 2) ส่ง LINE Flex Message หาลูกค้า
    if (process.env.LINE_TOKEN) {
      // ใช้ line_user_id โดยตรงจาก order ก่อน — fallback ไปหาจาก customer_id
      let targetUid = data.line_user_id;
      if (!targetUid) {
        targetUid = await findLineUserIdByCustomer(data.customer_id);
      }
      if (targetUid) {
        const flex = buildStatusUpdateFlex(data, status);
        linePush(targetUid, [flex])
          .then(() => console.log(`📤 status flex → ${targetUid.slice(0,12)}…`))
          .catch(e => console.warn('LINE flex push failed:', e.message));
      }
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

// ═══════════════════════════════════════════════════════════
//  RIDER SYSTEM — Phase 1
// ═══════════════════════════════════════════════════════════

// ─── สร้าง ID ให้ rider ─────────────────────────────────
function genRiderId() {
  return 'RID-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ─── Rider linkTokens (เหมือน customer link tokens) ─────
const riderLinkTokens = new Map();

function createRiderLinkToken(riderId) {
  const token = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
  riderLinkTokens.set(token, { riderId, expiresAt: Date.now() + 30*60*1000 });
  // cleanup expired
  for (const [k, v] of riderLinkTokens.entries()) {
    if (v.expiresAt < Date.now()) riderLinkTokens.delete(k);
  }
  return token;
}

// ─── สร้าง Flex Message งานใหม่สำหรับไรเดอร์ ─────────────
function buildRiderJobFlex(order, riderUrl) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemSummary = items.length 
    ? items.slice(0, 3).map(i => `• ${i.name || ''} ×${i.qty || 1}`).join('\n') +
      (items.length > 3 ? `\n• และอีก ${items.length - 3} รายการ` : '')
    : '—';
  
  return {
    type: 'flex',
    altText: `🆕 งานใหม่ — ${order.customer_name || ''}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#FF6B35',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🆕 งานใหม่!', color: '#ffffff', size: 'xl', weight: 'bold' },
          { type: 'text', text: `#${order.order_id}`, color: '#ffffff', size: 'sm' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: `👤 ${order.customer_name || '-'}`, weight: 'bold', size: 'md' },
          { type: 'text', text: `📞 ${order.phone || '-'}`, size: 'sm', color: '#666666' },
          ...(order.address ? [
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: '📍 จัดส่งที่:', size: 'xs', color: '#888888', margin: 'sm' },
            { type: 'text', text: String(order.address).slice(0, 100), size: 'sm', wrap: true }
          ] : []),
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '📦 รายการ:', size: 'xs', color: '#888888', margin: 'sm' },
          { type: 'text', text: itemSummary, size: 'sm', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm', contents: [
            { type: 'text', text: 'ยอดรวม', size: 'sm', color: '#666666', flex: 0 },
            { type: 'text', text: `฿${(order.total || 0).toLocaleString()}`, size: 'lg', weight: 'bold', color: '#C0392B', align: 'end' }
          ]}
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg',
        contents: [
          { type: 'button', style: 'primary', color: '#27AE60', height: 'sm',
            action: { type: 'uri', label: '✅ รับงานนี้', uri: `${riderUrl}#accept=${order.order_id}` }},
          { type: 'text', text: 'กดด่วน! ใครรับก่อน ได้ก่อน', size: 'xs', color: '#888888', align: 'center', margin: 'sm' }
        ]
      }
    }
  };
}

// ─── ส่ง Flex แจ้งงานให้ไรเดอร์ทั้งหมด (ที่ออนไลน์) ─────
async function offerJobToRiders(orderId) {
  const { data: order, error: oErr } = await supabase
    .from('orders').select('*').eq('order_id', orderId).single();
  if (oErr || !order) return { sent: 0, error: 'order not found' };
  
  if (order.rider_id) return { sent: 0, error: 'already assigned' };
  if (String(order.order_id).startsWith('LINE-')) return { sent: 0, error: 'ghost order' };
  
  // หา riders ที่: active + มี line_user_id + ไม่มีงานค้าง (status != 'busy')
  const { data: riders } = await supabase
    .from('riders')
    .select('id, name, line_user_id, status')
    .eq('is_active', true)
    .neq('status', 'busy')
    .not('line_user_id', 'is', null);
  
  if (!riders?.length) {
    console.warn(`[rider] no available riders for #${orderId}`);
    return { sent: 0, error: 'no available riders' };
  }
  
  // บันทึก offer ในตาราง
  const offers = riders.map(r => ({
    order_id: orderId, rider_id: r.id, status: 'pending'
  }));
  await supabase.from('rider_offers').upsert(offers, { onConflict: 'order_id,rider_id' });
  
  // ส่ง Flex ให้ทุกคน
  const riderUrl = `${SHOP_URL}rider.html`;
  const flex = buildRiderJobFlex(order, riderUrl);
  
  let sent = 0;
  for (const r of riders) {
    try {
      await linePush(r.line_user_id, [flex]);
      sent++;
    } catch (e) {
      console.error(`[rider] push to ${r.id} failed:`, e.message);
    }
  }
  
  console.log(`[rider] offered #${orderId} to ${sent}/${riders.length} riders`);
  return { sent, total: riders.length };
}

// ─── Endpoint: GET rider info by token ─────────────────
app.get('/rider/me', async (req, res) => {
  const { token, lid } = req.query;
  
  let riderId = null;
  
  // ผ่าน token (จากลิงก์ใน LINE)
  if (token) {
    const t = riderLinkTokens.get(String(token));
    if (t && t.expiresAt > Date.now()) {
      riderId = t.riderId;
    }
  }
  
  // ผ่าน line_user_id
  if (!riderId && lid) {
    const { data } = await supabase.from('riders')
      .select('id').eq('line_user_id', String(lid)).single();
    if (data) riderId = data.id;
  }
  
  if (!riderId) return res.status(401).json({ error: 'unauthorized' });
  
  const { data: rider, error } = await supabase.from('riders')
    .select('*').eq('id', riderId).single();
  if (error || !rider) return res.status(404).json({ error: 'rider not found' });
  
  // อัปเดต last_seen
  await supabase.from('riders')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', riderId);
  
  res.json({ rider });
});

// ─── Endpoint: GET งานที่เปิดให้รับ (offers) ─────────────
app.get('/rider/:riderId/offers', async (req, res) => {
  const riderId = req.params.riderId;
  
  // หา offers pending ของ rider นี้
  const { data: offers } = await supabase.from('rider_offers')
    .select('order_id, offered_at, status')
    .eq('rider_id', riderId)
    .eq('status', 'pending')
    .order('offered_at', { ascending: false });
  
  if (!offers?.length) return res.json({ offers: [] });
  
  const orderIds = offers.map(o => o.order_id);
  const { data: orders } = await supabase.from('orders')
    .select('order_id, customer_name, phone, address, items, total, note, order_type')
    .in('order_id', orderIds)
    .is('rider_id', null);  // เฉพาะที่ยังไม่มีคนรับ
  
  const result = (orders || []).map(o => {
    const offer = offers.find(x => x.order_id === o.order_id);
    return { ...o, offered_at: offer?.offered_at };
  });
  
  res.json({ offers: result });
});

// ─── Endpoint: GET งานที่กำลังทำของ rider ─────────────
app.get('/rider/:riderId/active', async (req, res) => {
  const riderId = req.params.riderId;
  const { data: orders } = await supabase.from('orders')
    .select('*')
    .eq('rider_id', riderId)
    .in('status', ['shipped'])
    .order('rider_assigned_at', { ascending: false });
  res.json({ orders: orders || [] });
});

// ─── Endpoint: GET ประวัติงานเสร็จของ rider ─────────────
app.get('/rider/:riderId/history', async (req, res) => {
  const riderId = req.params.riderId;
  const { data: orders } = await supabase.from('orders')
    .select('order_id, customer_name, total, rider_delivered_at, status')
    .eq('rider_id', riderId)
    .in('status', ['done', 'cancelled', 'failed'])
    .order('rider_delivered_at', { ascending: false })
    .limit(50);
  res.json({ orders: orders || [] });
});

// ─── Endpoint: รับงาน (atomic ผ่าน RPC) ───────────────
app.post('/rider/:riderId/accept/:orderId', async (req, res) => {
  const { riderId, orderId } = req.params;
  
  const { data, error } = await supabase.rpc('accept_rider_job', {
    p_order_id: orderId, p_rider_id: riderId
  });
  
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data?.success) return res.status(409).json(data);
  
  // ดึงข้อมูล order + rider
  const [{ data: order }, { data: rider }] = await Promise.all([
    supabase.from('orders').select('*').eq('order_id', orderId).single(),
    supabase.from('riders').select('*').eq('id', riderId).single()
  ]);
  
  // แจ้งลูกค้า: ไรเดอร์รับงานแล้ว
  if (order?.line_user_id) {
    const txt = `🏍️ ไรเดอร์รับงานของคุณแล้ว!\n\n` +
                `👤 ${rider.name}\n` +
                `🚗 ${rider.vehicle || 'มอเตอร์ไซค์'}${rider.vehicle_plate ? ` (${rider.vehicle_plate})` : ''}\n` +
                `📞 ${rider.phone || '-'}\n\n` +
                `📦 ออเดอร์ #${orderId}`;
    linePush(order.line_user_id, [{ type: 'text', text: txt }]).catch(console.error);
  }
  
  // แจ้งแอดมิน
  notifyAllAdmins([{ 
    type: 'text', 
    text: `✅ ไรเดอร์ ${rider.name} รับงาน #${orderId} แล้ว` 
  }]).catch(console.error);
  
  res.json({ success: true, order });
});

// ─── Endpoint: เสร็จงาน ────────────────────────────────
app.post('/rider/:riderId/complete/:orderId', async (req, res) => {
  const { riderId, orderId } = req.params;
  
  const { data, error } = await supabase.rpc('complete_rider_job', {
    p_order_id: orderId, p_rider_id: riderId
  });
  if (error) return res.status(500).json({ success: false, error: error.message });
  
  // แจ้งลูกค้า
  const { data: order } = await supabase.from('orders')
    .select('line_user_id, customer_name').eq('order_id', orderId).single();
  
  if (order?.line_user_id) {
    linePush(order.line_user_id, [{
      type: 'text',
      text: `🎉 ออเดอร์ #${orderId} ส่งสำเร็จแล้ว!\n\nขอบคุณที่ใช้บริการ ❤️\n\nหากมีปัญหาใดๆ ทักแอดมินได้เลยค่ะ`
    }]).catch(console.error);
  }
  
  // แจ้งแอดมิน
  const { data: rider } = await supabase.from('riders').select('name').eq('id', riderId).single();
  notifyAllAdmins([{
    type: 'text',
    text: `🎉 ${rider?.name || riderId} ส่งสำเร็จ #${orderId}`
  }]).catch(console.error);
  
  res.json({ success: true });
});

// ─── Endpoint: เปลี่ยนสถานะ online/offline ───────────────
app.post('/rider/:riderId/status', async (req, res) => {
  const { riderId } = req.params;
  const { status } = req.body; // 'online' | 'offline'
  if (!['online', 'offline'].includes(status))
    return res.status(400).json({ error: 'invalid status' });
  
  await supabase.from('riders')
    .update({ status, last_seen_at: new Date().toISOString() })
    .eq('id', riderId);
  res.json({ success: true });
});

// ─── ADMIN: รายชื่อไรเดอร์ทั้งหมด ────────────────────────
app.get('/admin/riders', async (req, res) => {
  const { data, error } = await supabase.from('riders')
    .select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ riders: data || [] });
});

// ─── ADMIN: เพิ่มไรเดอร์ใหม่ + ส่งลิงก์ผูกบัญชี ────────
app.post('/admin/rider', async (req, res) => {
  const { name, phone, vehicle, vehicle_plate, line_user_id, note } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  
  const id = genRiderId();
  const { error } = await supabase.from('riders').insert([{
    id, name, phone: phone || null, vehicle: vehicle || 'มอเตอร์ไซค์',
    vehicle_plate: vehicle_plate || null,
    line_user_id: line_user_id || null,
    note: note || null
  }]);
  if (error) return res.status(500).json({ error: error.message });
  
  // ถ้ามี line_user_id → ส่งลิงก์ rider.html ที่ผูก token แล้ว
  if (line_user_id) {
    const token = createRiderLinkToken(id);
    const link = `${SHOP_URL}rider.html?token=${token}`;
    linePush(line_user_id, [
      { type: 'text', text: `🏍️ ยินดีต้อนรับสู่ทีมไรเดอร์!\n\n👤 ${name}\n🆔 ${id}\n\nกดลิงก์ด้านล่างเพื่อเปิดแอปไรเดอร์ — ระบบจะจดจำคุณอัตโนมัติ` },
      { type: 'text', text: link }
    ]).catch(console.error);
  }
  
  res.json({ success: true, id });
});

// ─── ADMIN: แก้ไขไรเดอร์ ────────────────────────────────
app.put('/admin/rider/:riderId', async (req, res) => {
  const { riderId } = req.params;
  const updates = {};
  ['name', 'phone', 'vehicle', 'vehicle_plate', 'line_user_id', 'is_active', 'note']
    .forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  
  const { error } = await supabase.from('riders').update(updates).eq('id', riderId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ADMIN: ลบไรเดอร์ ──────────────────────────────────
app.delete('/admin/rider/:riderId', async (req, res) => {
  const { riderId } = req.params;
  const { error } = await supabase.from('riders').delete().eq('id', riderId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ADMIN: เสนองานให้ไรเดอร์ทั้งหมด (auto-assign) ────
app.post('/admin/offer-job/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const result = await offerJobToRiders(orderId);
  res.json(result);
});

// ─── ADMIN: assign โดยตรง (ข้าม auto-assign) ───────────
app.post('/admin/assign-rider/:orderId/:riderId', async (req, res) => {
  const { orderId, riderId } = req.params;
  
  const { data, error } = await supabase.rpc('accept_rider_job', {
    p_order_id: orderId, p_rider_id: riderId
  });
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data?.success) return res.status(409).json(data);
  
  // ดึง rider + order ส่ง Flex
  const [{ data: order }, { data: rider }] = await Promise.all([
    supabase.from('orders').select('*').eq('order_id', orderId).single(),
    supabase.from('riders').select('*').eq('id', riderId).single()
  ]);
  
  // แจ้ง rider
  if (rider?.line_user_id) {
    const riderUrl = `${SHOP_URL}rider.html`;
    const flex = buildRiderJobFlex(order, riderUrl);
    linePush(rider.line_user_id, [
      { type: 'text', text: `🎯 แอดมินมอบหมายงานนี้ให้คุณ` },
      flex
    ]).catch(console.error);
  }
  
  // แจ้งลูกค้า
  if (order?.line_user_id) {
    linePush(order.line_user_id, [{
      type: 'text',
      text: `🏍️ ไรเดอร์ ${rider.name} รับงานของคุณแล้ว!\n📞 ${rider.phone || '-'}\n#${orderId}`
    }]).catch(console.error);
  }
  
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
//  END RIDER SYSTEM
// ═══════════════════════════════════════════════════════════

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
