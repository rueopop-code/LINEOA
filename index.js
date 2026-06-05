require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
// CORS — รองรับ preflight (OPTIONS) จาก GitHub Pages และทุก domain
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors()); // preflight สำหรับทุก route
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
  // รวมทั้ง ADMIN_LINE_UIDS และ ADMIN_LINE_UID เข้าด้วยกัน (ไม่ใช่ OR)
  const fromPlural   = process.env.ADMIN_LINE_UIDS || '';
  const fromSingular = process.env.ADMIN_LINE_UID  || '';
  const combined = [fromPlural, fromSingular].filter(Boolean).join(',');
  // deduplicate — กรณีใส่ UID เดียวกันใน 2 ตัวแปร
  return [...new Set(combined.split(',').map(s => s.trim()).filter(Boolean))];
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
// safeReply: ลอง lineReply ก่อน ถ้า token หมดอายุ (Render cold start) → fallback linePush
async function safeReply(replyToken, userId, messages) {
  try {
    await lineReply(replyToken, messages);
  } catch (e) {
    console.warn('lineReply failed → fallback push:', e.message);
    if (userId) {
      await linePush(userId, messages).catch(e2 =>
        console.warn('push fallback failed:', e2.message)
      );
    }
  }
}

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

// ── Shop Hours Message Helper ────────────────────────────────
async function shGetHoursMsg() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key','shop_hours').maybeSingle();
    if (!data || !data.value || !data.value.enabled) return '';
    const cfg = data.value;
    // แปลงเวลาเป็น Asia/Bangkok เสมอ (server อาจรัน UTC)
    const bkkStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' });
    const now = new Date(bkkStr);
    const day = now.getDay();
    const openDays = cfg.openDays || [];
    const [oh,om] = (cfg.openTime||'09:00').split(':').map(Number);
    const [ch,cm] = (cfg.closeTime||'18:00').split(':').map(Number);
    const nowMins = now.getHours()*60+now.getMinutes();
    const isOpen = openDays.includes(day) && nowMins >= oh*60+om && nowMins < ch*60+cm;
    // ถ้าร้านเปิดปกติ ไม่ต้องส่งข้อความอะไรเลย
    if (isOpen) return '';
    const msg = cfg.msgClosed || '';
    if (!msg) return '';
    return '\n\n🔴 ' + msg;
  } catch(e) { return ''; }
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

