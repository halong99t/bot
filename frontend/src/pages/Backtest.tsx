import TrendFollowing from "./TrendFollowing";

/**
 * Trang Backtest — chỉ còn chiến lược TREND (Donchian breakout + regime).
 * (Mean Reversion đã bỏ khỏi UI; engine vẫn còn nếu cần dùng lại sau.)
 */
export default function Backtest() {
  return <TrendFollowing />;
}
