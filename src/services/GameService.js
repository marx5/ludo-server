import {
  switchToNextTurn,
  getValidPiecesToMove,
  makeBotDecision,
  movePieceInState,
  rollDiceForPlayer
} from '../core/gameEngine.js';
import { 
  delay, calculateMoveDelay, 
  BOT_THINK_BEFORE_ROLL_MS, BOT_ROLL_ANIMATION_MS, BOT_THINK_BEFORE_MOVE_MS, TURN_SWITCH_DELAY_MS, MOVE_TIMEOUT_MS 
} from '../core/constants.js';

export class GameService {
  constructor(io, getRoom) {
    this.io = {
      ...io,
      to: (roomId) => {
        const room = io.to(roomId);
        return {
          emit: (event, data) => {
            if (data && (event === 'game_state_updated' || event === 'game_started')) {
              data.serverTime = Date.now();
            }
            return room.emit(event, data);
          }
        };
      }
    };
    this.getRoom = getRoom;
  }

  processDiceRollResult(gameState, currentPlayer, val, pityActivated) {
    gameState.diceValue = val;
    gameState.hasRolled = true;

    if (val === 6) {
      gameState.consecutiveSixes = (gameState.consecutiveSixes || 0) + 1;
    } else {
      gameState.consecutiveSixes = 0;
    }

    gameState.timerEndAt = Date.now() + MOVE_TIMEOUT_MS;

    gameState.history.unshift({
      time: new Date().toLocaleTimeString(),
      message: `${currentPlayer.name} đã đổ được ${val} điểm.`
    });

    if (pityActivated) {
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `[Hệ thống] Hỗ trợ may mắn: Cưỡng bức xúc xắc ra 6 điểm cho ${currentPlayer.name}!`
      });
    }

    if (gameState.consecutiveSixes === 3) {
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `[Hệ thống] ${currentPlayer.name} đã đổ 6 ba lần liên tiếp! Bị mất lượt và lượt thứ ba không được tính.`
      });
      gameState.consecutiveSixes = 0;
      gameState.diceValue = null; // không tính điểm lần này
      gameState.hasMoved = true;  // khóa di chuyển
      return true; // Bị phạt mất lượt
    }
    return false; // Không bị phạt
  }

  async handleRollDice(socket, roomId) {
    const room = this.getRoom(roomId);
    if (!room || room.status !== 'playing' || !room.gameState) return;

    const gameState = room.gameState;
    const currentTurnColor = gameState.currentTurnColor;
    const currentPlayer = gameState.players.find(p => p.color === currentTurnColor);

    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit('error_message', { message: 'Không phải lượt của bạn!' });
      return;
    }

    if (gameState.hasRolled) {
      socket.emit('error_message', { message: 'Bạn đã đổ xúc xắc rồi!' });
      return;
    }

    if (room.rollTimer) clearTimeout(room.rollTimer);

    const { value: val, pityActivated } = rollDiceForPlayer(currentPlayer, gameState.pieces);
    const isPenalized = this.processDiceRollResult(gameState, currentPlayer, val, pityActivated);

    if (isPenalized) {
      this.io.to(roomId).emit('game_state_updated', gameState);
      await delay(TURN_SWITCH_DELAY_MS);
      if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;
      
      const nextState = switchToNextTurn(room.gameState);
      room.gameState = nextState;
      
      this.io.to(roomId).emit('game_state_updated', nextState);
      this.handleBotTurn(roomId);
      this.startTurnTimer(roomId);
      return;
    }

    const validPieces = getValidPiecesToMove(currentTurnColor, val, gameState.pieces, gameState.mode);
    
    if (validPieces.length === 0) {
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `${currentPlayer.name} không có nước đi hợp lệ.`
      });

      this.io.to(roomId).emit('game_state_updated', gameState);

      await delay(TURN_SWITCH_DELAY_MS);
      if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;
      
      const nextState = switchToNextTurn(room.gameState);
      room.gameState = nextState;
      
      this.io.to(roomId).emit('game_state_updated', nextState);

      this.handleBotTurn(roomId);
      this.startTurnTimer(roomId);
    } else {
      this.io.to(roomId).emit('game_state_updated', gameState);
      this.startTurnTimer(roomId);
    }
  }

  async handleMovePiece(socket, roomId, pieceId) {
    const room = this.getRoom(roomId);
    if (!room || room.status !== 'playing' || !room.gameState) return;

    const gameState = room.gameState;
    const currentTurnColor = gameState.currentTurnColor;
    const currentPlayer = gameState.players.find(p => p.color === currentTurnColor);

    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit('error_message', { message: 'Không phải lượt của bạn!' });
      return;
    }

    if (room.moveTimer) clearTimeout(room.moveTimer);

    const oldPiece = gameState.pieces.find(p => p.color === currentTurnColor && p.id === pieceId);
    if (!oldPiece) return;

    const diceVal = gameState.diceValue;
    const afterMoveState = movePieceInState(gameState, currentTurnColor, pieceId, diceVal);

    if (afterMoveState === gameState) {
      socket.emit('error_message', { message: 'Nước đi không hợp lệ!' });
      return;
    }

    room.gameState = afterMoveState;
    this.io.to(roomId).emit('game_state_updated', afterMoveState);

    const kickedPiece = gameState.pieces.find(p => p.position !== -1 && afterMoveState.pieces.find(ap => ap.color === p.color && ap.id === p.id).position === -1);
    
    const waitTime = calculateMoveDelay(oldPiece, diceVal, kickedPiece);

    await delay(waitTime);

    if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing' || !this.getRoom(roomId).gameState) return;
    const activeState = this.getRoom(roomId).gameState;
    
    if (activeState.hasMoved && activeState.currentTurnColor === currentTurnColor) {
      let finalState = activeState;
      if (activeState.status === 'playing') {
        finalState = switchToNextTurn(activeState);
      }

      this.getRoom(roomId).gameState = finalState;
      this.io.to(roomId).emit('game_state_updated', finalState);

      if (finalState.status === 'playing') {
        this.handleBotTurn(roomId);
        this.startTurnTimer(roomId);
      } else if (finalState.status === 'finished') {
        this.cleanupFinishedRoom(roomId);
      }
    }
  }

  async handleBotTurn(roomId) {
    const room = this.getRoom(roomId);
    if (!room || room.status !== 'playing' || !room.gameState) return;

    const gameState = room.gameState;
    const currentColor = gameState.currentTurnColor;
    const currentPlayer = gameState.players.find(p => p.color === currentColor);

    if (!currentPlayer || !currentPlayer.isBot) return;

    await delay(BOT_THINK_BEFORE_ROLL_MS);

    if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;

    const { value: diceVal, pityActivated } = rollDiceForPlayer(currentPlayer, gameState.pieces);
    const isPenalized = this.processDiceRollResult(gameState, currentPlayer, diceVal, pityActivated);

    if (isPenalized) {
      this.io.to(roomId).emit('game_state_updated', gameState);
      await delay(TURN_SWITCH_DELAY_MS);
      if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;

      const nextState = switchToNextTurn(gameState);
      this.getRoom(roomId).gameState = nextState;
      this.io.to(roomId).emit('game_state_updated', nextState);

      if (nextState.status === 'playing') {
        this.handleBotTurn(roomId);
        this.startTurnTimer(roomId);
      } else if (nextState.status === 'finished') {
        this.cleanupFinishedRoom(roomId);
      }
      return;
    }

    this.io.to(roomId).emit('game_state_updated', gameState);

    await delay(BOT_ROLL_ANIMATION_MS);
    if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;

    const validPieces = getValidPiecesToMove(currentColor, diceVal, gameState.pieces, gameState.mode);

    if (validPieces.length === 0) {
      gameState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `Bot ${currentPlayer.name} không có nước đi hợp lệ.`
      });
      
      const nextState = switchToNextTurn(gameState);
      this.getRoom(roomId).gameState = nextState;
      this.io.to(roomId).emit('game_state_updated', nextState);

      await delay(TURN_SWITCH_DELAY_MS);
      if (nextState.status === 'playing') {
        this.handleBotTurn(roomId);
        this.startTurnTimer(roomId);
      } else if (nextState.status === 'finished') {
        this.cleanupFinishedRoom(roomId);
      }
      return;
    }

    await delay(BOT_THINK_BEFORE_MOVE_MS);
    if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;

    let chosenPieceId = makeBotDecision(currentColor, diceVal, gameState.pieces, gameState.mode);
    if (chosenPieceId === null && validPieces.length > 0) {
      chosenPieceId = validPieces[0].id;
    }
    
    if (chosenPieceId !== null) {
      const oldPiece = gameState.pieces.find(p => p.color === currentColor && p.id === chosenPieceId);
      const afterMoveState = movePieceInState(gameState, currentColor, chosenPieceId, diceVal);
      
      this.getRoom(roomId).gameState = afterMoveState;
      this.io.to(roomId).emit('game_state_updated', afterMoveState);

      const kickedPiece = gameState.pieces.find(p => p.position !== -1 && afterMoveState.pieces.find(ap => ap.color === p.color && ap.id === p.id).position === -1);
      
      const waitTime = calculateMoveDelay(oldPiece, diceVal, kickedPiece);

      await delay(waitTime);

      if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing' || !this.getRoom(roomId).gameState) return;
      const activeState = this.getRoom(roomId).gameState;

      let finalState = afterMoveState;
      if (afterMoveState.status === 'playing') {
        finalState = switchToNextTurn(afterMoveState);
      }

      this.getRoom(roomId).gameState = finalState;
      this.io.to(roomId).emit('game_state_updated', finalState);

      if (finalState.status === 'playing') {
        this.handleBotTurn(roomId);
        this.startTurnTimer(roomId);
      } else if (finalState.status === 'finished') {
        this.cleanupFinishedRoom(roomId);
      }
    }
  }

  startTurnTimer(roomId) {
    const room = this.getRoom(roomId);
    if (!room || room.status !== 'playing' || !room.gameState) return;

    if (room.rollTimer) clearTimeout(room.rollTimer);
    if (room.moveTimer) clearTimeout(room.moveTimer);

    const gameState = room.gameState;
    const currentTurnColor = gameState.currentTurnColor;
    const currentPlayer = gameState.players.find(p => p.color === currentTurnColor);

    if (!currentPlayer || currentPlayer.isBot) return;

    const timeLeft = gameState.timerEndAt - Date.now();
    if (timeLeft <= 0) return;

    if (!gameState.hasRolled) {
      room.rollTimer = setTimeout(async () => {
        if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;
        const activeState = this.getRoom(roomId).gameState;
        if (activeState.hasRolled || activeState.currentTurnColor !== currentTurnColor) return;

        const { value: val } = rollDiceForPlayer(currentPlayer, activeState.pieces);
        activeState.history.unshift({
          time: new Date().toLocaleTimeString(),
          message: `[Hệ thống] Hết thời gian 15s! Tự động đổ xúc xắc cho ${currentPlayer.name}.`
        });
        const isPenalized = this.processDiceRollResult(activeState, currentPlayer, val, false);

        if (isPenalized) {
          this.io.to(roomId).emit('game_state_updated', activeState);
          await delay(TURN_SWITCH_DELAY_MS);
          if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;

          const nextState = switchToNextTurn(this.getRoom(roomId).gameState);
          this.getRoom(roomId).gameState = nextState;
          this.io.to(roomId).emit('game_state_updated', nextState);

          if (nextState.status === 'playing') {
            this.handleBotTurn(roomId);
            this.startTurnTimer(roomId);
          }
          return;
        }

        const validPieces = getValidPiecesToMove(currentTurnColor, val, activeState.pieces);
        
        if (validPieces.length === 0) {
          activeState.history.unshift({
            time: new Date().toLocaleTimeString(),
            message: `${currentPlayer.name} không có nước đi hợp lệ.`
          });
          this.io.to(roomId).emit('game_state_updated', activeState);

          await delay(TURN_SWITCH_DELAY_MS);
          
          if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;
          const nextState = switchToNextTurn(this.getRoom(roomId).gameState);
          this.getRoom(roomId).gameState = nextState;
          this.io.to(roomId).emit('game_state_updated', nextState);

          if (nextState.status === 'playing') {
            this.handleBotTurn(roomId);
            this.startTurnTimer(roomId);
          }
        } else {
          this.io.to(roomId).emit('game_state_updated', activeState);
          this.startTurnTimer(roomId);
        }
      }, timeLeft);
    } else if (!gameState.hasMoved) {
      room.moveTimer = setTimeout(async () => {
        if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;
        const activeState = this.getRoom(roomId).gameState;
        if (!activeState.hasRolled || activeState.hasMoved || activeState.currentTurnColor !== currentTurnColor) return;
        const validPieces = getValidPiecesToMove(currentTurnColor, activeState.diceValue, activeState.pieces);
        if (validPieces.length > 0) {
          const chosenPiece = validPieces[0];
          
          activeState.history.unshift({
            time: new Date().toLocaleTimeString(),
            message: `[Hệ thống] Hết thời gian 15s! Tự động đi quân #${chosenPiece.id + 1} cho ${currentPlayer.name}.`
          });

          const afterMoveState = movePieceInState(activeState, currentTurnColor, chosenPiece.id, activeState.diceValue);
          
          this.getRoom(roomId).gameState = afterMoveState;
          this.io.to(roomId).emit('game_state_updated', afterMoveState);

          const oldPiece = activeState.pieces.find(p => p.color === currentTurnColor && p.id === chosenPiece.id);
          const kickedPiece = activeState.pieces.find(p => p.position !== -1 && afterMoveState.pieces.find(ap => ap.color === p.color && ap.id === p.id).position === -1);
          
          const waitTime = calculateMoveDelay(oldPiece, activeState.diceValue, kickedPiece);

          await delay(waitTime);

          if (!this.getRoom(roomId) || this.getRoom(roomId).status !== 'playing') return;
          
          let finalState = afterMoveState;
          if (afterMoveState.status === 'playing') {
            finalState = switchToNextTurn(afterMoveState);
          }

          this.getRoom(roomId).gameState = finalState;
          this.io.to(roomId).emit('game_state_updated', finalState);

          if (finalState.status === 'playing') {
            this.handleBotTurn(roomId);
            this.startTurnTimer(roomId);
          } else if (finalState.status === 'finished') {
            this.cleanupFinishedRoom(roomId);
          }
        }
      }, timeLeft);
    }
  }

  // Dọn phòng đã kết thúc khỏi RAM để tránh rò rỉ bộ nhớ khi chạy lâu
  cleanupFinishedRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return;
    if (room.status !== 'finished') return;
    if (room.rollTimer) clearTimeout(room.rollTimer);
    if (room.moveTimer) clearTimeout(room.moveTimer);
    if (room.disconnectTimers) {
      Object.values(room.disconnectTimers).forEach(clearTimeout);
    }
    if (this.roomService && this.roomService.rooms) {
      delete this.roomService.rooms[roomId];
      console.log(`Room ${roomId} cleaned up (finished game released from memory)`);
    }
  }
}