async function buildAdminMsg(order) {
  const { customer_name, items, total, order_id, created_at, phone, address, note,
          coupon_code, discount_amount, ref_code } = order;
  const date = new Date(created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short', timeZone:'Asia/Bangkok' });
  let msg = `🛒 ออเดอร์ใหม่! #${order_id}\n`;
  msg += `${'─'.repeat(24)}\n`;
  msg += `👤 ${customer_name}\n`;
  if (phone)   msg += `📞 ${phone}\n`;
  if (address) msg += `📍 ${address}\n`;
  msg += `📅 ${date}\n`;
  if (ref_code) msg += `🎁 ชวนเพื่อน (${ref_code})\n`;
  msg += `${'─'.repeat(24)}\n`;
  (items || []).forEach(i => {
    msg += `${i.emoji || '•'} ${i.name}\n`;
    msg += `   ${i.qty} × ฿${i.price.toLocaleString()} = ฿${(i.qty * i.price).toLocaleString()}\n`;
  });
  msg += `${'─'.repeat(24)}\n`;
  const disc = Number(discount_amount) || 0;
  if (disc > 0) {
    const subtotal = total + disc;
    msg += `💲 ราคาก่อนลด: ฿${subtotal.toLocaleString()}\n`;
    msg += `🎟️ ${coupon_code ? `คูปอง [${coupon_code}]` : 'ส่วนลด'}: -฿${disc.toLocaleString()}\n`;
  }
  msg += `💰 ยอดสุทธิ: ฿${total.toLocaleString()}\n`;
  if (note) msg += `\n📝 ${note}\n`;
  msg += `\n📲 ติดต่อลูกค้าผ่านหน้า Admin Panel ได้เลยค่ะ`;
  msg += await shGetHoursMsg();
  return msg;
}

// ─── LINE Flex Message Builders ───────────────────────────
const SHOP_URL = process.env.SHOP_URL || 'https://lineoa-u0v2.onrender.com/';

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
async function buildOrderSummaryFlex(order) {
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
          // 🎟️ แสดงส่วนลดคูปอง (ถ้ามี)
          ...(() => {
            const discount = safeNum(order.discount_amount);
            const code     = order.coupon_code;
            if (!code || discount <= 0) return [];
            const subtotal = total + discount;
            return [
              { type:'box', layout:'horizontal', margin:'md',
                contents:[
                  { type:'text', text:'ราคาก่อนลด', size:'sm', color:'#888888', flex:1 },
                  { type:'text', text:`฿${subtotal.toLocaleString()}`, size:'sm', color:'#888888', align:'end' }
                ]
              },
              { type:'box', layout:'horizontal', margin:'xs',
                contents:[
                  { type:'text', text:`🎟️ คูปอง [${code}]`, size:'sm', color:'#e8593c', flex:1 },
                  { type:'text', text:`-฿${discount.toLocaleString()}`, size:'sm', color:'#e8593c', weight:'bold', align:'end' }
                ]
              },
              { type:'separator', margin:'sm' }
            ];
          })(),
          { type:'box', layout:'horizontal', margin:'md',
            contents:[
              { type:'text', text:'ยอดสุทธิ', size:'md', color:'#333333', flex:1 },
              { type:'text', text:`฿${total.toLocaleString()}`, size:'lg', color:'#C0392B', weight:'bold', align:'end' }
            ]
          },
          { type:'text', text:'⏳ ร้านกำลังตรวจสอบและจะแจ้งให้ทราบเร็วๆ นี้', size:'xs', color:'#888888', wrap:true, margin:'lg', align:'center' },
          ...await (async () => {
            try {
              const { data } = await supabase.from('settings').select('value').eq('key','shop_hours').maybeSingle();
              if (!data || !data.value || !data.value.enabled) return [];
              const cfg = data.value;
              const bkkStr2 = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' });
              const now = new Date(bkkStr2);
              const day = now.getDay();
              const openDays = cfg.openDays || [];
              const [oh,om] = (cfg.openTime||'09:00').split(':').map(Number);
              const [ch,cm] = (cfg.closeTime||'18:00').split(':').map(Number);
              const nowMins = now.getHours()*60+now.getMinutes();
              const isOpen = openDays.includes(day) && nowMins >= oh*60+om && nowMins < ch*60+cm;
              // ถ้าร้านเปิดปกติ ไม่ต้องแสดง block แจ้งสถานะ
              if (isOpen) return [];
              const msg = cfg.msgClosed || '';
              if (!msg) return [];
              const openStr = String(oh).padStart(2,'0')+':'+String(om).padStart(2,'0');
              const closeStr = String(ch).padStart(2,'0')+':'+String(cm).padStart(2,'0');
              const daysMap = ['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'];
              const daysStr = openDays.map(d=>daysMap[d]).join(' ');
              return [
                { type:'separator', margin:'lg' },
                { type:'box', layout:'vertical', margin:'md', backgroundColor: '#fdf2f0', cornerRadius:'8px', paddingAll:'sm',
                  contents:[
                    { type:'text', text: '🔴 ร้านปิดแล้ว', size:'xs', color: '#c0392b', weight:'bold' },
                    { type:'text', text: '🕐 '+daysStr+' '+openStr+'–'+closeStr+' น.', size:'xs', color:'#888888', margin:'xs' },
                    { type:'text', text: msg, size:'xs', color:'#555555', wrap:true, margin:'xs' }
                  ]
                }
              ];
            } catch(e) { return []; }
          })()
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
async function buildStatusUpdateFlex(order, status) {
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
          { type:'text', text: lbl.desc, size:'sm', color:'#555555', wrap:true, margin:'md' },
          ...await (async () => {
            const hoursMsg = await shGetHoursMsg();
            if (!hoursMsg) return [];
            const txt = hoursMsg.replace('\n\n🔴 ','');
            return [
              { type:'separator', margin:'md' },
              { type:'text', text: '🔴 ร้านปิดแล้ว', size:'xs', color: '#c0392b', weight:'bold', margin:'md' },
              { type:'text', text: txt, size:'xs', color:'#555555', wrap:true, margin:'xs' }
            ];
          })()
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
//  📍 GPS PIN EXTRACTOR — แกะพิกัดจากข้อความ
// ═══════════════════════════════════════════════════════════

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90  && lat <= 90
    && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);            // กัน "0,0" กลางมหาสมุทร
}

/**
 * ดึงพิกัด lat/lng จากข้อความ — รองรับฟอร์แมตที่หน้าร้านเดิมส่งมา:
 *   • Google Maps URL: maps.google.com/?q=19.91,99.84
 *   • Google Maps URL: google.com/maps/search/?api=1&query=19.91,99.84
 *   • Google Maps URL: google.com/maps/dir/?api=1&destination=19.91,99.84
 *   • Google Maps path: /@19.91,99.84,17z
 *   • พิกัดดิบ: "19.910500, 99.840600"  หรือ  "พิกัด: 19.91, 99.84"
 *
 * ⚠️ ไม่รองรับ shortened URL (maps.app.goo.gl/xxx, goo.gl/maps/xxx)
 *    เพราะต้อง follow redirect — ให้หน้าร้านส่ง mapLat/mapLng แยกแทน
 */
function extractCoordsFromText(text) {
  if (!text) return null;
  const s = String(text);

  // Pattern 1: Google Maps URL (q=, query=, destination=, /@)
  const urlPatterns = [
    /[?&](?:q|query|destination|ll)=(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/i,
    /\/@(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/,
  ];
  for (const re of urlPatterns) {
    const m = s.match(re);
    if (m) {
      const lat = +m[1], lng = +m[2];
      if (isValidLatLng(lat, lng)) return { lat, lng };
    }
  }

  // Pattern 2: พิกัดดิบ "lat, lng" (ต้องมีจุดทศนิยมอย่างน้อย 3 หลัก กันสับสนกับยอดเงิน/เบอร์โทร)
  const plain = s.match(/(-?\d{1,2}\.\d{3,})\s*[,， ]\s*(-?\d{1,3}\.\d{3,})/);
  if (plain) {
    const lat = +plain[1], lng = +plain[2];
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  return null;
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
    mapLat, mapLng,             // 📍 พิกัด GPS
    couponId, discountAmount,    // 🎟️ ส่วนลด/คูปอง
    refCode                        // 🎁 referral code
  } = req.body;

  if (!customerId || !customerName || !items?.length || total == null)
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (customerId/customerName/items/total)' });

  // ── ตรวจสอบและ apply coupon ────────────────────────────
  let appliedCouponId   = null;
  let appliedCouponCode = null;
  let finalDiscount     = 0;

  if (couponId && discountAmount > 0) {
    const { data: coup } = await supabase
      .from('coupons').select('*').eq('id', couponId).eq('is_active', true).maybeSingle();
    if (coup) {
      if (!coup.usage_limit || coup.used_count < coup.usage_limit) {
        finalDiscount     = Math.min(Number(discountAmount), total);
        appliedCouponId   = coup.id;
        appliedCouponCode = coup.code;
        await supabase.from('coupons')
          .update({ used_count: (coup.used_count || 0) + 1 })
          .eq('id', coup.id);
      }
    }
  }

  const finalTotal = Math.max(0, total - finalDiscount);

  // ── parse + validate พิกัด GPS ──
  // 1) ลองรับจาก mapLat/mapLng ก่อน (ทางที่ดีที่สุด — ส่งแยกฟิลด์)
  // 2) ถ้าไม่มี → auto-extract จาก note/extra/address (รองรับฟอร์แมตเดิมที่ฝังใน text)
  let lat = Number(mapLat);
  let lng = Number(mapLng);
  let hasValidPin = isValidLatLng(lat, lng);

  if (!hasValidPin) {
    const haystack = `${note || ''}\n${extra || ''}\n${address || ''}`;
    const found = extractCoordsFromText(haystack);
    if (found) {
      lat = found.lat;
      lng = found.lng;
      hasValidPin = true;
      console.log(`📍 auto-extracted pin from text: ${lat},${lng}`);
    }
  }

  const order_id   = genOrderId();
  const created_at = new Date().toISOString();
  const order      = {
    order_id, customer_id: customerId,
    customer_name: customerName,             // ชื่อจริง — สำหรับจ่าหน้าพัสดุ
    line_name: lineName || customerName,     // ✨ ชื่อ LINE — สำหรับผูกแชท
    phone: phone || null, address: address || null, note: note || extra || null,
    items, total: finalTotal, status: 'pending', created_at,
    order_type: orderType || 'pickup',
    // 📍 บันทึกพิกัดจัดส่ง (ถ้ามี) — ให้หน้าแอดมินเห็นปุ่มแผนที่
    map_lat: hasValidPin ? lat : null,
    map_lng: hasValidPin ? lng : null,
    // 🎟️ ส่วนลด
    coupon_id: appliedCouponId,
    coupon_code: appliedCouponCode,
    discount_amount: finalDiscount
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
    (finalDiscount > 0 ? `\n🎟️ ส่วนลด: -฿${finalDiscount.toLocaleString()}` : '') +
    `\n\n💰 ยอดรวม: ฿${finalTotal.toLocaleString()}\n` +
    `\nร้านจะยืนยันและแจ้งสถานะให้ทราบเร็วๆ นี้ค่ะ 🙏` +
    await (async () => {
      try {
        const { data } = await supabase.from('settings').select('value').eq('key','shop_hours').maybeSingle();
        if (!data || !data.value || !data.value.enabled) return '';
        const cfg = data.value;
        const bkkStr3 = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' });
        const now = new Date(bkkStr3);
        const day = now.getDay();
        const openDays = cfg.openDays || [];
        const [oh,om] = (cfg.openTime||'09:00').split(':').map(Number);
        const [ch,cm] = (cfg.closeTime||'18:00').split(':').map(Number);
        const nowMins = now.getHours()*60+now.getMinutes();
        const isOpen = openDays.includes(day) && nowMins >= oh*60+om && nowMins < ch*60+cm;
        // ถ้าร้านเปิดปกติ ไม่ต้องส่งข้อความแจ้ง
        if (isOpen) return '';
        const msg = cfg.msgClosed || '';
        if (!msg) return '';
        return '\n\n🔴 ' + msg;
      } catch(e) { return ''; }
    })();

  await supabase.from('messages').insert([{
    order_id, customer_id: customerId,
    sender: 'system', text: summaryMsg,
    created_at: new Date().toISOString()
  }]).then(({ error }) => {
    if (error) console.warn('insert summary msg:', error.message);
  });

  // ✨ Auto-link: ผูก line_user_id ให้ออเดอร์ใหม่อัตโนมัติ — 3 วิธีเรียงตามความแม่นยำ
  let autoLinkedLineUid = null;
  try {
    const normPhone = (p) => String(p || '').replace(/\D/g, '');
    const norm = (s) => String(s || '').trim().toLowerCase();
    const myPhone = normPhone(phone);

    // ── วิธีที่ 0 (เร็วและแม่นที่สุด): ค้น LINK-{customerId} row โดยตรง ──
    // /link-line สร้าง row นี้ทันทีที่ลูกค้าเปิดร้านผ่านลิงก์ LINE
    // ไม่ต้องเดา ไม่ต้อง match ชื่อ/phone เลย
    if (!autoLinkedLineUid) {
      const linkRowId = `LINK-${customerId.slice(0, 20)}`;
      const { data: linkRow } = await supabase.from('orders')
        .select('line_user_id')
        .eq('order_id', linkRowId)
        .not('line_user_id', 'is', null)
        .maybeSingle();
      if (linkRow?.line_user_id) {
        autoLinkedLineUid = linkRow.line_user_id;
        console.log(`🔗 auto-linked via LINK- row: ${linkRowId}`);
      }
    }

    // ── วิธีที่ 1: ค้นจาก line_users.customer_id ──
    // บันทึกตอนลูกค้าเปิดร้านผ่านลิงก์ LINE → ผูกได้ทันทีโดยไม่ต้องเดา
    if (!autoLinkedLineUid) {
      const { data: luRow } = await supabase.from('line_users')
        .select('user_id')
        .eq('customer_id', customerId)
        .order('last_seen', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (luRow?.user_id) {
        autoLinkedLineUid = luRow.user_id;
        console.log(`🔗 auto-linked via line_users.customer_id: ${customerId}`);
      }
    }

    // ── วิธีที่ 2: ค้นจาก ghost orders (LINE-% / LINK-%) ด้วย phone + ชื่อ ──
    if (!autoLinkedLineUid) {
      const { data: ghostOrders } = await supabase.from('orders')
        .select('order_id, line_user_id, customer_name, line_name, phone')
        .or('order_id.like.LINE-%,order_id.like.LINK-%')
        .not('line_user_id', 'is', null);

      if (ghostOrders?.length) {
        const myLineName = norm(lineName);
        const myCustName = norm(customerName);
        const matched = ghostOrders.find(g => {
          const gLine = norm(g.line_name);
          const gCust = norm(g.customer_name);
          return (myPhone && normPhone(g.phone) === myPhone) ||
                 (myLineName && gLine && gLine === myLineName) ||
                 (myLineName && gCust && gCust === myLineName) ||
                 (myCustName && gCust && gCust === myCustName);
        });
        if (matched?.line_user_id) {
          autoLinkedLineUid = matched.line_user_id;
          console.log(`🔗 auto-linked via ghost order match: ${matched.order_id}`);
        }
      }
    }

    // ── วิธีที่ 3: ค้นจาก line_users ด้วยเบอร์โทร (ถ้ามี phone column) ──
    if (!autoLinkedLineUid && myPhone) {
      const { data: luPhone } = await supabase.from('line_users')
        .select('user_id')
        .eq('phone', myPhone)
        .order('last_seen', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (luPhone?.user_id) {
        autoLinkedLineUid = luPhone.user_id;
        console.log(`🔗 auto-linked via line_users.phone: ${myPhone}`);
      }
    }

    // ── วิธีที่ 4: ค้นจากออเดอร์เก่าของ customer_id เดียวกัน ──
    // กรณีลูกค้าสั่งซ้ำ — ออเดอร์แรกผูก LINE แล้ว ออเดอร์ถัดไปควรได้ใช้ตาม
    if (!autoLinkedLineUid) {
      const { data: prevOrder } = await supabase.from('orders')
        .select('line_user_id')
        .eq('customer_id', customerId)
        .not('line_user_id', 'is', null)
        .not('order_id', 'like', 'LINE-%')
        .not('order_id', 'like', 'LINK-%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prevOrder?.line_user_id) {
        autoLinkedLineUid = prevOrder.line_user_id;
        console.log(`🔗 auto-linked via previous order of customer: ${customerId}`);
      }
    }

    // ── ผูกสำเร็จ → อัปเดต orders + line_users ──
    if (autoLinkedLineUid) {
      await supabase.from('orders')
        .update({ line_user_id: autoLinkedLineUid })
        .eq('customer_id', customerId)
        .then(({ error }) => { if (!error) console.log(`✅ ${customerId} ↔ LINE ${autoLinkedLineUid.slice(0,12)}…`); });

      // อัปเดต line_users ให้มี customer_id (เพื่อ match ได้เร็วขึ้นครั้งถัดไป)
      await supabase.from('line_users')
        .update({ customer_id: customerId })
        .eq('user_id', autoLinkedLineUid)
        .then(null, () => {});
    }
  } catch (e) {
    console.warn('auto-link failed:', e.message);
  }

  // แจ้งแอดมินทุกคนผ่าน LINE OA
  if (process.env.LINE_TOKEN) {
    try {
      const { sent } = await notifyAllAdmins([{ type: 'text', text: await buildAdminMsg(order) }]);
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
      const flex = await buildOrderSummaryFlex({ ...order, status: 'sent' });
      linePush(customerLineUid, [flex])
        .then(() => console.log(`📤 order summary → ${customerLineUid.slice(0,12)}…`))
        .catch(e => console.warn('LINE flex to customer failed:', e.message));
    } else {
      console.log(`ℹ️ ${order_id} ลูกค้ายังไม่ได้ผูกบัญชี LINE — จะส่ง flex หลังผูกบัญชี`);
    }
  }

  // ✨ ลบ LINK- ghost row — ออเดอร์จริงมี line_user_id แล้ว ไม่ต้องการ mapping row อีกต่อไป
  supabase.from('orders')
    .delete()
    .eq('order_id', `LINK-${customerId.slice(0, 20)}`)
    .then(({ error: e }) => {
      if (!e) console.log(`🗑️ cleaned up LINK-${customerId.slice(0,10)}… ghost`);
    });

  // ── 🎁 Referral Reward ─────────────────────────────────
  // ถ้ามี refCode และนี่คือออเดอร์แรกของลูกค้า → ให้คูปองกับคนชวน
  if (refCode) {
    try {
      // ตรวจว่าเป็นออเดอร์แรกของลูกค้านี้ไหม (ไม่นับ ghost orders)
      const { data: prevOrders } = await supabase
        .from('orders').select('id').eq('customer_id', customerId)
        .not('order_id', 'like', 'LINE-%').not('order_id', 'like', 'LINK-%')
        .neq('order_id', order_id).limit(1);

      const isFirstOrder = !prevOrders?.length;

      if (isFirstOrder) {
        // หา referral owner
        const { data: ref } = await supabase
          .from('referrals').select('id, customer_id').eq('ref_code', refCode).maybeSingle();

        if (ref && ref.customer_id !== customerId) {
          // ตรวจว่าคนชวนนี้เคยได้ reward จากคนนี้ยังไม่ได้ (ป้องกัน duplicate)
          const { data: existingReward } = await supabase
            .from('referral_rewards').select('id')
            .eq('referral_id', ref.id).eq('order_id', order_id).maybeSingle();

          if (!existingReward) {
            // อ่าน referral config
            const { data: cfgRow } = await supabase
              .from('settings').select('value').eq('key', 'referral_config').maybeSingle();
            const cfg = cfgRow?.value || {};
            const rewardType  = cfg.referral_reward_type  || 'fixed';
            const rewardValue = parseFloat(cfg.referral_reward_value) || 50;
            const expireDays  = parseInt(cfg.referral_expire_days)    || 30;
            const maxRewards  = parseInt(cfg.referral_max_rewards)    || 0;

            // ตรวจ max_rewards ต่อคนชวน
            let canReward = true;
            if (maxRewards > 0) {
              const { count } = await supabase
                .from('referral_rewards').select('id', { count: 'exact', head: true })
                .eq('referral_id', ref.id);
              if ((count || 0) >= maxRewards) canReward = false;
            }

            if (canReward) {
              // สร้างคูปองสำหรับคนชวน
              const expireDate = new Date();
              expireDate.setDate(expireDate.getDate() + expireDays);
              const cpnCode = 'RWD-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' +
                              Math.random().toString(36).slice(2,6).toUpperCase();

              const { data: newCoupon } = await supabase
                .from('coupons')
                .insert({
                  name:           'รางวัลชวนเพื่อน',
                  description:    'ขอบคุณที่แนะนำเพื่อนมาซื้อ! ใช้ได้ครั้งเดียว',
                  discount_type:  rewardType,
                  discount_value: rewardValue,
                  apply_type:     'manual',
                  code:           cpnCode,
                  usage_limit:    1,
                  used_count:     0,
                  end_date:       expireDate.toISOString(),
                  is_active:      true,
                  is_secret:      false,
                  condition_type: null,
                  min_order:      0
                })
                .select('id,code').single();

              if (newCoupon) {
                // บันทึก referral_reward
                await supabase.from('referral_rewards').insert({
                  referral_id: ref.id,
                  order_id:    order_id,
                  coupon_id:   newCoupon.id
                });

                // แจ้งเตือนคนชวนผ่าน LINE (ถ้ามี LINE UID)
                if (process.env.LINE_TOKEN) {
                  let refLineUid = null;

                  // [1] ค้นจาก line_users.customer_id (ตรงที่สุด)
                  const { data: refUser } = await supabase
                    .from('line_users').select('user_id')
                    .eq('customer_id', ref.customer_id).maybeSingle()
                    .catch(() => ({ data: null }));
                  refLineUid = refUser?.user_id || null;
                  console.log(`🔍 [referral] line_users lookup → ${refLineUid || 'ไม่พบ'}`);

                  // [2] fallback: orders.line_user_id ที่ผูกไว้แล้ว
                  if (!refLineUid) {
                    const { data: refOrder } = await supabase
                      .from('orders').select('line_user_id')
                      .eq('customer_id', ref.customer_id)
                      .not('line_user_id', 'is', null).limit(1)
                      .maybeSingle();
                    refLineUid = refOrder?.line_user_id || null;
                    console.log(`🔍 [referral] orders lookup → ${refLineUid || 'ไม่พบ'}`);
                  }

                  // [3] fallback: ค้นจาก line_users ผ่าน customer_name ของ A
                  if (!refLineUid) {
                    const { data: refAnyOrder } = await supabase
                      .from('orders').select('customer_name, line_name')
                      .eq('customer_id', ref.customer_id).limit(1).maybeSingle();
                    const refName = refAnyOrder?.line_name || refAnyOrder?.customer_name;
                    if (refName) {
                      const { data: luByName } = await supabase
                        .from('line_users').select('user_id')
                        .eq('display_name', refName).limit(1).maybeSingle()
                        .catch(() => ({ data: null }));
                      refLineUid = luByName?.user_id || null;
                      console.log(`🔍 [referral] display_name("${refName}") lookup → ${refLineUid || 'ไม่พบ'}`);
                    }
                  }

                  // [4] fallback: ค้นจาก line_users ผ่าน LINK ghost order
                  if (!refLineUid) {
                    const { data: ghostOrder } = await supabase
                      .from('orders').select('line_user_id')
                      .like('order_id', `LINK-${ref.customer_id.slice(0,20)}%`)
                      .not('line_user_id', 'is', null).limit(1).maybeSingle();
                    refLineUid = ghostOrder?.line_user_id || null;
                    console.log(`🔍 [referral] LINK ghost lookup → ${refLineUid || 'ไม่พบ'}`);
                  }

                  if (!refLineUid) {
                    console.warn(`⚠️ [referral] หา LINE UID ของ A (${ref.customer_id}) ไม่ได้ — คูปองบันทึกไว้แล้ว จะแจ้งเมื่อ A แชทกับ OA ครั้งถัดไป`);
                  }

                  if (refLineUid) {
                    const discStr = rewardType === 'percent'
                      ? `${rewardValue}%` : `฿${rewardValue.toLocaleString()}`;
                    const expireStr = expireDate.toLocaleDateString('th-TH', {
                      day:'numeric', month:'long', year:'numeric', timeZone:'Asia/Bangkok'
                    });
                    await linePush(refLineUid, [{
                      type: 'text',
                      text: `🎁 ยินดีด้วย! เพื่อนของคุณสั่งซื้อครั้งแรกแล้ว\n` +
                            `คุณได้รับคูปองส่วนลด ${discStr}\n` +
                            `📋 โค้ด: ${newCoupon.code}\n` +
                            `⏰ ใช้ได้ถึง: ${expireStr}\n` +
                            `นำโค้ดไปกรอกตอนสั่งซื้อได้เลยค่ะ 🛍️`
                    }]).catch(e => console.warn('referral notify failed:', e.message));
                  }
                }

                console.log(`🎁 referral reward: ${ref.customer_id} ← ${cpnCode} (เพื่อนสั่ง ${order_id})`);
              }
            }
          }
        }
      }
    } catch(e) {
      console.warn('referral reward error (non-fatal):', e.message);
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

  // ✨ FIX Bug 1: upsert ghost LINK-row เพื่อเก็บ mapping แม้ยังไม่มีออเดอร์จริง
  // เวลา /send-order ทำงาน จะหา line_user_id จาก row นี้ได้เสมอ
  await supabase.from('orders').upsert([{
    order_id    : `LINK-${customer_id.slice(0, 20)}`,
    customer_id,
    line_user_id: lineUserId,
    customer_name: '',          // จะ fill ทีหลังตอนดึงโปรไฟล์ LINE
    items       : [],
    total       : 0,
    status      : 'pending',
    created_at  : new Date().toISOString(),
    note        : '🔗 ผูกบัญชี LINE (รอสั่งสินค้า)'
  }], { onConflict: 'order_id' }).then(({ error: e }) => {
    if (e) console.warn('upsert link-ghost failed:', e.message);
    else console.log(`🔗 stored LINK mapping: customer=${customer_id} ↔ LINE=${lineUserId.slice(0,12)}…`);
  });

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

  // ✨ อัปเดตชื่อ LINE ใน LINK ghost row
  if (displayName) {
    await supabase.from('orders')
      .update({ customer_name: displayName, line_name: displayName })
      .eq('order_id', `LINK-${customer_id.slice(0, 20)}`)
      .then(null, () => {});
  }

  // ✨ บันทึก customer_id ลง line_users เพื่อให้ auto-link ได้ 100%
  upsertLineUser(lineUserId, { customer_id }).catch(() => {});

  // ✨ FIX: ตรวจหาคูปองชวนเพื่อนที่ค้างอยู่ (ยังไม่ได้แจ้งเพราะไม่มี LINE UID ตอนนั้น)
  //   ทำ async แยกต่างหาก ไม่ block response
  if (process.env.LINE_TOKEN) {
    (async () => {
      try {
        const { data: ref } = await supabase
          .from('referrals').select('id')
          .eq('customer_id', customer_id).maybeSingle();
        if (!ref) return;

        const { data: rewards } = await supabase
          .from('referral_rewards')
          .select('*, coupons(*)')
          .eq('referral_id', ref.id)
          .order('created_at', { ascending: false });
        if (!rewards?.length) return;

        // กรองเฉพาะคูปองที่ยังใช้ได้ (active, ไม่หมดอายุ, ยังไม่ได้ใช้)
        const now = new Date();
        const activeCoupons = rewards.filter(rw => {
          const c = rw.coupons;
          if (!c || !c.is_active) return false;
          if (c.usage_limit !== null && (c.used_count || 0) >= c.usage_limit) return false;
          if (c.end_date && new Date(c.end_date) < now) return false;
          return true;
        });
        if (!activeCoupons.length) return;

        // แจ้งเตือนคูปองที่รอมานาน
        const lines = activeCoupons.map(rw => {
          const c = rw.coupons;
          const discStr = c.discount_type === 'percent'
            ? `${c.discount_value}%` : `฿${Number(c.discount_value).toLocaleString()}`;
          const expStr = c.end_date
            ? new Date(c.end_date).toLocaleDateString('th-TH', { day:'numeric', month:'long', year:'numeric', timeZone:'Asia/Bangkok' })
            : 'ไม่มีวันหมดอายุ';
          return `🎟️ ${c.code}  ลด ${discStr}\n   ใช้ได้ถึง ${expStr}`;
        }).join('\n\n');

        await linePush(lineUserId, [{
          type: 'text',
          text: `🎁 มีคูปองชวนเพื่อนรอคุณอยู่!\n` +
                `เพื่อนของคุณสั่งซื้อครั้งแรกแล้ว แต่ตอนนั้นยังไม่ได้ผูก LINE กับร้าน\n\n` +
                `${lines}\n\n` +
                `นำโค้ดไปกรอกตอนสั่งซื้อได้เลยค่ะ 🛍️`
        }]);
        console.log(`🎁 pending referral notify sent → ${lineUserId.slice(0,12)}… (${activeCoupons.length} coupon)`);
      } catch(e) {
        console.warn('pending referral notify failed:', e.message);
      }
    })();
  }

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
    const flex = await buildOrderSummaryFlex(order);
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


// ── upsert ข้อมูลลูกค้าลง line_users (เรียกทุกครั้งที่มี event) ──
async function upsertLineUser(userId, extraFields = {}) {
  if (!userId) return null;
  try {
    const profRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${process.env.LINE_TOKEN}` }
    });
    const profile = profRes.ok ? await profRes.json() : {};
    const displayName = profile.displayName || null;
    const pictureUrl  = profile.pictureUrl  || null;

    const row = {
      user_id     : userId,
      display_name: displayName,
      picture_url : pictureUrl,
      last_seen   : new Date().toISOString(),
      ...extraFields   // ✨ เผื่อส่ง customer_id มาด้วย
    };
    // ถ้าไม่มี customer_id ใน extraFields → ไม่ทับค่าเดิม (only update if provided)
    if (!extraFields.customer_id) delete row.customer_id;

    await supabase.from('line_users').upsert([row], { onConflict: 'user_id' });
    return displayName;
  } catch (e) {
    console.warn('upsertLineUser failed:', e.message);
    return null;
  }
}

// ── POST /webhook ─────────────────────────────────────────
// LINE bot — ลูกค้าทักมา → ตอบสถานะออเดอร์
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];

  for (const ev of events) {
    const userId = ev.source?.userId;
    if (!userId) continue;

    // ✨ บันทึก / อัปเดต line_users อัตโนมัติทุกครั้ง (fire-and-forget)
    upsertLineUser(userId).catch(() => {});

    // ── ครอบทุก event ด้วย try-catch — ป้องกัน crash เงียบ ──
    try {

    // ── FOLLOW EVENT (ลูกค้าเพิ่ม bot เป็นเพื่อน / unblock) ──
    if (ev.type === 'follow') {
      const replyToken = ev.replyToken;
      const token = createLinkToken(userId);
      const shopLink = `${SHOP_URL}?lid=${token}`;

      await safeReply(replyToken, userId, [
        {
          type: 'text',
          text: `🛍 สวัสดีค่ะ! ยินดีต้อนรับสู่ มนชิน ซัพพลาย\n\n` +
                `กดลิงก์ด้านล่างเพื่อเริ่มสั่งซื้อ ระบบจะจดจำคุณอัตโนมัติ ไม่ต้องลงทะเบียน 🚀\n\n` +
                `${shopLink}\n\n` +
                `⏰ ลิงก์มีอายุ 30 นาที\n\n` +
                `📌 ครั้งหน้าพิมพ์คำใดคำหนึ่งด้านล่างเพื่อรับลิงก์ใหม่ได้ตลอดค่ะ:\n` +
                `• "เปิดร้าน"\n` +
                `• "ผูกบัญชี(สั่งสินค้า)"\n` +
                `• "ผูกบัญชี"`
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
        if (!orderId) { await safeReply(replyToken, userId, [{ type:'text', text:'❌ ไม่พบเลขออเดอร์' }]); continue; }

        const { data: order } = await supabase.from('orders')
          .select('*').eq('order_id', orderId).maybeSingle();

        if (!order) {
          await safeReply(replyToken, userId, [{ type:'text', text:`❌ ไม่พบออเดอร์ #${orderId}` }]);
          continue;
        }

        // ตอบกลับด้วยข้อความสรุป + Flex รายละเอียด
        const st = order.status || 'pending';
        const itemsList = (order.items || []).map(i =>
          `${i.emoji||'•'} ${i.name} ×${i.qty} = ฿${(i.qty*i.price).toLocaleString()}`
        ).join('\n');
        const date = new Date(order.created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short', timeZone:'Asia/Bangkok' });

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
        detailText += await shGetHoursMsg();

        // ส่งทั้ง text และ flex update (สถานะปัจจุบัน)
        const messages = [{ type:'text', text: detailText }];
        if (Array.isArray(order.items) && order.items.length > 0) {
          messages.push(await buildStatusUpdateFlex(order, st));
        }
        await safeReply(replyToken, userId, messages);
        continue;
      }

      if (action === 'view_history') {
        // ดึงออเดอร์ที่เสร็จสิ้น/ยกเลิกทั้งหมดของ user นี้
        const { data: histOrders } = await supabase.from('orders')
          .select('*')
          .eq('line_user_id', userId)
          .in('status', ['done', 'cancelled'])
          .not('order_id', 'like', 'LINE-%')
          .not('order_id', 'like', 'LINK-%')
          .order('created_at', { ascending: false })
          .limit(10);

        const realHist = (histOrders || []).filter(o => Array.isArray(o.items) && o.items.length > 0);

        if (!realHist.length) {
          await safeReply(replyToken, userId, [{ type:'text', text:'📭 ยังไม่มีประวัติออเดอร์ค่ะ' }]);
          continue;
        }

        const histBubbles = realHist.slice(0, 10).map(o => ({
          type:'bubble', size:'kilo',
          header:{
            type:'box', layout:'vertical',
            backgroundColor: statusColor(o.status),
            paddingAll:'md',
            contents:[
              { type:'text', text:`${getStatusEmoji(o.status)} ${STATUS_LABELS_TH[o.status]||o.status}`, color:'#ffffff', size:'sm', weight:'bold' },
              { type:'text', text:`#${o.order_id}`, color:'#ffffff', size:'xs', margin:'xs' }
            ]
          },
          body:{
            type:'box', layout:'vertical', spacing:'sm', paddingAll:'md',
            contents:[
              ...((o.items||[]).slice(0,3).map(i => ({
                type:'text', text:`${i.emoji||'•'} ${i.name} ×${i.qty}`,
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
              { type:'text', text: new Date(o.created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short', timeZone:'Asia/Bangkok' }), size:'xxs', color:'#aaaaaa', margin:'xs' }
            ]
          },
          footer:{
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

        await safeReply(replyToken, userId, [
          { type:'text', text:`📜 ประวัติออเดอร์ของคุณ (${realHist.length} รายการ)` },
          { type:'flex', altText:`ประวัติออเดอร์ ${realHist.length} รายการ`,
            contents:{ type:'carousel', contents: histBubbles } }
        ]);
        continue;
      }


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
      // ไม่ใช้ limit — ป้องกัน miss ออเดอร์เก่า
      const { data: matched, error: phoneQueryErr } = await supabase.from('orders')
        .select('order_id, phone, customer_name, status, total, customer_id')
        .order('created_at', { ascending: false });

      if (phoneQueryErr) {
        console.error('phone lookup DB error:', phoneQueryErr.message);
        await linePush(userId, [{ type:'text', text:'❌ ระบบค้นหาขัดข้อง กรุณาลองใหม่ค่ะ' }]).catch(() => {});
        continue;
      }

      // startsWith/endsWith รองรับทุกกรณี:
      // • ตรงเป๊ะ            : "0812345678" vs "0812345678" ✅
      // • มี/ไม่มี 0 นำหน้า  : "0812345678" vs "812345678"  ✅
      // • จำนวนหลักต่างกัน  : "1234567890" vs "123456789"  ✅
      const matches = (matched || []).filter(o => {
        const stored = normalizePhone(o.phone);
        if (!stored || stored.length < 8) return false;
        if (stored === phoneOnly) return true;
        const shorter = stored.length < phoneOnly.length ? stored : phoneOnly;
        const longer  = stored.length < phoneOnly.length ? phoneOnly : stored;
        return longer.startsWith(shorter) || longer.endsWith(shorter);
      });

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
          // ✨ ส่ง order summary + status flex พร้อมกัน (ไม่ต้องกดดูสถานะ)
          replyMessages.push(await buildOrderSummaryFlex(fullLatest));
          if (fullLatest.status && fullLatest.status !== 'pending') {
            replyMessages.push(await buildStatusUpdateFlex(fullLatest, fullLatest.status));
          }
        }

        // ✨ บันทึก customer_id ลง line_users เพื่อ auto-link ครั้งถัดไป
        const matchedCustomerId = matches[0].customer_id;
        if (matchedCustomerId) {
          supabase.from('line_users')
            .update({ customer_id: matchedCustomerId })
            .eq('user_id', userId)
            .then(null, () => {});
        }

        // ส่ง text ก่อนเสมอ (guaranteed) — ลูกค้าได้รับการยืนยันแน่นอน
        await linePush(userId, [replyMessages[0]])
          .catch(e => console.warn('push text failed:', e.message));

        // ส่ง Flex แยก (optional) — ถ้าพังก็ไม่กระทบข้อความหลัก
        if (replyMessages.length > 1) {
          await linePush(userId, replyMessages.slice(1))
            .catch(e => console.warn('push flex failed (non-critical):', e.message));
        }
        continue;
      } else {
        await linePush(userId, [{
          type: 'text',
          text: `🔍 ไม่พบออเดอร์ที่ใช้เบอร์ ${rawText}\n\n📌 กรุณาตรวจสอบ:\n• เบอร์ที่พิมพ์ตรงกับที่กรอกตอนสั่งไหม?\n• ลองพิมพ์เบอร์ให้ครบ 10 หลัก เช่น 0812345678\n\nหากยังไม่พบ กดลิงก์ด้านล่างเพื่อสั่งสินค้าใหม่ได้เลยค่ะ\n${SHOP_URL}`
        }]).catch(e => console.warn('push phone-notfound failed:', e.message));
        continue;
      }
    }

    // คำสั่ง: ออเดอร์ / order / สถานะ → ดูออเดอร์ของตัวเอง
    if (text.includes('ออเดอร์') || text.includes('order') || text.includes('สถานะ') || text.includes('status')) {
      // หาออเดอร์ที่ผูกกับ LINE user นี้ (ตรง)
      const { data: myOrders } = await supabase.from('orders')
        .select('*')
        .eq('line_user_id', userId)
        .not('items', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

      // กรอง ghost orders ออก (ที่ items เป็น array ว่าง)
      let realOrders = (myOrders || []).filter(o =>
        Array.isArray(o.items) && o.items.length > 0
      );

      // ✨ FIX: ถ้าไม่พบ — fallback หา customer_id จาก LINK- ghost แล้วดึงออเดอร์
      if (!realOrders.length) {
        const { data: linkGhost } = await supabase.from('orders')
          .select('customer_id')
          .eq('line_user_id', userId)
          .like('order_id', 'LINK-%')
          .limit(1);

        if (linkGhost?.[0]?.customer_id) {
          const { data: cidOrders } = await supabase.from('orders')
            .select('*')
            .eq('customer_id', linkGhost[0].customer_id)
            .not('order_id', 'like', 'LINK-%')
            .not('order_id', 'like', 'LINE-%')
            .order('created_at', { ascending: false })
            .limit(10);

          const filtered = (cidOrders || []).filter(o =>
            Array.isArray(o.items) && o.items.length > 0
          );
          if (filtered.length) {
            // ✨ backfill line_user_id ให้ออเดอร์เหล่านี้ด้วย
            await supabase.from('orders')
              .update({ line_user_id: userId })
              .eq('customer_id', linkGhost[0].customer_id)
              .not('order_id', 'like', 'LINK-%')
              .then(null, () => {});
            realOrders = filtered;
          }
        }
      }

      if (!realOrders.length) {
        await safeReply(replyToken, userId, [{
          type: 'text',
          text: `📭 ยังไม่พบออเดอร์ของคุณในระบบ\n\n` +
                `🔗 วิธีผูกบัญชี: พิมพ์เบอร์โทรที่ใช้ตอนสั่งซื้อมาครับ\n` +
                `เช่น: 0812345678\n\n` +
                `หรือสั่งสินค้าได้ที่:\n${SHOP_URL}`
        }]);
        continue;
      }

      // แยกออเดอร์ใหม่ (กำลังดำเนินการ) vs ออเดอร์เก่า (เสร็จสิ้น/ยกเลิก)
      const DONE_STATUSES = ['done', 'cancelled'];
      const activeOrders = realOrders.filter(o => !DONE_STATUSES.includes(o.status));
      const historyOrders = realOrders.filter(o => DONE_STATUSES.includes(o.status));

      // ถ้าลูกค้าพิมพ์ "ประวัติ" → แสดงออเดอร์เก่าแทน
      const wantHistory = text.includes('ประวัติ') || text.includes('history') || text.includes('เก่า');
      const ordersToShow = wantHistory ? historyOrders : (activeOrders.length ? activeOrders : realOrders);

      // helper สร้าง bubble แต่ละออเดอร์
      const makeBubble = (o) => ({
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
            { type:'text', text: new Date(o.created_at).toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short', timeZone:'Asia/Bangkok' }), size:'xxs', color:'#aaaaaa', margin:'xs' }
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
      });

      const bubbles = ordersToShow.slice(0, 10).map(makeBubble);

      // สร้างข้อความ header
      const customerName = realOrders[0].customer_name || '';
      let headerText = '';
      if (wantHistory) {
        headerText = `📜 ประวัติออเดอร์ของคุณ ${customerName} (${historyOrders.length} รายการ)`;
      } else if (activeOrders.length) {
        const todayTH = new Date().toLocaleDateString('th-TH', { dateStyle:'short', timeZone:'Asia/Bangkok' });
        const todayOrders = activeOrders.filter(o => new Date(o.created_at).toLocaleDateString('th-TH', { dateStyle:'short', timeZone:'Asia/Bangkok' }) === todayTH);
        if (todayOrders.length > 0) {
          headerText = `📋 ออเดอร์ล่าสุดวันนี้ ${customerName} (${todayOrders.length} รายการ)`;
        } else {
          headerText = `📋 ออเดอร์ล่าสุด ${customerName} (${activeOrders.length} รายการ)`;
        }
      } else {
        headerText = `📋 ออเดอร์ของคุณ ${customerName} (${realOrders.length} รายการล่าสุด)`;
      }

      const replyMsgs = [
        { type:'text', text: headerText },
        {
          type:'flex',
          altText: headerText,
          contents:{ type:'carousel', contents: bubbles }
        }
      ];

      // ถ้ามีประวัติออเดอร์เก่า และตอนนี้กำลังดูออเดอร์ปัจจุบัน → แสดงปุ่ม popup ถามว่าอยากดูประวัติไหม
      if (!wantHistory && historyOrders.length > 0) {
        replyMsgs.push({
          type:'flex',
          altText:`มีประวัติออเดอร์เก่า ${historyOrders.length} รายการ — ดูประวัติไหม?`,
          contents:{
            type:'bubble', size:'kilo',
            body:{
              type:'box', layout:'vertical', paddingAll:'lg', spacing:'sm',
              contents:[
                { type:'text', text:'📜 ประวัติออเดอร์', weight:'bold', size:'md', color:'#333333' },
                { type:'text', text:`คุณมีออเดอร์ที่เสร็จสิ้นแล้ว ${historyOrders.length} รายการ`, size:'sm', color:'#888888', wrap:true, margin:'sm' }
              ]
            },
            footer:{
              type:'box', layout:'vertical', paddingAll:'lg', paddingTop:'none',
              contents:[
                { type:'button', style:'secondary', height:'sm',
                  action:{
                    type:'postback',
                    label:'📜 ดูประวัติออเดอร์',
                    data:'action=view_history',
                    displayText:'📜 ดูประวัติออเดอร์'
                  }
                }
              ]
            }
          }
        });
      }

      await safeReply(replyToken, userId, replyMsgs);
      continue;
    }

    // คำสั่ง: id → ส่ง LINE User ID กลับให้ลูกค้า (เพื่อให้แอดมินผูกบัญชีได้)
    if (text === 'id' || text === 'my id' || text === 'userid' || text === 'user id' || text === 'ไอดี') {
      await safeReply(replyToken, userId, [{
        type: 'text',
        text: `🆔 LINE User ID ของคุณ:\n\n${userId}\n\n📋 คัดลอกและส่งให้ร้านค้าเพื่อผูกบัญชีค่ะ`
      }]);
      continue;
    }

        // คำสั่ง: เปิดร้าน / shop / สั่ง / ซื้อ → ส่งลิงก์ shop พร้อม token
    if (text === 'เปิดร้าน' || text === 'shop' || text === 'สั่ง' || text === 'ซื้อ' || text === 'สั่งซื้อ' || text === 'เปิด' || text === 'ร้าน'|| text === 'ผูกบัญชี(สั่งสินค้า)'|| text === 'ผูกบัญชี'|| text === 'สั่งสินค้า') {
      const token = createLinkToken(userId);
      const shopLink = `${SHOP_URL}?lid=${token}`;
      await safeReply(replyToken, userId, [{
        type: 'text',
        text: `🛍 กดลิงก์ด้านล่างเพื่อสั่งสินค้า ระบบจะจดจำคุณอัตโนมัติ\n\n${shopLink}\n\n⏰ ลิงก์มีอายุ 30 นาที`
      }]);
      continue;
    }

    // คำสั่ง: help / ช่วยเหลือ / เริ่มต้น
    if (text.includes('help') || text.includes('ช่วย') || text === 'เริ่ม' || text === 'start' || text === 'menu' || text === 'เมนู') {
      const token = createLinkToken(userId);
      const shopLink = `${SHOP_URL}?lid=${token}`;
      await safeReply(replyToken, userId, [{
        type: 'text',
        text: `🛍 สวัสดีค่ะ! ใช้งานได้ดังนี้:\n\n` +
              `🛒 สั่งสินค้า → ${shopLink}\n` +
              `📦 พิมพ์ "ออเดอร์" → ดูสถานะออเดอร์\n` +
              `🔗 พิมพ์เบอร์โทร → ผูกออเดอร์เก่า\n` +
              `📲 พิมพ์ "เปิดร้าน/ผูกบัญชี(สั่งสินค้า)/ผูกบัญชี/สั่งสินค้า" → รับลิงก์ใหม่\n\n` +
              `ถ้ามีคำถาม พิมพ์มาได้เลย — ร้านจะตอบในแชทค่ะ 💬`
      }]);
      continue;
    }

    // ข้อความอื่นๆ: forward ไปแอดมิน + บันทึกในแชท (ถ้าผูกบัญชีแล้ว)
    // ✨ FIX Bug 3: กรองออกทั้ง LINE-% และ LINK-% ghost — นับเฉพาะออเดอร์จริง
    const { data: linkedOrders } = await supabase.from('orders')
      .select('order_id, customer_id, customer_name')
      .eq('line_user_id', userId)
      .not('order_id', 'like', 'LINE-%')
      .not('order_id', 'like', 'LINK-%')
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

    // ✨ FIX: ถ้ายังไม่มีออเดอร์จริง → สร้าง ghost เฉพาะถ้ายังไม่มี LINK- ghost อยู่แล้ว
    if (!latest) {
      // ตรวจว่ามี LINK- ghost (ผูกบัญชีแล้วแต่ยังไม่สั่ง) ไหม — ถ้ามี ไม่ต้องสร้าง LINE- ซ้ำ
      const { data: linkGhost } = await supabase.from('orders')
        .select('order_id').eq('line_user_id', userId).like('order_id', 'LINK-%').limit(1);

      if (!linkGhost?.length) {
        // ยังไม่ผูกบัญชีเลย → สร้าง LINE- ghost ให้แอดมินเห็นแชท
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
      } else {
        // มี LINK- ghost → อัปเดตชื่อ/ข้อความแทน
        await supabase.from('messages').upsert([{
          order_id   : linkGhost[0].order_id,
          customer_id: threadCustomerId,
          sender     : 'customer',
          text       : rawText,
          created_at : new Date().toISOString()
        }]).then(null, () => {});
      }
    }

    // ✨ แจ้งแอดมินเฉพาะลูกค้าที่มีออเดอร์จริง + ไม่ใช่ keyword auto-reply
    // *** ข้อความแชทธรรมดา (ไม่เกี่ยวกับออเดอร์/ผูกบัญชี) → ไม่แจ้งแอดมิน ***
    if (latest) {
      // ถ้าตรงกับ keyword auto-reply ของ LINE OA → ไม่แจ้ง (LINE OA ตอบให้แล้ว)
      if (isAutoReplyKeyword(rawText)) {
        console.log(`💬 ${displayName} ส่ง "${rawText.slice(0,30)}" ตรงกับ auto-reply keyword — ไม่แจ้งแอดมิน`);
      } else {
        // ไม่แจ้งแอดมินสำหรับข้อความแชทธรรมดา
        // (แอดมินจะเห็นในหน้า Admin Panel เอง ไม่ต้องรบกวน LINE)
        console.log(`💬 ${displayName} ส่งข้อความ (#${latest.order_id}) "${rawText.slice(0,30)}" — บันทึกใน Admin Panel (ไม่แจ้ง LINE)`);
      }
    } else {
      console.log(`💬 ${displayName} ทักเข้ามาใน LINE (ยังไม่มีออเดอร์) — ไม่แจ้งแอดมิน`);
    }

    // ✨ ไม่ตอบ auto-reply — ปล่อยให้แอดมินตอบเอง ลูกค้าจะไม่เห็น "ได้รับข้อความแล้ว..." spam
    // (ถ้าลูกค้าอยากเปิดร้าน/ดูออเดอร์ → กด Rich Menu หรือพิมพ์ keyword)
    } catch (evErr) {
      // ถ้า event ใดๆ crash → log + push error จริงๆ ให้เห็น
      const errMsg = evErr?.message || String(evErr);
      console.error('⚠️ webhook event error:', errMsg, '| userId:', userId, '| type:', ev.type, '| stack:', evErr?.stack);
      if (userId) {
        linePush(userId, [{ type:'text', text:`❌ Error: ${errMsg.slice(0,200)}` }]).catch(() => {});
      }
      // แจ้ง admin ด้วยเพื่อ debug
      notifyAllAdmins([{ type:'text', text:`⚠️ Webhook error\nUser: ${userId}\nError: ${errMsg.slice(0,300)}` }]).catch(() => {});
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

// ══════════════════════════════════════════════════════════
//  COUPON / DISCOUNT SYSTEM
// ══════════════════════════════════════════════════════════

// ── helper: คำนวณส่วนลดจาก coupon ──────────────────────────
function calcDiscount(coupon, orderTotal) {
  if (!coupon || !coupon.is_active) return 0;
  if (coupon.min_order && orderTotal < coupon.min_order) return 0;
  if (coupon.discount_type === 'percent') {
    const d = (orderTotal * coupon.discount_value) / 100;
    return coupon.max_discount ? Math.min(d, coupon.max_discount) : d;
  }
  return Math.min(coupon.discount_value, orderTotal); // ไม่ลดจนติดลบ
}

// ── GET /applicable-discounts ─────────────────────────────
// ส่งคืน auto-discounts ที่ลูกค้านี้ใช้ได้ตอนนี้
app.get('/applicable-discounts', async (req, res) => {
  const { customerId, orderTotal } = req.query;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  const total = parseFloat(orderTotal) || 0;
  const now   = new Date().toISOString();

  // ดึง auto-coupons ที่ active
  const { data: coupons, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('is_active', true)
    .eq('apply_type', 'auto')
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`end_date.is.null,end_date.gte.${now}`)
    .order('discount_value', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // ตรวจ first_order
  let isFirstOrder = false;
  const { data: prevOrders } = await supabase
    .from('orders')
    .select('id')
    .eq('customer_id', customerId)
    .not('order_id', 'like', 'LINE-%')
    .not('order_id', 'like', 'LINK-%')
    .limit(1);
  isFirstOrder = !prevOrders?.length;

  // กรอง coupons ตาม condition + usage_limit
  const eligible = (coupons || []).filter(c => {
    if (c.usage_limit !== null && c.used_count >= c.usage_limit) return false;
    if (c.condition_type === 'first_order') return isFirstOrder;
    return true; // 'always' or null
  });

  // เลือก coupon เดียวที่ให้ส่วนลดมากสุด
  let best = null;
  let bestDiscount = 0;
  for (const c of eligible) {
    const d = calcDiscount(c, total || 1); // ใช้ 1 ถ้ายังไม่รู้ total
    if (d > bestDiscount) { best = c; bestDiscount = d; }
  }

  // ตรวจว่ามี manual coupon active อยู่หรือไม่ (เพื่อให้ frontend แสดง/ซ่อน input field)
  const { data: manualCoupons } = await supabase
    .from('coupons')
    .select('id')
    .eq('is_active', true)
    .eq('apply_type', 'manual')
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`end_date.is.null,end_date.gte.${now}`)
    .limit(1);
  const hasManualCoupon = !!(manualCoupons?.length);

  res.json({ isFirstOrder, discount: best, allEligible: eligible, hasManualCoupon });
});

// ── GET /validate-coupon ──────────────────────────────────
// ตรวจสอบ manual coupon code ที่ลูกค้ากรอก
app.get('/validate-coupon', async (req, res) => {
  const { code, customerId, orderTotal } = req.query;
  if (!code) return res.status(400).json({ error: 'กรุณากรอกรหัสคูปอง' });

  const total = parseFloat(orderTotal) || 0;
  const now   = new Date().toISOString();

  // หา coupon ที่ตรงกับ code
  const { data: coupon, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('is_active', true)
    .eq('apply_type', 'manual')
    .ilike('code', code.trim())
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`end_date.is.null,end_date.gte.${now}`)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!coupon) return res.status(404).json({ error: 'ไม่พบคูปองนี้ หรือคูปองหมดอายุแล้ว' });

  // ตรวจ usage_limit
  if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit)
    return res.status(400).json({ error: 'คูปองนี้ถูกใช้ครบจำนวนแล้ว' });

  // ตรวจ min_order
  if (coupon.min_order > 0 && total < coupon.min_order)
    return res.status(400).json({ error: `ต้องสั่งขั้นต่ำ ฿${coupon.min_order.toLocaleString()} ถึงจะใช้คูปองนี้ได้`, coupon });

  // ตรวจ first_order condition
  if (coupon.condition_type === 'first_order' && customerId) {
    const { data: prev } = await supabase
      .from('orders').select('id').eq('customer_id', customerId)
      .not('order_id', 'like', 'LINE-%').not('order_id', 'like', 'LINK-%').limit(1);
    if (prev?.length)
      return res.status(400).json({ error: 'คูปองนี้สำหรับการสั่งซื้อครั้งแรกเท่านั้น' });
  }

  const discount = calcDiscount(coupon, total);
  res.json({ success: true, coupon, discountAmount: discount });
});

// ── GET /coupons (admin) ──────────────────────────────────
app.get('/coupons', async (req, res) => {
  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ coupons: data || [] });
});

// ── POST /coupons (admin) ─────────────────────────────────
app.post('/coupons', async (req, res) => {
  const {
    name, description, code, discount_type, discount_value,
    max_discount, min_order, apply_type, condition_type,
    start_date, end_date, usage_limit, is_active
  } = req.body;

  if (!name || discount_value == null)
    return res.status(400).json({ error: 'name และ discount_value จำเป็น' });

  const { data, error } = await supabase.from('coupons').insert([{
    name, description: description || null,
    code: code || null,
    discount_type: discount_type || 'fixed',
    discount_value: Number(discount_value),
    max_discount: max_discount ? Number(max_discount) : null,
    min_order: Number(min_order || 0),
    apply_type: apply_type || 'auto',
    condition_type: condition_type || null,
    start_date: start_date || null,
    end_date: end_date || null,
    usage_limit: usage_limit ? Number(usage_limit) : null,
    is_active: is_active !== false
  }]).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, coupon: data });
});

// ── PATCH /coupons/:id (admin) ────────────────────────────
app.patch('/coupons/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const updates = {};
  const fields = [
    'name','description','code','discount_type','discount_value',
    'max_discount','min_order','apply_type','condition_type',
    'start_date','end_date','usage_limit','is_active'
  ];
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  const { data, error } = await supabase
    .from('coupons').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, coupon: data });
});

// ── DELETE /coupons/:id (admin) ───────────────────────────
app.delete('/coupons/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { error } = await supabase.from('coupons').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── GET /orders (admin) ──────────────────────────────────
app.get('/orders', async (req, res) => {
  const limit  = parseInt(req.query.limit)  || 100;
  const offset = parseInt(req.query.offset) || 0;
  const { data, error, count } = await supabase
    .from('orders')
    .select('*', { count: 'exact' })
    // ✨ ซ่อน LINK- rows — mapping record ไม่ใช่ออเดอร์จริง
    .not('order_id', 'like', 'LINK-%')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ total: count, orders: data });
});

// ── POST /orders/:orderId/notify-status ───────────────────
// Admin กด "📣 ส่งสถานะ" → ส่ง LINE Flex ให้ลูกค้าโดยไม่อัปเดต DB ซ้ำ
app.post('/orders/:orderId/notify-status', async (req, res) => {
  const { orderId } = req.params;

  const { data: order, error } = await supabase
    .from('orders').select('*').eq('order_id', orderId).maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!order) return res.status(404).json({ error: 'ไม่พบออเดอร์ ' + orderId });

  if (!process.env.LINE_TOKEN) {
    return res.status(500).json({ error: 'LINE_TOKEN ไม่ได้ตั้งค่า' });
  }

  // หา LINE user ID จาก order หรือ customer
  let targetUid = order.line_user_id;
  if (!targetUid) {
    targetUid = await findLineUserIdByCustomer(order.customer_id);
  }
  if (!targetUid) {
    return res.status(400).json({ error: 'ไม่พบ LINE user ของลูกค้ารายนี้ (ยังไม่ได้ผูกบัญชี)' });
  }

  try {
    const flex = await buildStatusUpdateFlex(order, order.status);
    await linePush(targetUid, [flex]);
    console.log(`📣 notify-status ${order.status} → ${targetUid.slice(0,12)}…`);
    res.json({ success: true, status: order.status, sentTo: targetUid.slice(0,12) + '…' });
  } catch (e) {
    console.warn('notify-status push failed:', e.message);
    res.status(500).json({ error: 'ส่ง LINE ไม่ได้: ' + e.message });
  }
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
    try {
      await supabase.from('messages').insert([{
        order_id   : data.order_id,
        customer_id: data.customer_id,
        sender     : 'system',
        text       : `📦 ออเดอร์ #${data.order_id} อัปเดตสถานะ: ${statusLabel(status)}`,
        created_at : new Date().toISOString()
      }]);
    } catch(e) { console.error(e); }

    // 2) ส่ง LINE Flex Message หาลูกค้า
    if (process.env.LINE_TOKEN) {
      // ใช้ line_user_id โดยตรงจาก order ก่อน — fallback ไปหาจาก customer_id
      let targetUid = data.line_user_id;
      if (!targetUid) {
        targetUid = await findLineUserIdByCustomer(data.customer_id);
      }
      if (targetUid) {
        const flex = await buildStatusUpdateFlex(data, status);
        linePush(targetUid, [flex])
          .then(() => console.log(`📤 status flex → ${targetUid.slice(0,12)}…`))
          .catch(e => console.warn('LINE flex push failed:', e.message));
      }
    }
  }

  res.json({ success: true, order: data });
});

// ═══════════════════════════════════════════════════════════
//  REFERRAL SYSTEM
// ═══════════════════════════════════════════════════════════

// ── GET /referral-config ────────────────────────────────────
// อ่าน config ระบบชวนเพื่อน (แอดมิน)
app.get('/referral-config', async (req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'referral_config')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  const defaults = {
    referral_reward_type : 'fixed',
    referral_reward_value: 50,
    referral_max_rewards : 0,
    referral_expire_days : 30
  };
  res.json(data ? { ...defaults, ...data.value } : defaults);
});

// ── POST /referral-config ───────────────────────────────────
// บันทึก config ระบบชวนเพื่อน (แอดมิน)
app.post('/referral-config', async (req, res) => {
  const cfg = {
    referral_reward_type : req.body.referral_reward_type  || 'fixed',
    referral_reward_value: parseFloat(req.body.referral_reward_value) || 50,
    referral_max_rewards : parseInt(req.body.referral_max_rewards)    || 0,
    referral_expire_days : parseInt(req.body.referral_expire_days)    || 30,
  };
  const { error } = await supabase
    .from('settings')
    .upsert({ key: 'referral_config', value: cfg }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, config: cfg });
});

// ── GET /shop-hours ──────────────────────────────────────────
// อ่านเวลาทำการร้าน (ลูกค้าและแอดมินใช้)
app.get('/shop-hours', async (req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'shop_hours')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  const defaults = {
    enabled: false,
    openTime: '09:00',
    closeTime: '18:00',
    openDays: [1,2,3,4,5,6],
    msgOpen: 'ยินดีต้อนรับค่ะ! 🎉 ร้านเปิดให้บริการอยู่นะคะ',
    msgClosed: 'ขณะนี้ร้านปิดให้บริการแล้วค่ะ 🌙\nทางร้านจะจัดส่งสินค้าให้วันพรุ่งนี้เช้านะคะ ✨\nขอบคุณที่อุดหนุนร้านเรานะคะ 🙏',
    showBanner: true,
    showPopup: true,
    popupOnce: true
  };
  res.json(data ? { ...defaults, ...data.value } : defaults);
});

// ── POST /shop-hours ─────────────────────────────────────────
// บันทึกเวลาทำการร้าน (แอดมิน)
app.post('/shop-hours', async (req, res) => {
  const cfg = {
    enabled   : !!req.body.enabled,
    openTime  : req.body.openTime  || '09:00',
    closeTime : req.body.closeTime || '18:00',
    openDays  : Array.isArray(req.body.openDays) ? req.body.openDays : [1,2,3,4,5,6],
    msgOpen   : req.body.msgOpen   || '',
    msgClosed : req.body.msgClosed || '',
    showBanner: !!req.body.showBanner,
    showPopup : !!req.body.showPopup,
    popupOnce : !!req.body.popupOnce
  };
  const { error } = await supabase
    .from('settings')
    .upsert({ key: 'shop_hours', value: cfg }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, config: cfg });
});

// ── GET /my-referral ─────────────────────────────────────────
// สร้าง/ดึงลิงก์ referral ของลูกค้า
app.get('/my-referral', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  // ดึงหรือสร้าง referral record
  let { data: ref } = await supabase
    .from('referrals')
    .select('ref_code')
    .eq('customer_id', customerId)
    .maybeSingle();

  if (!ref) {
    const ref_code = 'REF' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
    const { data: newRef, error } = await supabase
      .from('referrals')
      .insert({ customer_id: customerId, ref_code })
      .select('ref_code')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    ref = newRef;
  }

  const baseUrl = process.env.SHOP_URL || `https://${req.headers.host}`;
  const shareUrl = `${baseUrl.replace(/\/$/, '')}/invite/${ref.ref_code}`;
  res.json({ refCode: ref.ref_code, shareUrl });
});

// ── POST /referral-visit ─────────────────────────────────────
// บันทึกการเยี่ยมชมจากลิงก์ referral
app.post('/referral-visit', async (req, res) => {
  const { customerId, refCode } = req.body;
  if (!refCode) return res.status(400).json({ error: 'refCode required' });

  // หา referral owner
  const { data: ref } = await supabase
    .from('referrals')
    .select('id, customer_id')
    .eq('ref_code', refCode)
    .maybeSingle();

  if (!ref) return res.status(404).json({ error: 'ไม่พบ referral code นี้' });

  // บันทึก visit (ถ้ายังไม่เคยบันทึก customerId นี้)
  if (customerId && customerId !== ref.customer_id) {
    await supabase
      .from('referral_visits')
      .upsert(
        { referral_id: ref.id, visitor_customer_id: customerId },
        { onConflict: 'referral_id,visitor_customer_id', ignoreDuplicates: true }
      );
  }

  res.json({ success: true });
});

// ── GET /my-referral-rewards ─────────────────────────────────
// ดูรายการคูปองที่ได้จากการชวนเพื่อน
app.get('/my-referral-rewards', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  const { data: ref } = await supabase
    .from('referrals')
    .select('id')
    .eq('customer_id', customerId)
    .maybeSingle();

  if (!ref) return res.json({ rewards: [] });

  const { data: rewards, error } = await supabase
    .from('referral_rewards')
    .select('*, coupons(*)')
    .eq('referral_id', ref.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rewards: rewards || [] });
});

