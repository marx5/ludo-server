import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import {
  initializeGameState,
  movePieceInState,
  switchToNextTurn,
  makeBotDecision,
  getValidPiecesToMove,
  rollDiceValue,
  rollDiceForPlayer,
  COLORS
} from './gameEngine.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), roomsCount: Object.keys(rooms).length });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Quản lý danh sách các phòng chơi trong bộ nhớ in-memory
const rooms = {};

// Hàm sinh mã phòng ngẫu nhiên 6 chữ số
function generateRoomId() {
  let roomId;
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms[roomId]);
  return roomId;
}

// Hàm gửi cập nhật thông tin phòng chờ cho tất cả clients trong phòng
function broadcastRoomUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room_updated', {
    roomId: room.roomId,
    creatorId: room.creatorId,
    players: room.players,
    status: room.status,
    mode: room.mode
  });
}

// Xử lý logic Bot tự động đi (chạy trên Server để đảm bảo đồng bộ)
function handleBotTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'playing' || !room.gameState) return;

  const gameState = room.gameState;
  const currentColor = gameState.currentTurnColor;
  const currentPlayer = gameState.players.find(p => p.color === currentColor);

  // Chỉ xử lý nếu người chơi hiện tại thực sự là Bot
  if (!currentPlayer || !currentPlayer.isBot) return;

  // Bước 1: Bot "suy nghĩ" rồi đổ xúc xắc (chờ 1.2 giây)
  setTimeout(() => {
    // Kiểm tra lại phòng xem có còn chơi không đề phòng bị huỷ giữa chừng
    if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;

    const { value: diceVal, pityActivated } = rollDiceForPlayer(currentPlayer, gameState.pieces);
    gameState.diceValue = diceVal;
    gameState.hasRolled = true;

    // Ghi nhận lịch sử đổ xúc xắc của Bot
    gameState.history.unshift({
      time: new Date().toLocaleTimeString(),
      message: `Bot ${currentPlayer.name} (${currentColor}) đã đổ được ${diceVal} điểm.`
    });

    if (pityActivated) {
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `[Hệ thống] Hỗ trợ may mắn: Cưỡng bức xúc xắc ra 6 điểm cho Bot ${currentPlayer.name}!`
      });
    }

    if (diceVal === 6 && gameState.consecutiveSixes >= 2) {
      // Bot đổ 6 ba lần liên tiếp -> Bị phạt mất lượt chơi và chuyển ngay sang người tiếp theo
      const nextState = switchToNextTurn(gameState);
      room.gameState = nextState;
      io.to(roomId).emit('game_state_updated', nextState);

      // Nếu lượt tiếp theo vẫn là Bot, tiếp tục chạy
      if (nextState.status === 'playing') {
        handleBotTurn(roomId);
      }
      return;
    }

    io.to(roomId).emit('game_state_updated', gameState);

    // Bước 2: Bot "suy nghĩ" rồi chọn quân di chuyển (chờ 1.5 giây)
    setTimeout(() => {
      if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;

      const validPieces = getValidPiecesToMove(currentColor, diceVal, gameState.pieces, gameState.mode);

      if (validPieces.length === 0) {
        // Không có nước đi hợp lệ, thông báo và chuyển lượt
        gameState.history.unshift({
          time: new Date().toLocaleTimeString(),
          message: `Bot ${currentPlayer.name} không có nước đi hợp lệ.`
        });
        
        const nextState = switchToNextTurn(gameState);
        room.gameState = nextState;
        io.to(roomId).emit('game_state_updated', nextState);

        // Nếu lượt tiếp theo vẫn là Bot, tiếp tục chạy đệ quy
        if (nextState.status === 'playing') {
          handleBotTurn(roomId);
        }
        return;
      }

      // Chọn quân cờ tối ưu bằng Bot AI Decision
      const chosenPieceId = makeBotDecision(currentColor, diceVal, gameState.pieces, gameState.mode);
      
      if (chosenPieceId !== null) {
        let afterMoveState = movePieceInState(gameState, currentColor, chosenPieceId, diceVal);
        
        // Cập nhật vị trí cờ để chạy hoạt cảnh di chuyển cờ (chưa chuyển lượt)
        room.gameState = afterMoveState;
        io.to(roomId).emit('game_state_updated', afterMoveState);

        // Tính toán độ trễ dựa trên số bước nhảy của quân cờ tiến và quân cờ bị đá chạy lùi (nếu có)
        const oldPiece = gameState.pieces.find(p => p.color === currentColor && p.id === chosenPieceId);
        const steps = (oldPiece && oldPiece.position === -1) ? 1 : diceVal;
        const durationForward = steps * 240 + 200; // 240ms mỗi ô lò cò + 200ms dừng chân

        const kickedPiece = gameState.pieces.find(p => p.position !== -1 && afterMoveState.pieces.find(ap => ap.color === p.color && ap.id === p.id).position === -1);
        const durationBackward = kickedPiece ? (durationForward + kickedPiece.stepCount * 60 + 100) : 0; // lùi 60ms mỗi ô sau khi quân tiến đi xong

        const delay = kickedPiece ? durationBackward : durationForward;

        // Trì hoãn chuyển lượt trên server để client kịp chạy hoạt cảnh
        setTimeout(() => {
          if (!rooms[roomId] || rooms[roomId].status !== 'playing' || !rooms[roomId].gameState) return;
          const activeState = rooms[roomId].gameState;

          let finalState = activeState;
          if (activeState.status === 'playing') {
            finalState = switchToNextTurn(activeState);
          }

          rooms[roomId].gameState = finalState;
          io.to(roomId).emit('game_state_updated', finalState);

          // Nếu game chưa kết thúc và lượt tiếp theo vẫn là Bot, chạy tiếp
          if (finalState.status === 'playing') {
            handleBotTurn(roomId);
          }
        }, delay);
      }
    }, 1500);

  }, 1200);
}

