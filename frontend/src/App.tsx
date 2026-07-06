import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import Layout from "./components/Layout";
import Overview from "./pages/Overview";
import Scanner from "./pages/Scanner";
import Signals from "./pages/Signals";
import Positions from "./pages/Positions";
import History from "./pages/History";
import Backtest from "./pages/Backtest";
import BacktestHistory from "./pages/BacktestHistory";
import BacktestHistoryDetail from "./pages/BacktestHistoryDetail";
import EmaClassifier from "./pages/EmaClassifier";
import LocalData from "./pages/LocalData";
import Settings from "./pages/Settings";
import { useWebSocket } from "./hooks/useWebSocket";

export default function App() {
  useWebSocket();

  return (
    <Layout>
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: "#1e2329",
            border: "1px solid #2b3139",
            color: "#e5e7eb",
          },
        }}
      />
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/scanner" element={<Scanner />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/positions" element={<Positions />} />
        <Route path="/history" element={<History />} />
        <Route path="/backtest" element={<Backtest />} />
        <Route path="/backtest-history" element={<BacktestHistory />} />
        <Route path="/backtest-history/:id" element={<BacktestHistoryDetail />} />
        <Route path="/ema" element={<EmaClassifier />} />
        <Route path="/trend" element={<Navigate to="/backtest" replace />} />
        <Route path="/local-data" element={<LocalData />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}