// ── GET /available-coupons ───────────────────────────────────
// ดึงรายการคูปองทั้งหมด (auto + manual) ที่ลูกค้าใช้ได้ใน picker
app.get('/available-coupons', async (req, res) => {
  const { customerId, orderTotal } = req.query;
  const total = parseFloat(orderTotal) || 0;
  const now   = new Date().toISOString();

  // ดึงทั้ง auto และ manual ที่ active (ยกเว้น secret)
  const { data: coupons, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('is_active', true)
    .neq('is_secret', true)
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`end_date.is.null,end_date.gte.${now}`)
    .order('discount_value', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // ตรวจ first_order
  let isFirstOrder = false;
  if (customerId) {
    const { data: prevOrders } = await supabase
      .from('orders').select('id').eq('customer_id', customerId)
      .not('order_id', 'like', 'LINE-%').not('order_id', 'like', 'LINK-%').limit(1);
    isFirstOrder = !prevOrders?.length;
  }

  // กรองตาม condition + usage_limit
  const eligible = (coupons || []).filter(c => {
    if (c.usage_limit !== null && (c.used_count || 0) >= c.usage_limit) return false;
    if (c.condition_type === 'first_order') return isFirstOrder;
    return true;
  });

  // คำนวณ discount ให้แต่ละ coupon
  const result = eligible.map(c => ({
    ...c,
    discountAmount: calcDiscount(c, total)
  }));

  res.json({ coupons: result });
});

// ── POST /reveal-coupon ──────────────────────────────────────
// เปิดเผยคูปองลับด้วย secretCode
app.post('/reveal-coupon', async (req, res) => {
  const { secretCode, customerId, orderTotal } = req.body;
  if (!secretCode) return res.status(400).json({ error: 'กรุณากรอกโค้ดลับ' });

  const total = parseFloat(orderTotal) || 0;
  const now   = new Date().toISOString();

  const { data: coupon, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('is_active', true)
    .eq('is_secret', true)
    .ilike('secret_code', secretCode.trim())
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`end_date.is.null,end_date.gte.${now}`)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!coupon) return res.status(404).json({ error: 'ไม่พบโค้ดลับนี้ หรือหมดอายุแล้ว' });

  if (coupon.usage_limit !== null && (coupon.used_count || 0) >= coupon.usage_limit)
    return res.status(400).json({ error: 'คูปองนี้ถูกใช้ครบจำนวนแล้ว' });

  if (coupon.min_order > 0 && total < coupon.min_order)
    return res.status(400).json({ error: `ต้องสั่งขั้นต่ำ ฿${coupon.min_order.toLocaleString()} ถึงจะใช้คูปองนี้ได้` });

  const discountAmount = calcDiscount(coupon, total);
  res.json({ success: true, coupon, discountAmount });
});