// Xử lý đếm ngược thời gian (30s roll, 30s move) cho người chơi Human online
function startServerTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'playing' || !room.gameState) return;

  // Hủy các timer cũ
  if (room.rollTimer) clearTimeout(room.rollTimer);
  if (room.moveTimer) clearTimeout(room.moveTimer);

  const gameState = room.gameState;
  const currentTurnColor = gameState.currentTurnColor;
  const currentPlayer = gameState.players.find(p => p.color === currentTurnColor);

  // Chỉ kích hoạt timer cho người chơi con người (Human)
  if (!currentPlayer || currentPlayer.isBot) return;

  const timeLeft = gameState.timerEndAt - Date.now();
  if (timeLeft <= 0) return;

  if (!gameState.hasRolled) {
    // 1. Roll Timeout (30 giây)
    room.rollTimer = setTimeout(() => {
      if (!rooms[roomId] || rooms[roomId].status !== 'playing' || !rooms[roomId].gameState) return;
      const activeState = rooms[roomId].gameState;
      if (activeState.hasRolled || activeState.currentTurnColor !== currentTurnColor) return;

      // Tự động đổ xúc xắc
      const { value: val, pityActivated } = rollDiceForPlayer(currentPlayer, activeState.pieces);
      activeState.diceValue = val;
      activeState.hasRolled = true;
      activeState.timerEndAt = Date.now() + 30000; // Đặt hạn chót đi cờ

      activeState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `[Hệ thống] Hết thời gian 30s! Tự động đổ xúc xắc cho ${currentPlayer.name}.`
      });

      if (pityActivated) {
        activeState.history.unshift({
          time: new Date().toLocaleTimeString(),
          message: `[Hệ thống] Hỗ trợ may mắn: Cưỡng bức xúc xắc ra 6 điểm cho ${currentPlayer.name}!`
        });
      }

      activeState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `${currentPlayer.name} (${currentTurnColor}) đã đổ được ${val} điểm.`
      });

      // Kiểm tra xem có đi được quân nào không
      const validPieces = getValidPiecesToMove(currentTurnColor, val, activeState.pieces);
      
      if (validPieces.length === 0) {
        activeState.history.unshift({
          time: new Date().toLocaleTimeString(),
          message: `${currentPlayer.name} không có nước đi hợp lệ.`
        });
        io.to(roomId).emit('game_state_updated', activeState);

        setTimeout(() => {
          if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;
          const nextState = switchToNextTurn(rooms[roomId].gameState);
          rooms[roomId].gameState = nextState;
          io.to(roomId).emit('game_state_updated', nextState);

          if (nextState.status === 'playing') {
            handleBotTurn(roomId);
            startServerTurnTimer(roomId);
          }
        }, 1500);
      } else {
        io.to(roomId).emit('game_state_updated', activeState);
        // Bắt đầu đếm ngược 30s đi cờ
        startServerTurnTimer(roomId);
      }
    }, timeLeft);
  } else if (!gameState.hasMoved) {
    // 2. Move Timeout (30 giây)
    room.moveTimer = setTimeout(() => {
      if (!rooms[roomId] || rooms[roomId].status !== 'playing' || !rooms[roomId].gameState) return;
      const activeState = rooms[roomId].gameState;
      if (!activeState.hasRolled || activeState.hasMoved || activeState.currentTurnColor !== currentTurnColor) return;

      const validPieces = getValidPiecesToMove(currentTurnColor, activeState.diceValue, activeState.pieces);
      if (validPieces.length > 0) {
        const chosenPiece = validPieces[0];
        
        activeState.history.unshift({
          time: new Date().toLocaleTimeString(),
          message: `[Hệ thống] Hết thời gian 30s! Tự động đi quân #${chosenPiece.id + 1} cho ${currentPlayer.name}.`
        });

        const afterMoveState = movePieceInState(activeState, currentTurnColor, chosenPiece.id, activeState.diceValue);
        
        rooms[roomId].gameState = afterMoveState;
        io.to(roomId).emit('game_state_updated', afterMoveState);

        // Tính delay hoạt cảnh lò cò tiến và lùi (nếu có)
        const oldPiece = activeState.pieces.find(p => p.color === currentTurnColor && p.id === chosenPiece.id);
        const steps = (oldPiece && oldPiece.position === -1) ? 1 : activeState.diceValue;
        const durationForward = steps * 240 + 200;

        const kickedPiece = activeState.pieces.find(p => p.position !== -1 && afterMoveState.pieces.find(ap => ap.color === p.color && ap.id === p.id).position === -1);
        const durationBackward = kickedPiece ? (kickedPiece.stepCount * 80 + 200) : 0;

        const delay = Math.max(durationForward, durationBackward);

        setTimeout(() => {
          if (!rooms[roomId] || rooms[roomId].status !== 'playing' || !rooms[roomId].gameState) return;
          const finalActiveState = rooms[roomId].gameState;
          
          if (finalActiveState.hasMoved && finalActiveState.currentTurnColor === currentTurnColor) {
            let finalState = finalActiveState;
            if (finalActiveState.status === 'playing') {
              finalState = switchToNextTurn(finalActiveState);
            }

            rooms[roomId].gameState = finalState;
            io.to(roomId).emit('game_state_updated', finalState);

            if (finalState.status === 'playing') {
              handleBotTurn(roomId);
              startServerTurnTimer(roomId);
            }
          }
        }, delay);
      }
    }, timeLeft);
  }
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // 1. TẠO PHÒNG CHƠI
  socket.on('create_room', ({ playerName }) => {
    const roomId = generateRoomId();
    
    rooms[roomId] = {
      roomId,
      creatorId: socket.id,
      players: [
        {
          id: socket.id,
          name: playerName || 'Chủ phòng',
          color: 'red', // Mặc định người đầu tiên màu đỏ
          isReady: true,
          isBot: false
        }
      ],
      status: 'waiting',
      mode: 'classic',
      gameState: null
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, players: rooms[roomId].players });
    console.log(`Room created: ${roomId} by ${socket.id}`);
  });

  // 2. THAM GIA PHÒNG
  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error_message', { message: 'Phòng không tồn tại!' });
      return;
    }

    if (room.status !== 'waiting') {
      socket.emit('error_message', { message: 'Phòng đấu đã bắt đầu hoặc đã kết thúc!' });
      return;
    }

    if (room.players.length >= 4) {
      socket.emit('error_message', { message: 'Phòng đã đầy (tối đa 4 người chơi)!' });
      return;
    }

    // Chọn màu trống cho người chơi mới gia nhập
    const takenColors = room.players.map(p => p.color);
    const availableColor = COLORS.find(c => !takenColors.includes(c)) || 'green';

    const newPlayer = {
      id: socket.id,
      name: playerName || `Người chơi ${room.players.length + 1}`,
      color: availableColor,
      isReady: false,
      isBot: false
    };

    room.players.push(newPlayer);
    socket.join(roomId);
    
    socket.emit('room_joined', { roomId, players: room.players });
    broadcastRoomUpdate(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  // 3. THAY ĐỔI CHẾ ĐỘ CHƠI (Chỉ chủ phòng)
  socket.on('change_mode', ({ roomId, mode }) => {
    const room = rooms[roomId];
    if (!room || room.creatorId !== socket.id) return;

    room.mode = mode; // 'classic' | '1vs1' | '2vs2'
    broadcastRoomUpdate(roomId);
  });

  // 4. CHỌN MÀU QUÂN CỜ
  socket.on('select_color', ({ roomId, color }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'waiting') return;

    // Kiểm tra màu có bị trùng không
    const isColorTaken = room.players.some(p => p.color === color && p.id !== socket.id);
    if (isColorTaken) {
      socket.emit('error_message', { message: 'Màu sắc này đã có người chọn!' });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.color = color;
      broadcastRoomUpdate(roomId);
    }
  });

  // 5. BẤM SẴN SÀNG (READY)
  socket.on('toggle_ready', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'waiting') return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      // Chủ phòng luôn luôn sẵn sàng
      if (room.creatorId === socket.id) {
        player.isReady = true;
      } else {
        player.isReady = !player.isReady;
      }
      broadcastRoomUpdate(roomId);
    }
  });

  // 6. BẮT ĐẦU GAME (START GAME - Chỉ dành cho chủ phòng)
  socket.on('start_game', ({ roomId, includeBots = false }) => {
    const room = rooms[roomId];
    if (!room || room.creatorId !== socket.id || room.status !== 'waiting') return;

    // Kiểm tra nếu tất cả mọi người (không phải chủ phòng) đã sẵn sàng chưa
    const allReady = room.players.filter(p => p.id !== room.creatorId).every(p => p.isReady);
    if (!allReady) {
      socket.emit('error_message', { message: 'Vui lòng đợi tất cả người chơi sẵn sàng!' });
      return;
    }

    // Điền Bot vào các vị trí trống nếu được yêu cầu hoặc nếu số người chơi chưa đủ 4
    if (includeBots || room.mode === '2vs2' || room.mode === 'classic') {
      const currentColors = room.players.map(p => p.color);
      let botCount = 1;
      
      COLORS.forEach(color => {
        if (!currentColors.includes(color)) {
          // Thêm Bot
          room.players.push({
            id: `bot-${color}-${Date.now()}`,
            name: `Máy (${color.toUpperCase()})`,
            color: color,
            isReady: true,
            isBot: true
          });
          botCount++;
        }
      });
    }

    // Khởi tạo Game State bằng Engine
    room.gameState = initializeGameState(room.players, room.mode);
    room.status = 'playing';

    io.to(roomId).emit('game_started', room.gameState);
    console.log(`Game started in room: ${roomId}`);

    // Kiểm tra xem lượt đầu tiên có phải là Bot không để kích hoạt Bot đi hộ, bắt đầu timer
    handleBotTurn(roomId);
    startServerTurnTimer(roomId);
  });

  // 7. ĐỔ XÚC XẮC (ONLINE)
  socket.on('roll_dice', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing' || !room.gameState) return;

    const gameState = room.gameState;
    const currentTurnColor = gameState.currentTurnColor;
    const currentPlayer = gameState.players.find(p => p.color === currentTurnColor);

    // Kiểm tra xem có đúng lượt socket hiện tại hay không
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit('error_message', { message: 'Không phải lượt của bạn!' });
      return;
    }

    if (gameState.hasRolled) {
      socket.emit('error_message', { message: 'Bạn đã đổ xúc xắc rồi!' });
      return;
    }

    // Hủy timer đổ xúc xắc
    if (room.rollTimer) clearTimeout(room.rollTimer);

    // Tiến hành đổ xúc xắc
    const { value: val, pityActivated } = rollDiceForPlayer(currentPlayer, gameState.pieces);
    gameState.diceValue = val;
    gameState.hasRolled = true;
    gameState.timerEndAt = Date.now() + 30000; // Đặt hạn chót đi cờ (30s)

    // Log lịch sử
    gameState.history.unshift({
      time: new Date().toLocaleTimeString(),
      message: `${currentPlayer.name} (${currentTurnColor}) đã đổ được ${val} điểm.`
    });

    if (pityActivated) {
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `[Hệ thống] Hỗ trợ may mắn: Cưỡng bức xúc xắc ra 6 điểm cho ${currentPlayer.name}!`
      });
    }

    if (val === 6 && gameState.consecutiveSixes >= 2) {
      // Người chơi đổ 6 ba lần liên tiếp -> Bị phạt mất lượt chơi và chuyển ngay sang người tiếp theo
      const nextState = switchToNextTurn(gameState);
      room.gameState = nextState;
      io.to(roomId).emit('game_state_updated', nextState);

      // Kích hoạt Bot đi nếu lượt tiếp theo là Bot, bắt đầu timer
      handleBotTurn(roomId);
      startServerTurnTimer(roomId);
      return;
    }

    // Kiểm tra xem người chơi này có đi được quân nào không
    const validPieces = getValidPiecesToMove(currentTurnColor, val, gameState.pieces, gameState.mode);
    
    if (validPieces.length === 0) {
      // Không có nước đi hợp lệ nào -> Tự động chuyển lượt sau 1.5 giây
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `${currentPlayer.name} không có nước đi hợp lệ.`
      });

      io.to(roomId).emit('game_state_updated', gameState);

      setTimeout(() => {
        if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;
        
        const nextState = switchToNextTurn(room.gameState);
        room.gameState = nextState;
        
        io.to(roomId).emit('game_state_updated', nextState);

        // Kích hoạt Bot đi nếu lượt tiếp theo là Bot, bắt đầu timer
        handleBotTurn(roomId);
        startServerTurnTimer(roomId);
      }, 1500);
    } else {
      // Có nước đi hợp lệ -> Phát sóng trạng thái để người chơi chọn quân cờ, bắt đầu timer 60s đi cờ
      io.to(roomId).emit('game_state_updated', gameState);
      startServerTurnTimer(roomId);
    }
  });

  // 8. DI CHUYỂN QUÂN CỜ (ONLINE)
  socket.on('move_piece', ({ roomId, pieceId }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing' || !room.gameState) return;

    const gameState = room.gameState;
    const currentTurnColor = gameState.currentTurnColor;
    const currentPlayer = gameState.players.find(p => p.color === currentTurnColor);

    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit('error_message', { message: 'Không phải lượt của bạn!' });
      return;
    }

    // Hủy timer đi cờ
    if (room.moveTimer) clearTimeout(room.moveTimer);

    const oldPiece = gameState.pieces.find(p => p.color === currentTurnColor && p.id === pieceId);
    if (!oldPiece) return;

    // Thực hiện di chuyển quân cờ bằng Engine
    const diceVal = gameState.diceValue;
    const afterMoveState = movePieceInState(gameState, currentTurnColor, pieceId, diceVal);

    if (afterMoveState === gameState) {
      socket.emit('error_message', { message: 'Nước đi không hợp lệ!' });
      return;
    }

    // Cập nhật vị trí cờ để chạy hoạt cảnh di chuyển cờ (chưa chuyển lượt)
    room.gameState = afterMoveState;
    io.to(roomId).emit('game_state_updated', afterMoveState);

    // Tính toán độ trễ dựa trên số bước nhảy của quân cờ tiến và quân cờ bị đá chạy lùi (nếu có)
    const steps = (oldPiece.position === -1) ? 1 : diceVal;
    const durationForward = steps * 240 + 200; // 240ms mỗi ô lò cò + 200ms dừng chân

    const kickedPiece = gameState.pieces.find(p => p.position !== -1 && afterMoveState.pieces.find(ap => ap.color === p.color && ap.id === p.id).position === -1);
    const durationBackward = kickedPiece ? (durationForward + kickedPiece.stepCount * 60 + 100) : 0; // lùi 60ms mỗi ô sau khi quân tiến đi xong

    const delay = kickedPiece ? durationBackward : durationForward;

    // Trì hoãn chuyển lượt trên máy chủ để client hoàn thành hoạt cảnh lò cò
    setTimeout(() => {
      if (!rooms[roomId] || rooms[roomId].status !== 'playing' || !rooms[roomId].gameState) return;
      const activeState = rooms[roomId].gameState;
      
      if (activeState.hasMoved && activeState.currentTurnColor === currentTurnColor) {
        let finalState = activeState;
        if (activeState.status === 'playing') {
          finalState = switchToNextTurn(activeState);
        }

        rooms[roomId].gameState = finalState;
        io.to(roomId).emit('game_state_updated', finalState);

        // Kích hoạt Bot đi nếu lượt tiếp theo là Bot, bắt đầu timer
        if (finalState.status === 'playing') {
          handleBotTurn(roomId);
          startServerTurnTimer(roomId);
        }
      }
    }, delay);
  });

  // 9. GỬI TIN NHẮN CHAT
  socket.on('send_chat', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(roomId).emit('receive_chat', {
      senderName: player.name,
      senderColor: player.color,
      message: message,
      time: new Date().toLocaleTimeString()
    });
  });

  // 10. MẤT KẾT NỐI (DISCONNECT)
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);

    // Quét qua các phòng để xử lý người chơi ngắt kết nối
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        const player = room.players[playerIndex];

        if (room.status === 'waiting') {
          // Nếu đang ở phòng chờ, xóa người chơi ra khỏi phòng
          room.players.splice(playerIndex, 1);
          
          if (room.players.length === 0) {
            // Phòng không còn ai -> Xóa phòng, dọn dẹp timer
            if (room.rollTimer) clearTimeout(room.rollTimer);
            if (room.moveTimer) clearTimeout(room.moveTimer);
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted (empty)`);
          } else {
            // Nếu chủ phòng thoát, nhường quyền chủ phòng cho người tiếp theo
            if (room.creatorId === socket.id) {
              room.creatorId = room.players[0].id;
              // Chủ phòng mới tự động sẵn sàng
              room.players[0].isReady = true;
            }
            broadcastRoomUpdate(roomId);
          }
        } else if (room.status === 'playing') {
          // Nếu đang chơi game, biến người chơi mất kết nối thành BOT để tiếp tục trận đấu mượt mà
          player.isBot = true;
          player.name = `${player.name} (Rời mạng / Máy)`;
          
          room.gameState.players.forEach(p => {
            if (p.id === socket.id) {
              p.isBot = true;
              p.name = `${p.name} (Rời mạng / Máy)`;
            }
          });

          // Kiểm tra xem phòng còn người chơi human nào không
          const humanPlayers = room.players.filter(p => !p.isBot);
          if (humanPlayers.length === 0) {
            // Không còn ai chơi -> Xóa phòng, dọn dẹp timer
            if (room.rollTimer) clearTimeout(room.rollTimer);
            if (room.moveTimer) clearTimeout(room.moveTimer);
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted (no humans left in game)`);
            return;
          }

          room.gameState.history.unshift({
            time: new Date().toLocaleTimeString(),
            message: `${player.name} đã ngắt kết nối. Máy sẽ chơi thay thế!`
          });

          io.to(roomId).emit('game_state_updated', room.gameState);

          // Nếu đến đúng lượt của người vừa thoát (bây giờ là bot), kích hoạt lượt bot đi hộ
          if (room.gameState.currentTurnColor === player.color) {
            handleBotTurn(roomId);
          }
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
