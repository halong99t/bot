import express from "express";
import cors from "cors";
import routes from "./routes";
import { notFound, errorHandler } from "./middleware/error";

export function createApp() {
  const app = express();

  app.use(cors());
  // Giới hạn lớn để nhận dữ liệu nến import (đã resample) từ frontend
  app.use(express.json({ limit: "80mb" }));

  app.use("/api", routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