// ═══════════════════════════════════════════════════════════
//  STATIC FILES
// ═══════════════════════════════════════════════════════════
//  หน้าร้านลูกค้า อยู่ที่ index.html (อยู่บน Railway/GitHub)
//  หน้าแอดมิน admin.html เก็บไว้ในเครื่องเจ้าของร้าน — เปิดจาก browser ตรงๆ
//  (admin.html จะเรียก API ของ backend ที่นี่ผ่าน CORS)

// ── GET /invite/:refCode ─────────────────────────────────────
// หน้า Landing Page กลาง — ให้ B แอด LINE OA แล้ว redirect ไปร้านพร้อม ref code
app.get('/invite/:refCode', (req, res) => {
  const refCode  = req.params.refCode;
  const baseUrl  = (process.env.SHOP_URL || `https://${req.headers.host}`).replace(/\/$/, '');
  const shopUrl  = `${baseUrl}/?ref=${refCode}`;
  const lineOaId = process.env.LINE_OA_ID || '';                 // เช่น @menshop หรือ @Uxxxxxxxx
  const lineAddUrl = lineOaId
    ? `https://line.me/R/ti/p/${encodeURIComponent(lineOaId)}`
    : null;
  const shopName = process.env.SHOP_NAME || 'ร้านของเรา';

  // ถ้าไม่มี LINE_OA_ID → redirect ตรงไปร้านเลย
  if (!lineAddUrl) {
    return res.redirect(302, shopUrl);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>เชิญมาช้อปด้วยกัน — ${shopName}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Helvetica Neue',Arial,'Noto Sans Thai',sans-serif;
         background:linear-gradient(135deg,#f8f9fa 0%,#e8f5e9 100%);
         min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#fff;border-radius:20px;padding:36px 28px 32px;
          max-width:380px;width:100%;text-align:center;
          box-shadow:0 8px 40px rgba(0,0,0,.10)}
    .logo{font-size:48px;margin-bottom:8px}
    .shop{font-size:20px;font-weight:700;color:#2C3E50;margin-bottom:4px}
    .tagline{font-size:13px;color:#888;margin-bottom:28px}
    .divider{border:none;border-top:1px solid #f0f0f0;margin:20px 0}
    .step{display:flex;align-items:flex-start;gap:12px;text-align:left;margin-bottom:16px}
    .step-num{min-width:26px;height:26px;border-radius:50%;
              background:#06C755;color:#fff;font-size:12px;font-weight:700;
              display:flex;align-items:center;justify-content:center;margin-top:2px}
    .step-txt{font-size:14px;color:#444;line-height:1.5}
    .step-txt strong{color:#2C3E50}
    .btn-line{display:block;background:#06C755;color:#fff;border:none;
              border-radius:12px;padding:16px;font-size:16px;font-weight:700;
              text-decoration:none;cursor:pointer;margin-top:24px;
              font-family:inherit;width:100%;
              box-shadow:0 4px 14px rgba(6,199,85,.35);
              transition:transform .15s,box-shadow .15s}
    .btn-line:active{transform:scale(.97);box-shadow:0 2px 8px rgba(6,199,85,.3)}
    .btn-skip{display:block;margin-top:12px;font-size:13px;color:#aaa;
              text-decoration:underline;cursor:pointer;background:none;
              border:none;font-family:inherit;width:100%;padding:6px}
    .gift{font-size:13px;color:#e8593c;font-weight:600;
          background:#fff5f2;border-radius:8px;padding:10px 14px;
          margin-bottom:20px;border:1px solid #ffd5cc}
    #status{font-size:13px;color:#06C755;min-height:20px;margin-top:14px;display:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🛍️</div>
    <div class="shop">${shopName}</div>
    <div class="tagline">เพื่อนของคุณชวนมาช้อปด้วยกัน!</div>

    <div class="gift">🎁 ช้อปครั้งแรกแล้วเพื่อนของคุณ<br>จะได้รับคูปองส่วนลดทันที!</div>

    <div class="step">
      <div class="step-num">1</div>
      <div class="step-txt"><strong>แอด LINE OA ของเรา</strong><br>เพื่อรับการแจ้งเตือนออเดอร์และโปรโมชั่น</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-txt"><strong>ช้อปสินค้าได้เลย</strong><br>ระบบบันทึกว่าคุณมาจากลิงก์เพื่อนอัตโนมัติ</div>
    </div>

    <button class="btn-line" onclick="goAddAndShop()">
      ➕ แอด LINE OA + ไปช้อปเลย
    </button>
    <button class="btn-skip" onclick="goShopOnly()">ข้ามขั้นตอนนี้ ไปช้อปเลย →</button>
    <div id="status">✅ กำลังพาไปหน้าร้าน...</div>
  </div>

  <script>
    const SHOP_URL   = ${JSON.stringify(shopUrl)};
    const LINE_ADD   = ${JSON.stringify(lineAddUrl)};

    function goAddAndShop() {
      // เปิด LINE เพื่อแอด OA
      window.open(LINE_ADD, '_blank');
      // หน้านี้ redirect ไปร้านหลังจาก 1.2 วิ (ให้ LINE app เปิดทัน)
      document.getElementById('status').style.display = 'block';
      setTimeout(() => { window.location.href = SHOP_URL; }, 1200);
    }

    function goShopOnly() {
      window.location.href = SHOP_URL;
    }
  </script>
</body>
</html>`);
});


// fallback: ทุก URL ที่ไม่ match route ข้างบน → ส่งหน้าร้าน
app.use(express.static(__dirname));

app.get('/shop', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Health Check (ป้องกัน Render Sleep) ───────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

  // ── Keep-alive: ping ตัวเองทุก 14 นาที ป้องกัน Render หลับ ──
  // Render free tier หลับหลังไม่มี request 15 นาที
  // ping /health ทุก 14 นาที = ไม่หลับตลอดเวลา
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SHOP_URL || ('http://localhost:' + PORT);
  const PING_INTERVAL = 14 * 60 * 1000; // 14 นาที

  setInterval(async () => {
    try {
      const r = await fetch(SELF_URL.replace(/\/+$/, '') + '/health');
      console.log('🏓 keep-alive ping →', r.status === 200 ? '✅ OK' : '⚠️ ' + r.status);
    } catch (e) {
      console.warn('🏓 keep-alive ping failed:', e.message);
    }
  }, PING_INTERVAL);

  console.log('🏓 Keep-alive เปิดแล้ว (ping ทุก 14 นาที →', SELF_URL, ')');
});
