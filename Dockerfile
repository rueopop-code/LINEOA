# ═══════════════════════════════════════════════════════════════════
#  Dockerfile — ใช้แทน nixpacks.toml เมื่อ deploy บน Render
#
#  🐛 เหตุผลที่ต้องมีไฟล์นี้: nixpacks.toml (nixPkgs: tesseract, leptonica)
#  ใช้ได้เฉพาะแพลตฟอร์มที่รันด้วย Nixpacks builder จริงๆ (เช่น Railway)
#  — Render ไม่ได้ใช้ Nixpacks เป็น builder หลัก ถ้าปล่อยให้ Render
#  auto-detect เป็น Node runtime ธรรมดา จะไม่มีการติดตั้ง tesseract เลย
#  ทำให้ /read-slip และ /submit-slip อ่าน OCR จากสลิปไม่ได้เลยสักครั้ง
#  (เห็นใน log จริง: "tesseract: not found") — Dockerfile นี้ apt-get
#  ติดตั้ง tesseract-ocr + pack ภาษาไทย/อังกฤษให้ตรงกับที่โค้ดสั่งใช้
#  (lang: 'tha+eng' ใน runSlipOCR())
#
#  วิธีใช้บน Render: ไปที่ service → Settings → Build & Deploy →
#  เปลี่ยน "Runtime" เป็น "Docker" (Render จะเจอไฟล์นี้อัตโนมัติ)
#  ไม่ต้องตั้งค่า Build Command / Start Command เองอีก เพราะกำหนดไว้ในนี้แล้ว
# ═══════════════════════════════════════════════════════════════════

FROM node:20-slim

# ติดตั้ง tesseract-ocr + language pack ไทย/อังกฤษ (โค้ดเรียกใช้ lang: 'tha+eng')
# + libvips-dev สำรองไว้เผื่อ sharp ต้อง build จาก source บน platform ที่ไม่มี prebuilt binary
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-tha \
      tesseract-ocr-eng \
      libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy package files ก่อนแยกต่างหาก — ใช้ docker layer cache ให้ npm install
# ไม่ต้องรันใหม่ทุกครั้งที่แก้แค่โค้ด (index.js/index.html) โดยไม่ได้แก้ dependency
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# copy โค้ดที่เหลือทั้งหมด
COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "index.js"]
