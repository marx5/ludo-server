export function setupSocketHandlers(io, roomService, gameService) {
  io.on('connection', (socket) => {
    const sessionId = socket.handshake.query.sessionId;
    console.log(`Socket connected: ${socket.id}, sessionId: ${sessionId}`);

    // Tự động kết nối lại nếu có sessionId
    if (sessionId) {
      roomService.handleReconnect(socket, sessionId);
    }

    // Room Management
    socket.on('create_room', ({ playerName }) => roomService.createRoom(socket, playerName));
    socket.on('join_room', ({ roomId, playerName }) => roomService.joinRoom(socket, roomId, playerName));
    socket.on('change_mode', ({ roomId, mode }) => roomService.changeMode(socket, roomId, mode));
    socket.on('select_color', ({ roomId, color }) => roomService.selectColor(socket, roomId, color));
    socket.on('toggle_ready', ({ roomId }) => roomService.toggleReady(socket, roomId));
    socket.on('start_game', ({ roomId, includeBots }) => roomService.startGame(socket, roomId, includeBots));
    socket.on('send_chat', ({ roomId, message }) => roomService.sendChat(socket, roomId, message));
    socket.on('add_bot', ({ roomId, color }) => roomService.addBot(socket, roomId, color));
    socket.on('remove_bot', ({ roomId, botId }) => roomService.removeBot(socket, roomId, botId));
    socket.on('kick_player', ({ roomId, playerId }) => roomService.kickPlayer(socket, roomId, playerId));
    
    // Game Management
    socket.on('roll_dice', ({ roomId }) => gameService.handleRollDice(socket, roomId));
    socket.on('move_piece', ({ roomId, pieceId }) => gameService.handleMovePiece(socket, roomId, pieceId));
    socket.on('forfeit_rejoin', () => roomService.handleForfeitRejoin(socket));
    
    // Disconnect
    socket.on('disconnect', () => roomService.handleDisconnect(socket));
  });
}
