# LINE Shop — Full Stack

ระบบร้านค้าออนไลน์เชื่อมกับ LINE OA แบบครบวงจร

```
line-shop-full/
├── backend/
│   ├── index.js              ← Express server + LINE API + Supabase
│   ├── package.json
│   ├── supabase-schema.sql   ← SQL สำหรับสร้างตาราง
│   ├── .env.example
│   └── .gitignore
└── frontend/
    ├── shop.html             ← หน้าร้านค้า (ลูกค้าใช้)
    └── admin.html            ← หน้า Admin ดูออเดอร์
```

---

## ขั้นตอนติดตั้งทั้งหมด

### 1. สร้าง Supabase Database (ฟรี)

1. ไปที่ https://supabase.com → สร้าง Project ใหม่
2. ไปที่ **SQL Editor** → **New Query**
3. วางโค้ดจาก `backend/supabase-schema.sql` แล้วกด **Run**
4. ไปที่ **Project Settings** → **API** → คัดลอก:
   - `Project URL` → ใส่ใน `SUPABASE_URL`
   - `anon public` key → ใส่ใน `SUPABASE_KEY`

### 2. ตั้งค่า Backend

```bash
cd backend
npm install
cp .env.example .env
# แก้ไข .env ใส่ค่าจริง
npm start
```

### 3. Deploy ขึ้น Railway

1. Push โค้ดใน `backend/` ขึ้น GitHub
2. ไปที่ https://railway.app → New Project → Deploy from GitHub
3. ใส่ Environment Variables:
   - `LINE_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
4. Railway จะให้ URL เช่น `https://line-shop-xxx.up.railway.app`

### 4. ตั้ง Webhook ใน LINE Developers Console

1. https://developers.line.biz → เลือก Channel → Messaging API
2. Webhook URL: `https://YOUR-APP.up.railway.app/webhook`
3. เปิด **Use webhook**: ON
4. กด **Verify** → ต้องขึ้น Success

### 5. แก้ไข Frontend

ใน `frontend/shop.html` แก้บรรทัด:
```js
const BACKEND_URL = 'https://YOUR-APP.up.railway.app'; // ← ใส่ URL จริง
```

ใน `frontend/admin.html` ใส่ URL ใน input ตอนเปิดหน้า Admin

---

## วิธีใช้งาน

### ลูกค้า:
1. เปิด `shop.html`
2. Add Friend กับ LINE OA → พิมพ์ "id" → ได้รับ LINE User ID
3. เลือกสินค้า → ใส่ตะกร้า → กรอกชื่อ + LINE User ID → กด "ส่งออเดอร์"
4. LINE OA จะส่งข้อความแจ้งออเดอร์มาทันที

### เจ้าของร้าน (Admin):
1. เปิด `admin.html`
2. ใส่ Backend URL → กด "โหลดออเดอร์"
3. ดูออเดอร์ทั้งหมด + เปลี่ยนสถานะ
4. เมื่อเปลี่ยนสถานะ → LINE จะแจ้งลูกค้าอัตโนมัติ

---

## API Endpoints

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET    | `/`                          | Health check |
| POST   | `/send-order`                | รับออเดอร์ → ส่ง LINE |
| POST   | `/webhook`                   | รับ events จาก LINE |
| GET    | `/orders`                    | ดูออเดอร์ทั้งหมด |
| PATCH  | `/orders/:id/status`         | อัปเดตสถานะ + แจ้งลูกค้า |
| GET    | `/users`                     | ดู LINE User IDs |
