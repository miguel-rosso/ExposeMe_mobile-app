import express from "express";
import { UploadRouter } from "../controllers/UploadController";
import { upload } from "../middlewares/upload";

const router = express.Router();

router.post("/upload", upload.single("image"), (req, res, next) => {
  UploadRouter(req, res).catch(next);
});

router.get("/", (_req, res) => {
  res.send("SERVER RUNNING");
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    timestamp: new Date().toISOString(),
  });
});

export default router;
