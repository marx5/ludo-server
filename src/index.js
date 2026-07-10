import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { RoomService } from './services/RoomService.js';
import { GameService } from './services/GameService.js';
import { setupSocketHandlers } from './handlers/socketHandler.js';

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Khởi tạo các Service
let roomService;
const gameService = new GameService(io, (roomId) => roomService.getRoom(roomId));
roomService = new RoomService(io, gameService);

// Thiết lập Socket Handlers
setupSocketHandlers(io, roomService, gameService);

const PORT = process.env.PORT || 4444;
httpServer.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
