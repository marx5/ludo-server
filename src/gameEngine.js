// Định nghĩa thứ tự màu cờ và ô xuất phát tuyệt đối trên vòng tròn chung 52 ô
export const COLORS = ['red', 'green', 'yellow', 'blue'];

export const START_POSITIONS = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39
};

// Các ô an toàn trên vòng tròn chung (gồm các ô xuất phát và các ô ngôi sao)
export const SAFE_ZONES = [0, 8, 13, 21, 26, 34, 39, 47];

// Khởi tạo trạng thái quân cờ
export function createInitialPieces() {
  const pieces = [];
  COLORS.forEach(color => {
    for (let id = 0; id < 4; id++) {
      pieces.push({
        id, // 0, 1, 2, 3
        color,
        position: -1, // -1 nghĩa là đang ở Sân nhà (Yard)
        stepCount: 0  // Số bước đã di chuyển (0: ở sân nhà, 1: ô xuất phát, 57: ô cuối đường chuồng, 58: về đích)
      });
    }
  });
  return pieces;
}

// Tính toán vị trí bàn cờ tuyệt đối (board position) dựa trên màu và stepCount
export function getBoardPosition(color, stepCount) {
  if (stepCount === 0) return -1; // Ở sân nhà
  if (stepCount === 58) return 100; // Đã về đích (Home)

  const startPos = START_POSITIONS[color];
  if (stepCount <= 51) {
    // Trên vòng chạy chung 52 ô (0 -> 51)
    return (startPos + stepCount - 1) % 52;
  } else {
    // Trên đường lên chuồng riêng (52 -> 57)
    // Trả về một mã định danh duy nhất cho ô chuồng, ví dụ: "red-home-0", "green-home-3"
    return `${color}-home-${stepCount - 52}`;
  }
}

// Kiểm tra xem quân cờ có thể di chuyển với số nút xúc xắc hiện tại không
export function canPieceMove(piece, diceValue, pieces) {
  // Nếu ở Yard (Sân nhà)
  if (piece.position === -1) {
    // Phải đổ được 6 để ra quân
    return diceValue === 6;
  }

  // Nếu đã về đích
  if (piece.stepCount === 58) {
    return false;
  }

  const nextStepCount = piece.stepCount + diceValue;
  // Không được vượt quá ô đích (58)
  if (nextStepCount > 58) {
    return false;
  }

  return true;
}

// Lấy danh sách quân cờ hợp lệ có thể đi của một người chơi
export function getValidPiecesToMove(color, diceValue, pieces) {
  return pieces.filter(p => p.color === color && canPieceMove(p, diceValue, pieces));
}

// Đổ xúc xắc ngẫu nhiên từ 1 đến 6
export function rollDiceValue() {
  return Math.floor(Math.random() * 6) + 1;
}

// Đổ xúc xắc có hỗ trợ cơ chế Pity 6 điểm (Hỗ trợ may mắn ra quân lần đầu)
export function rollDiceForPlayer(player, pieces) {
  let val = rollDiceValue();
  
  if (player.pityCounter === undefined) player.pityCounter = 0;
  if (player.hasReleasedFirstPiece === undefined) player.hasReleasedFirstPiece = false;

  const playerPieces = pieces.filter(p => p.color === player.color);
  const allInYard = playerPieces.every(p => p.position === -1);
  const hasReleased = !!player.hasReleasedFirstPiece;

  if (allInYard && !hasReleased) {
    if (val === 6) {
      player.pityCounter = 0;
      player.hasReleasedFirstPiece = true;
    } else {
      player.pityCounter += 1;
      if (player.pityCounter >= 10) {
        val = 6;
        player.pityCounter = 0;
        player.hasReleasedFirstPiece = true;
        return { value: val, pityActivated: true };
      }
    }
  }

  return { value: val, pityActivated: false };
}

