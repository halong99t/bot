# ⚡ Crypto Trading Bot — Binance Futures

Hệ thống fullstack tự động **scan toàn bộ coin Binance Futures**, **phát hiện mô hình LONG** và **tự động vào lệnh** với quản trị rủi ro TP/SL.

> ⚠️ **Cảnh báo rủi ro**: Đây là phần mềm phục vụ học tập/nghiên cứu. Trading futures có rủi ro cao. Luôn test trên **Binance Futures Testnet** (`BINANCE_TESTNET=true`) trước khi dùng tiền thật.

---

## 🧱 Kiến trúc & Công nghệ

| Layer    | Stack |
|----------|-------|
| Frontend | React + Vite + TypeScript, TailwindCSS, Lightweight Charts, Zustand, Axios, React Router |
| Backend  | Node.js + TypeScript, Express, WebSocket (`ws`), Binance Futures REST API, technicalindicators |
| Database | PostgreSQL + Prisma ORM |
| DevOps   | Docker, docker-compose, Nginx (serve frontend) |

### Cấu trúc thư mục

```
crypto-trading-bot/
├── docker-compose.yml
├── .env.example
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── package.json · tsconfig.json
│   ├── prisma/
│   │   ├── schema.prisma          # 8 bảng: users, settings, coins, market_data, signals, positions, trades, logs
│   │   └── seed.ts
│   └── src/
│       ├── index.ts               # entry: HTTP + WS + scheduler
│       ├── app.ts                 # Express app
│       ├── config/                # env, prisma client
│       ├── lib/                   # binance.ts (REST client + retry/err), logger.ts
│       ├── services/
│       │   ├── scanner.service.ts   # CHỨC NĂNG 1: scan + rankings
│       │   ├── indicators.ts        # RSI/EMA/ATR
│       │   ├── strategy.service.ts  # CHỨC NĂNG 2: phát hiện mô hình LONG
│       │   └── trading.service.ts   # đặt/đóng lệnh, TP/SL, PNL
│       ├── websocket/ws.server.ts   # realtime broadcast
│       ├── jobs/scheduler.ts        # scan mỗi 1 phút
│       ├── routes/                  # REST API
│       └── middleware/error.ts      # xử lý lỗi tập trung (gồm Binance error)
└── frontend/
    ├── Dockerfile · nginx.conf
    ├── package.json · vite/tailwind/postcss config
    └── src/
        ├── api/client.ts            # Axios
        ├── store/useStore.ts        # Zustand
        ├── hooks/useWebSocket.ts    # realtime + auto-reconnect
        ├── components/              # Layout, Sidebar, Chart (Lightweight Charts)
        └── pages/                   # Overview, Scanner, Signals, Positions, History, Settings
```

---

## ✨ Tính năng

### CHỨC NĂNG 1 — Scan toàn bộ coin
- Kết nối **Binance Futures**, lấy tất cả cặp **USDT Perpetual**.
- Scan liên tục mỗi **1 phút** (cấu hình được).
- Thu thập: giá, volume, funding rate, open interest, 24h change, ATR, RSI, EMA20/50/200.
- Lưu vào PostgreSQL (`market_data`).
- **Bảng xếp hạng**: top tăng mạnh, top volume, top funding bất thường, top OI cao.

### CHỨC NĂNG 2 — Phát hiện mô hình LONG
Logic 4 bước (xem `strategy.service.ts`):
1. Coin giảm mạnh ≥ **15%**.
2. Sideway ≥ **20 nến**, biên độ < **5%**.
3. **3 nến tăng liên tiếp**, tổng tăng ≥ **10%**.
4. Nến thứ 3 **breakout** vượt đỉnh vùng sideway.

Khi thỏa → tính điểm vào lệnh, đặt **LONG MARKET**, **TP +30% / SL −15%** (cấu hình), tự đóng và ghi log khi chạm TP/SL.

### Dashboard
Overview · Market Scanner (search/sort/filter) · Trading Signals · Open Positions (PNL realtime) · Trade History · Settings.
Chart Lightweight Charts với EMA20/50/200, Volume, và đánh dấu Entry/TP/SL + điểm tín hiệu.

---

## 🚀 Cách chạy

### Phương án A — Docker (khuyến nghị)

