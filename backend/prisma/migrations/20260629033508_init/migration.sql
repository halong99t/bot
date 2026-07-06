-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('PENDING', 'EXECUTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "take_profit_pct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "stop_loss_pct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "order_size_usdt" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "leverage" INTEGER NOT NULL DEFAULT 5,
    "scan_interval_ms" INTEGER NOT NULL DEFAULT 60000,
    "auto_trade" BOOLEAN NOT NULL DEFAULT false,
    "binance_api_key" TEXT,
    "binance_api_secret" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coins" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "base_asset" TEXT NOT NULL,
    "quote_asset" TEXT NOT NULL,
    "price_precision" INTEGER NOT NULL DEFAULT 2,
    "qty_precision" INTEGER NOT NULL DEFAULT 3,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data" (
    "id" SERIAL NOT NULL,
    "coin_id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "volume_24h" DOUBLE PRECISION NOT NULL,
    "quote_volume" DOUBLE PRECISION NOT NULL,
    "price_change_24h" DOUBLE PRECISION NOT NULL,
    "funding_rate" DOUBLE PRECISION,
    "open_interest" DOUBLE PRECISION,
    "market_cap" DOUBLE PRECISION,
    "atr" DOUBLE PRECISION,
    "rsi" DOUBLE PRECISION,
    "ema20" DOUBLE PRECISION,
    "ema50" DOUBLE PRECISION,
    "ema200" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" SERIAL NOT NULL,
    "coin_id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "type" "SignalType" NOT NULL DEFAULT 'LONG',
    "status" "SignalStatus" NOT NULL DEFAULT 'PENDING',
    "entry_price" DOUBLE PRECISION NOT NULL,
    "take_profit" DOUBLE PRECISION NOT NULL,
    "stop_loss" DOUBLE PRECISION NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" SERIAL NOT NULL,
    "coin_id" INTEGER NOT NULL,
    "signal_id" INTEGER,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'LONG',
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "entry_price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "take_profit" DOUBLE PRECISION NOT NULL,
    "stop_loss" DOUBLE PRECISION NOT NULL,
    "leverage" INTEGER NOT NULL DEFAULT 5,
    "current_price" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pnl_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "binance_order_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" SERIAL NOT NULL,
    "coin_id" INTEGER NOT NULL,
    "position_id" INTEGER,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'LONG',
    "entry_price" DOUBLE PRECISION NOT NULL,
    "exit_price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION NOT NULL,
    "pnl_pct" DOUBLE PRECISION NOT NULL,
    "close_reason" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs" (
    "id" SERIAL NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "scope" TEXT NOT NULL DEFAULT 'system',
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "coins_symbol_key" ON "coins"("symbol");

-- CreateIndex
CREATE INDEX "market_data_symbol_created_at_idx" ON "market_data"("symbol", "created_at");

-- CreateIndex
CREATE INDEX "signals_symbol_detected_at_idx" ON "signals"("symbol", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "positions_signal_id_key" ON "positions"("signal_id");

-- CreateIndex
CREATE INDEX "positions_symbol_status_idx" ON "positions"("symbol", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trades_position_id_key" ON "trades"("position_id");

-- CreateIndex
CREATE INDEX "trades_symbol_closed_at_idx" ON "trades"("symbol", "closed_at");

-- CreateIndex
CREATE INDEX "logs_scope_created_at_idx" ON "logs"("scope", "created_at");

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_data" ADD CONSTRAINT "market_data_coin_id_fkey" FOREIGN KEY ("coin_id") REFERENCES "coins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_coin_id_fkey" FOREIGN KEY ("coin_id") REFERENCES "coins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_coin_id_fkey" FOREIGN KEY ("coin_id") REFERENCES "coins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_coin_id_fkey" FOREIGN KEY ("coin_id") REFERENCES "coins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