// Khởi tạo Game State ban đầu
export function initializeGameState(playersInput, mode = 'classic') {
  // playersInput: mảng các player { id, name, color, isBot }
  // Sắp xếp người chơi theo thứ tự màu red -> green -> yellow -> blue
  const players = [];
  COLORS.forEach(color => {
    const p = playersInput.find(pi => pi.color === color);
    if (p) {
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        isBot: !!p.isBot,
        isReady: true,
        pityCounter: 0,
        hasReleasedFirstPiece: false
      });
    }
  });

  const pieces = createInitialPieces().filter(piece => 
    players.some(p => p.color === piece.color)
  );

  return {
    players,
    pieces,
    mode, // 'classic' (4 người chơi tự do), '1vs1' (2 người chơi), '2vs2' (đồng đội)
    turnIndex: 0, // Người chơi đầu tiên trong danh sách players
    currentTurnColor: players[0] ? players[0].color : 'red',
    diceValue: null,
    hasRolled: false,
    hasMoved: false,
    consecutiveSixes: 0, // Số lần đổ được 6 liên tục của người chơi hiện tại
    bonusRoll: false, // Có được đổ tiếp không (do đổ được 6, đá quân, hoặc về đích)
    status: 'playing', // 'waiting' | 'playing' | 'finished'
    winner: null, // Đội thắng hoặc Player thắng
    history: [],
    lastActionTime: Date.now(),
    timerEndAt: Date.now() + 30000 // Hạn chót đổ xúc xắc (30s)
  };
}

// Di chuyển một quân cờ
export function movePieceInState(gameState, color, pieceId, diceValue) {
  if (gameState.status !== 'playing') return gameState;
  if (gameState.currentTurnColor !== color) return gameState;
  if (!gameState.hasRolled || gameState.hasMoved) return gameState;

  const newState = JSON.parse(JSON.stringify(gameState)); // Deep clone
  const piece = newState.pieces.find(p => p.color === color && p.id === pieceId);

  if (!piece || !canPieceMove(piece, diceValue, newState.pieces)) {
    return gameState; // Không di chuyển được
  }

  let eventMessage = '';
  let hitOpponent = false;
  let reachedHome = false;

  if (piece.position === -1 && diceValue === 6) {
    // Ra quân
    piece.stepCount = 1;
    piece.position = START_POSITIONS[color];
    eventMessage = `${newState.players.find(p => p.color === color)?.name} đã xuất quân!`;
    
    // Đánh dấu đã ra quân thành công lần đầu tiên
    const playerObj = newState.players.find(p => p.color === color);
    if (playerObj) {
      playerObj.hasReleasedFirstPiece = true;
      playerObj.pityCounter = 0;
    }
  } else {
    // Di chuyển quân
    piece.stepCount += diceValue;
    const newPos = getBoardPosition(color, piece.stepCount);
    piece.position = newPos;

    eventMessage = `${newState.players.find(p => p.color === color)?.name} đã di chuyển quân #${pieceId + 1} thêm ${diceValue} ô.`;

    if (piece.stepCount === 58) {
      reachedHome = true;
      eventMessage = `${newState.players.find(p => p.color === color)?.name} đã đưa quân #${pieceId + 1} về đích!`;
    }
  }

  // Kiểm tra đá quân (chỉ đá nếu ở vòng chạy chung và không ở ô an toàn)
  if (piece.stepCount > 0 && piece.stepCount <= 51) {
    const currentBoardPos = piece.position;
    const isSafe = SAFE_ZONES.includes(currentBoardPos);

    if (!isSafe) {
      newState.pieces.forEach(p => {
        // Chỉ đá quân của đối thủ (không phải của mình và không phải của đồng đội nếu chơi 2vs2)
        const isTeammate = isTeammateColor(color, p.color, newState.mode);
        if (p.color !== color && !isTeammate && p.position === currentBoardPos) {
          // Đá quân này về Yard
          p.position = -1;
          p.stepCount = 0;
          hitOpponent = true;
          const opponentName = newState.players.find(pl => pl.color === p.color)?.name || p.color;
          eventMessage += ` và ĐÁ quân của ${opponentName} về chuồng!`;
        }
      });
    }
  }

  // Ghi nhận hành động đã di chuyển
  newState.hasMoved = true;
  newState.lastActionTime = Date.now();

  // Xác định xem có được lượt đổ thưởng (bonus roll) không
  // Được thưởng lượt đổ nếu: Đổ được 6, đá được quân đối thủ, hoặc đưa quân về đích.
  if (diceValue === 6 || hitOpponent || reachedHome) {
    newState.bonusRoll = true;
  }

  // Thêm vào lịch sử
  newState.history.unshift({
    time: new Date().toLocaleTimeString(),
    message: eventMessage
  });

  // Kiểm tra thắng cuộc
  const isFinished = checkGameWinner(newState);
  if (isFinished) {
    newState.status = 'finished';
    newState.winner = getWinnerInfo(newState);
    newState.history.unshift({
      time: new Date().toLocaleTimeString(),
      message: `Trò chơi kết thúc! Người chiến thắng: ${newState.winner.name}`
    });
  }

  return newState;
}