```bash
cd crypto-trading-bot
cp .env.example .env
# Sửa .env: nhập BINANCE_API_KEY/SECRET (testnet), giữ BINANCE_TESTNET=true

docker compose up -d --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000/api/health
- Migration Prisma chạy tự động (`prisma migrate deploy`) khi backend khởi động.

Xem log:
```bash
docker compose logs -f backend
```

Dừng:
```bash
docker compose down          # giữ dữ liệu
docker compose down -v       # xóa luôn volume postgres
```

### Phương án B — Chạy local (dev)

**1. PostgreSQL** (qua Docker cho nhanh):
```bash
docker run -d --name ctb_pg -e POSTGRES_USER=ctb -e POSTGRES_PASSWORD=ctb_secret \
  -e POSTGRES_DB=crypto_bot -p 5432:5432 postgres:16-alpine
```

**2. Backend**:
```bash
cd backend
cp ../.env.example .env     # đảm bảo DATABASE_URL dùng host localhost
npm install
npm run prisma:generate
npm run prisma:migrate      # tạo bảng
npm run seed                # tạo settings mặc định
npm run dev                 # chạy tại http://localhost:4000
```

**3. Frontend**:
```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # chạy tại http://localhost:5173
```

---

## 🖥️ Deploy lên VPS Ubuntu

```bash
# 1. Cài Docker + Compose plugin
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER       # logout/login lại để áp dụng

# 2. Lấy source
git clone <repo-url> crypto-trading-bot
cd crypto-trading-bot

# 3. Cấu hình
cp .env.example .env
nano .env                            # nhập API key, đổi POSTGRES_PASSWORD & JWT_SECRET mạnh
#   - VITE_API_URL=http://<IP-hoặc-domain>:4000
#   - VITE_WS_URL=ws://<IP-hoặc-domain>:4000

# 4. Build & chạy
docker compose up -d --build

# 5. Mở firewall
sudo ufw allow 3000/tcp
sudo ufw allow 4000/tcp
sudo ufw enable
```

### (Khuyến nghị) Nginx reverse proxy + HTTPS
Trỏ domain về VPS, rồi:
```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```
Tạo `/etc/nginx/sites-available/ctb`:
```nginx
server {
    server_name yourdomain.com;
    location / { proxy_pass http://localhost:3000; }
    location /api/ { proxy_pass http://localhost:4000; }
    location /ws  {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/ctb /etc/nginx/sites-enabled/
sudo certbot --nginx -d yourdomain.com   # cấp SSL tự động
sudo systemctl reload nginx
```
Khi dùng domain HTTPS, đặt `VITE_API_URL=https://yourdomain.com` và `VITE_WS_URL=wss://yourdomain.com` rồi build lại frontend.

---

## 🔑 Lấy Binance API Key (Testnet)
1. Vào https://testnet.binancefuture.com → đăng nhập bằng GitHub.
2. Mục **API Key** → tạo key/secret.
3. Dán vào `.env` hoặc trang **Settings** trên dashboard.
4. Giữ `BINANCE_TESTNET=true`.

> Với tài khoản thật: bật quyền **Enable Futures**, **KHÔNG** bật quyền rút tiền, và whitelist IP của VPS.

---

## 🛡️ Xử lý lỗi Binance API
`backend/src/lib/binance.ts` đã xử lý:
- **429 / 418** (rate limit / IP ban): backoff theo header `Retry-After`, retry tối đa 4 lần.
- **Lỗi mạng** (`ECONNRESET`, `ETIMEDOUT`...): exponential backoff.
- **Lỗi nghiệp vụ** (sai key, thiếu margin...): ném `BinanceError`, ghi log, trả 502 ở REST.
- Scanner gọi klines theo **batch xoay vòng** để tránh vượt rate limit.

---

## 📡 WebSocket realtime
Endpoint `ws://host:4000/ws`. Backend broadcast: `scan_complete`, `signal`, `position_opened`, `position_update`, `position_closed`. Frontend tự reconnect khi rớt kết nối.

---

## 🗄️ Database (Prisma)
8 bảng: `users`, `settings`, `coins`, `market_data`, `signals`, `positions`, `trades`, `logs`.
Lệnh hữu ích:
```bash
cd backend
npm run prisma:studio       # GUI xem dữ liệu
npm run prisma:migrate      # tạo migration mới khi đổi schema
```

---

## ⚙️ Lưu ý production
- Đổi `JWT_SECRET`, `POSTGRES_PASSWORD` mạnh.
- Bắt đầu với `autoTrade=false`, `orderSizeUsdt` nhỏ để kiểm thử chiến lược.
- Theo dõi tab Logs / `docker compose logs -f backend`.
- Backup volume `pgdata` định kỳ.
```

> Đây là khung production-ready. Trước khi giao dịch tiền thật, hãy backtest chiến lược và tự chịu trách nhiệm rủi ro.
# bot-trade
# bot
