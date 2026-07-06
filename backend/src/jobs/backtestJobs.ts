import { BacktestResult } from "../services/backtest.service";

/**
 * Quản lý job backtest chạy nền (in-memory).
 * Dùng cho backtest toàn sàn — quá dài để chạy đồng bộ trong 1 request HTTP.
 */

export interface BacktestJob {
  id: string;
  status: "running" | "done" | "error";
  progress: number; // 0..total
  total: number;
  currentSymbol?: string;
  startedAt: number;
  finishedAt?: number;
  result?: BacktestResult;
  gridResult?: unknown; // kết quả grid search (GridResult)
  error?: string;
  note?: string; // tóm tắt job không phải backtest (vd: tải dữ liệu)
}

const jobs = new Map<string, BacktestJob>();
let counter = 0;

export function createJob(total: number): BacktestJob {
  counter += 1;
  const id = `bt_${Date.now()}_${counter}`;
  const job: BacktestJob = {
    id,
    status: "running",
    progress: 0,
    total,
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  // Dọn job cũ (>30 phút) để khỏi rò bộ nhớ
  for (const [k, v] of jobs) {
    if (Date.now() - v.startedAt > 30 * 60 * 1000) jobs.delete(k);
  }
  return job;
}

export function getJob(id: string): BacktestJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<BacktestJob>) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}