// Kiểm tra xem hai màu có phải là đồng đội không (trong chế độ 2vs2)
export function isTeammateColor(color1, color2, mode) {
  if (mode !== '2vs2') return false;
  // Đội 1: Red + Yellow
  // Đội 2: Green + Blue
  const team1 = ['red', 'yellow'];
  const team2 = ['green', 'blue'];
  return (team1.includes(color1) && team1.includes(color2)) || 
         (team2.includes(color1) && team2.includes(color2));
}

// Kiểm tra xem trò chơi đã kết thúc chưa
export function checkGameWinner(gameState) {
  const { pieces, mode, players } = gameState;

  if (mode === '2vs2') {
    // Chế độ đồng đội: Đội thắng khi cả 2 thành viên đều đưa hết 4 quân về đích (tổng cộng 8 quân)
    // Đội Red-Yellow
    const redPieces = pieces.filter(p => p.color === 'red');
    const yellowPieces = pieces.filter(p => p.color === 'yellow');
    const teamRedYellowFinished = 
      (redPieces.length === 0 || redPieces.every(p => p.stepCount === 58)) &&
      (yellowPieces.length === 0 || yellowPieces.every(p => p.stepCount === 58));

    // Đội Green-Blue
    const greenPieces = pieces.filter(p => p.color === 'green');
    const bluePieces = pieces.filter(p => p.color === 'blue');
    const teamGreenBlueFinished = 
      (greenPieces.length === 0 || greenPieces.every(p => p.stepCount === 58)) &&
      (bluePieces.length === 0 || bluePieces.every(p => p.stepCount === 58));

    return teamRedYellowFinished || teamGreenBlueFinished;
  } else {
    // Chế độ classic hoặc 1vs1: Bất kỳ người chơi nào đưa đủ 4 quân về đích đầu tiên sẽ thắng
    return players.some(player => {
      const playerPieces = pieces.filter(p => p.color === player.color);
      return playerPieces.length > 0 && playerPieces.every(p => p.stepCount === 58);
    });
  }
}

// Lấy thông tin người chiến thắng
export function getWinnerInfo(gameState) {
  const { pieces, mode, players } = gameState;

  if (mode === '2vs2') {
    // Đội Red-Yellow
    const redPieces = pieces.filter(p => p.color === 'red');
    const yellowPieces = pieces.filter(p => p.color === 'yellow');
    const teamRedYellowFinished = 
      (redPieces.length === 0 || redPieces.every(p => p.stepCount === 58)) &&
      (yellowPieces.length === 0 || yellowPieces.every(p => p.stepCount === 58));

    if (teamRedYellowFinished) {
      return {
        type: 'team',
        name: 'Đội Đỏ - Vàng',
        colors: ['red', 'yellow']
      };
    } else {
      return {
        type: 'team',
        name: 'Đội Xanh lá - Xanh dương',
        colors: ['green', 'blue']
      };
    }
  } else {
    const winnerPlayer = players.find(player => {
      const playerPieces = pieces.filter(p => p.color === player.color);
      return playerPieces.length > 0 && playerPieces.every(p => p.stepCount === 58);
    });
    return {
      type: 'single',
      name: winnerPlayer ? winnerPlayer.name : 'Unknown',
      color: winnerPlayer ? winnerPlayer.color : null
    };
  }
}

