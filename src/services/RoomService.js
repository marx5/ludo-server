import { COLORS, initializeGameState } from '../core/gameEngine.js';

export class RoomService {
  constructor(io, gameService) {
    this.io = io;
    this.gameService = gameService;
    this.rooms = {};
  }

  getRoom(roomId) {
    return this.rooms[roomId];
  }

  generateRoomId() {
    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.rooms[roomId]);
    return roomId;
  }

  broadcastRoomUpdate(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;
    this.io.to(roomId).emit('room_updated', {
      roomId: room.roomId,
      creatorId: room.creatorId,
      players: room.players,
      status: room.status,
      mode: room.mode
    });
  }

  createRoom(socket, playerName) {
    const roomId = this.generateRoomId();
    
    this.rooms[roomId] = {
      roomId,
      creatorId: socket.id,
      players: [
        {
          id: socket.id,
          name: playerName || 'Người chơi 1',
          color: 'red',
          isReady: true,
          isBot: false
        }
      ],
      status: 'waiting',
      mode: '1vs1',
      gameState: null
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, players: this.rooms[roomId].players });
    console.log(`Room created: ${roomId} by ${socket.id}`);
  }

  joinRoom(socket, roomId, playerName) {
    const room = this.rooms[roomId];
    if (!room) {
      socket.emit('error_message', { message: 'Phòng không tồn tại!' });
      return;
    }

    if (room.status !== 'waiting') {
      socket.emit('error_message', { message: 'Phòng đấu đã bắt đầu hoặc đã kết thúc!' });
      return;
    }

    const limit = room.mode === '1vs1' ? 2 : 4;
    if (room.players.length >= limit) {
      socket.emit('error_message', { message: `Phòng đã đầy (tối đa ${limit} người chơi ở chế độ ${room.mode === '1vs1' ? '1vs1' : '2vs2'})!` });
      return;
    }

    const takenColors = room.players.map(p => p.color);
    const activeColors = room.mode === '1vs1' ? ['red', 'yellow'] : ['red', 'yellow', 'green', 'blue'];
    const availableColor = activeColors.find(c => !takenColors.includes(c)) || activeColors[0];

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
    this.broadcastRoomUpdate(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
  }

  changeMode(socket, roomId, mode) {
    const room = this.rooms[roomId];
    if (!room || room.creatorId !== socket.id) return;
    
    if (mode === '1vs1' && room.players.length > 2) {
      socket.emit('error_message', { message: 'Không thể chuyển sang 1vs1 vì phòng hiện tại đang có nhiều hơn 2 thành viên!' });
      return;
    }
    
    room.mode = mode;
    this.broadcastRoomUpdate(roomId);
  }

  selectColor(socket, roomId, color) {
    const room = this.rooms[roomId];
    if (!room || room.status !== 'waiting') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const colorTaken = room.players.some(p => p.color === color);
    if (colorTaken) {
      socket.emit('error_message', { message: 'Màu này đã có người khác chọn!' });
      return;
    }

    player.color = color;
    this.broadcastRoomUpdate(roomId);
  }

  addBot(socket, roomId, color = null) {
    const room = this.rooms[roomId];
    if (!room || room.creatorId !== socket.id || room.status !== 'waiting') return;

    const maxPlayers = room.mode === '1vs1' ? 2 : 4;
    if (room.players.length >= maxPlayers) {
      socket.emit('error_message', { message: 'Phòng đã đầy!' });
      return;
    }

    const availableColors = ['red', 'green', 'yellow', 'blue'];
    // Chọn màu được chỉ định hoặc màu trống đầu tiên
    const finalColor = color && availableColors.includes(color) && !room.players.some(p => p.color === color)
      ? color
      : availableColors.find(c => !room.players.some(p => p.color === c));
      
    if (!finalColor) return;

    room.players.push({
      id: `bot-${finalColor}-${Date.now()}`,
      name: 'Máy',
      color: finalColor,
      isReady: true,
      isBot: true
    });

    this.broadcastRoomUpdate(roomId);
  }

  removeBot(socket, roomId, botId) {
    const room = this.rooms[roomId];
    if (!room || room.creatorId !== socket.id || room.status !== 'waiting') return;

    room.players = room.players.filter(p => p.id !== botId);
    this.broadcastRoomUpdate(roomId);
  }

  kickPlayer(socket, roomId, playerId) {
    const room = this.rooms[roomId];
    if (!room || room.creatorId !== socket.id || room.status !== 'waiting') return;

    // Không tự kích chính mình
    if (playerId === socket.id) return;

    const kickedPlayer = room.players.find(p => p.id === playerId);
    if (!kickedPlayer) return;

    // Loại bỏ khỏi danh sách người chơi
    room.players = room.players.filter(p => p.id !== playerId);

    // Gửi event báo cho người bị kích để họ văng ra ngoài sảnh
    const kickedSocket = this.io.sockets.sockets.get(playerId);
    if (kickedSocket) {
      kickedSocket.emit('kicked_from_room');
      kickedSocket.leave(roomId);
    }

    this.broadcastRoomUpdate(roomId);
    console.log(`Player ${playerId} was kicked from room ${roomId} by host`);
  }

  toggleReady(socket, roomId) {
    const room = this.rooms[roomId];
    if (!room || room.status !== 'waiting') return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      if (room.creatorId === socket.id) {
        player.isReady = true;
      } else {
        player.isReady = !player.isReady;
      }
      this.broadcastRoomUpdate(roomId);
    }
  }

  startGame(socket, roomId, includeBots = false) {
    const room = this.rooms[roomId];
    if (!room || room.creatorId !== socket.id || room.status !== 'waiting') return;

    const maxPlayers = room.mode === '1vs1' ? 2 : 4;
    if (room.players.length !== maxPlayers) {
      socket.emit('error_message', { message: `Cần đủ ${maxPlayers} người chơi (hoặc máy) mới được bắt đầu!` });
      return;
    }

    const allReady = room.players.filter(p => p.id !== room.creatorId).every(p => p.isReady);
    if (!allReady) {
      socket.emit('error_message', { message: 'Vui lòng đợi tất cả người chơi sẵn sàng!' });
      return;
    }

    room.gameState = initializeGameState(room.players, room.mode);
    room.status = 'playing';

    this.io.to(roomId).emit('game_started', room.gameState);
    console.log(`Game started in room: ${roomId}`);

    this.gameService.handleBotTurn(roomId);
    this.gameService.startTurnTimer(roomId);
  }

  sendChat(socket, roomId, message) {
    const room = this.rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    this.io.to(roomId).emit('receive_chat', {
      senderName: player.name,
      senderColor: player.color,
      message: message,
      time: new Date().toLocaleTimeString()
    });
  }

  handleDisconnect(socket) {
    console.log(`Socket disconnected: ${socket.id}`);

    Object.keys(this.rooms).forEach(roomId => {
      const room = this.rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        const player = room.players[playerIndex];

        if (room.status === 'waiting') {
          room.players.splice(playerIndex, 1);
          
          if (room.players.length === 0) {
            if (room.rollTimer) clearTimeout(room.rollTimer);
            if (room.moveTimer) clearTimeout(room.moveTimer);
            delete this.rooms[roomId];
            console.log(`Room ${roomId} deleted (empty)`);
          } else {
            if (room.creatorId === socket.id) {
              room.creatorId = room.players[0].id;
              room.players[0].isReady = true;
            }
            this.broadcastRoomUpdate(roomId);
          }
        } else if (room.status === 'playing') {
          player.isBot = true;
          player.name = `${player.name} (Rời mạng / Máy)`;
          
          room.gameState.players.forEach(p => {
            if (p.id === socket.id) {
              p.isBot = true;
              p.name = `${p.name} (Rời mạng / Máy)`;
            }
          });

          const humanPlayers = room.players.filter(p => !p.isBot);
          if (humanPlayers.length === 0) {
            if (room.rollTimer) clearTimeout(room.rollTimer);
            if (room.moveTimer) clearTimeout(room.moveTimer);
            delete this.rooms[roomId];
            console.log(`Room ${roomId} deleted (no humans left in game)`);
            return;
          }

          room.gameState.history.unshift({
            time: new Date().toLocaleTimeString(),
            message: `${player.name} đã ngắt kết nối. Máy sẽ chơi thay thế!`
          });

          this.io.to(roomId).emit('game_state_updated', room.gameState);

          if (room.gameState.currentTurnColor === player.color) {
            this.gameService.handleBotTurn(roomId);
          }
        }
      }
    });
  }
}
