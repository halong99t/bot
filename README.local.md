# 🖥️ Chạy local — KHÔNG cần Docker (SQLite)

Hướng dẫn chạy dự án hoàn toàn trên máy bằng **Node.js + SQLite**, không cần Docker, không cần PostgreSQL, không cần mật khẩu DB.

> File này thay thế phần "Cách chạy" trong `README.md` (vốn dùng Docker + PostgreSQL). Logic ứng dụng, API, WebSocket... giữ nguyên — chỉ khác lớp database.

---

## ✅ Yêu cầu

- **Node.js 20+** và **npm** (kiểm tra: `node -v`, `npm -v`)
- Không cần Docker, không cần PostgreSQL.
- Database dùng **SQLite** — chỉ là 1 file `backend/prisma/dev.db`, tự sinh ra.

---

## 🚀 Chạy lần đầu

Mở **2 terminal** (PowerShell). Terminal 1 chạy backend, terminal 2 chạy frontend.

### 1) Backend (cổng 4000)

```bash
cd backend

# Tạo file .env (chỉ lần đầu)
cp ../.env.example .env
# Mở backend/.env và sửa đúng 1 dòng DATABASE_URL thành:
#   DATABASE_URL=file:./dev.db

npm install
npx prisma db push     # tạo file SQLite + toàn bộ bảng
npm run seed           # tạo settings mặc định
npm run dev            # chạy tại http://localhost:4000
```

### 2) Frontend (cổng 5173)

```bash
cd frontend

# (tuỳ chọn) tạo .env nếu chưa có — mặc định đã trỏ về localhost:4000
cp .env.example .env

npm install
npm rebuild esbuild    # cần thiết: postinstall của esbuild hay bị npm chặn
npm run dev            # chạy tại http://localhost:5173
```

👉 Mở trình duyệt: **http://localhost:5173**

- Backend health: http://localhost:4000/api/health → `{"status":"ok"}`

---

## 🔁 Các lần chạy sau

Database (`backend/prisma/dev.db`) đã tồn tại, chỉ cần khởi động lại 2 server:

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

> Chỉ chạy lại `npx prisma db push` khi bạn **đổi `schema.prisma`**.
> Chỉ chạy lại `npm rebuild esbuild` nếu Vite báo lỗi thiếu esbuild binary.

---

## ⚙️ Khác biệt so với bản Docker (đã chỉnh để chạy SQLite)

| Mục | Bản gốc (Docker) | Bản local này |
|-----|------------------|---------------|
| Database | PostgreSQL | **SQLite** (`backend/prisma/dev.db`) |
| `schema.prisma` → `datasource provider` | `postgresql` | `sqlite` |
| 3 enum `SignalType` / `SignalStatus` / `PositionStatus` | `enum` | đổi thành `String` (SQLite không hỗ trợ enum) |
| `Log.meta` | `Json?` | `String?` (logger tự `JSON.stringify`) |
| `backend/.env` → `DATABASE_URL` | `postgresql://...@postgres:5432/...` | `file:./dev.db` |

Các giá trị enum vẫn dùng chuỗi như cũ: `LONG/SHORT`, `PENDING/EXECUTED/EXPIRED/CANCELLED`, `OPEN/CLOSED`.

> Muốn quay lại Docker/PostgreSQL: revert 4 mục trên (provider, enum, `Log.meta`, `DATABASE_URL`) rồi làm theo `README.md`.

---

## 🔑 Giao dịch thật/testnet (tuỳ chọn)

Mặc định bot **chỉ scan dữ liệu công khai**, KHÔNG vào lệnh (`autoTrade=false`, chưa có API key — an toàn).

Muốn bật auto-trade trên **Binance Futures Testnet**:
1. Lấy key tại https://testnet.binancefuture.com
2. Vào trang **Settings** trên dashboard → nhập `API Key` / `Secret`.
3. Bật **Auto Trade**. Giữ `BINANCE_TESTNET=true` trong `backend/.env`.

---

## 🛠️ Lệnh hữu ích

```bash
cd backend
npx prisma studio      # GUI xem dữ liệu SQLite tại http://localhost:5555
npx prisma db push     # đồng bộ schema -> DB sau khi sửa schema.prisma
```

## 🧰 Khắc phục sự cố

- **`Field can't be of type Json` / enum khi `prisma db push`**: bạn đang dùng schema Postgres trên SQLite — đảm bảo đã đổi `provider=sqlite`, enum→`String`, `Json?`→`String?`.
- **Vite lỗi thiếu esbuild / `Cannot find module @esbuild/...`**: `cd frontend && npm rebuild esbuild`.
- **Cổng bị chiếm (4000/5173)**: đổi `PORT` trong `backend/.env`, hoặc tắt tiến trình đang dùng cổng.
- **Frontend không gọi được API**: kiểm tra backend đang chạy ở `:4000` và `frontend/.env` có `VITE_API_URL=http://localhost:4000`, `VITE_WS_URL=ws://localhost:4000` (mặc định trong code đã trỏ sẵn).