// Chuyển lượt chơi sang người tiếp theo
export function switchToNextTurn(gameState) {
  if (gameState.status !== 'playing') return gameState;

  const newState = JSON.parse(JSON.stringify(gameState));
  const { players, consecutiveSixes, bonusRoll, diceValue } = newState;

  let skipToNext = true;

  // Nếu người chơi đổ được 6
  if (diceValue === 6) {
    if (consecutiveSixes >= 2) {
      // Đổ 6 ba lần liên tiếp -> Bị phạt mất lượt chơi và chuyển sang người tiếp theo
      newState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `${players[newState.turnIndex]?.name} đã đổ 6 ba lần liên tiếp và bị mất lượt!`
      });
      newState.consecutiveSixes = 0;
      skipToNext = true;
    } else {
      // Được đổ tiếp (bonus)
      newState.consecutiveSixes += 1;
      skipToNext = false;
      newState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `${players[newState.turnIndex]?.name} được thêm lượt đổ do đổ được 6!`
      });
    }
  } else {
    // Đổ xúc xắc bình thường, reset số lần đổ 6 liên tục
    newState.consecutiveSixes = 0;
    
    // Nếu có lượt bonus khác (đá quân hoặc về đích), không chuyển lượt
    if (bonusRoll) {
      skipToNext = false;
      newState.history.unshift({
        time: new Date().toLocaleTimeString(),
        message: `${players[newState.turnIndex]?.name} được thêm lượt do đá quân hoặc về đích!`
      });
    }
  }

  if (skipToNext) {
    // Chuyển sang người tiếp theo trong danh sách players
    newState.turnIndex = (newState.turnIndex + 1) % players.length;
    newState.currentTurnColor = players[newState.turnIndex].color;
  }

  // Reset trạng thái lượt mới
  newState.diceValue = null;
  newState.hasRolled = false;
  newState.hasMoved = false;
  newState.bonusRoll = false;
  newState.lastActionTime = Date.now();
  newState.timerEndAt = Date.now() + 30000; // Hạn chót đổ xúc xắc (30s)

  return newState;
}

// Bot AI đơn giản tự động đưa ra quyết định nước đi tốt nhất
export function makeBotDecision(color, diceValue, pieces, mode) {
  const validPieces = getValidPiecesToMove(color, diceValue, pieces);
  if (validPieces.length === 0) return null;

  // Điểm số ưu tiên của nước đi:
  // 1. Đá quân đối thủ (Ưu tiên cao nhất)
  // 2. Về đích (Piece đạt stepCount 58)
  // 3. Ra quân từ sân nhà (Piece từ -1 ra 0/13/26/39)
  // 4. Tiến vào đường chuồng (Piece di chuyển từ Common track vào Home stretch)
  // 5. Di chuyển quân đang ở gần đích nhất (an toàn nhất, đưa quân nhanh nhất về đích)
  // 6. Di chuyển quân đang có nguy cơ bị đá cao nhất

  let bestPiece = null;
  let maxScore = -1000;

  validPieces.forEach(piece => {
    let score = 0;

    // A. Nếu là nước đi ra quân
    if (piece.position === -1 && diceValue === 6) {
      score += 300; // Mức độ ưu tiên cao
    }

    // B. Tính vị trí mới để đánh giá
    const nextStepCount = piece.stepCount + diceValue;
    const nextPos = getBoardPosition(color, nextStepCount);

    // C. Ưu tiên về đích
    if (nextStepCount === 58) {
      score += 400; // Cực kỳ ưu tiên đưa quân về đích
    }

    // D. Ưu tiên đá quân đối thủ
    if (nextStepCount <= 51) {
      const isDestinationSafe = SAFE_ZONES.includes(nextPos);
      if (!isDestinationSafe) {
        // Tìm xem có quân của đối thủ ở ô đích hay không
        const enemyAtDest = pieces.some(p => 
          p.color !== color && 
          !isTeammateColor(color, p.color, mode) && 
          p.position === nextPos
        );
        if (enemyAtDest) {
          score += 500; // Ưu tiên cao nhất: Đá quân địch!
        }
      }
    }

    // E. Ưu tiên tiến vào Home stretch (an toàn)
    if (piece.stepCount <= 51 && nextStepCount > 51) {
      score += 150;
    }

    // F. Tránh việc rời khỏi ô an toàn nếu không cần thiết
    const isCurrentSafe = SAFE_ZONES.includes(piece.position);
    if (isCurrentSafe && piece.position !== -1) {
      score -= 50; // Trừ điểm vì rời khỏi ô an toàn
    }

    // G. Ưu tiên di chuyển quân cờ đã tiến xa (nhưng chưa về đích)
    // Thêm điểm nhỏ dựa trên số bước đã đi để tạo xu hướng đẩy quân xa về đích trước
    score += piece.stepCount * 2;

    if (score > maxScore) {
      maxScore = score;
      bestPiece = piece;
    }
  });

  return bestPiece ? bestPiece.id : null;
}
