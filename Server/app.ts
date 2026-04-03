import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";
import uploadRoutes from "./routes/uploadRoutes";
import { uploadPath } from "./middlewares/upload";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/temp", express.static(uploadPath));
app.use("/", uploadRoutes);

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 90_000,    // Wait 90s before considering client dead
  pingInterval: 25_000,   // Ping every 25s
});

export { server, io };
