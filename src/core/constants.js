// Thời gian mặc định
export const ROLL_TIMEOUT_MS = 20000;
export const MOVE_TIMEOUT_MS = 30000;

// Hoạt cảnh (Animation durations in ms)
export const ANIMATION_SPEED_FORWARD_STEP = 240;
export const ANIMATION_SPEED_FORWARD_STOP = 200;
export const ANIMATION_SPEED_BACKWARD_STEP = 60;
export const ANIMATION_SPEED_BACKWARD_STOP = 100;

// Thời gian chờ của Bot (trước khi roll, chọn cờ, v.v.)
export const BOT_THINK_BEFORE_ROLL_MS = 600;
export const BOT_ROLL_ANIMATION_MS = 1000;
export const BOT_THINK_BEFORE_MOVE_MS = 600;
export const TURN_SWITCH_DELAY_MS = 500;

// Hàm tiện ích tính toán tổng thời gian delay cho việc di chuyển cờ
export function calculateMoveDelay(piece, diceVal, kickedPiece) {
  const steps = (piece && piece.position === -1) ? 1 : diceVal;
  const durationForward = steps * ANIMATION_SPEED_FORWARD_STEP + ANIMATION_SPEED_FORWARD_STOP;

  // Nếu có quân bị đá, nó sẽ chạy lùi nhanh sau khi quân này đi đến đích
  const durationBackward = kickedPiece 
    ? (durationForward + kickedPiece.stepCount * ANIMATION_SPEED_BACKWARD_STEP + ANIMATION_SPEED_BACKWARD_STOP) 
    : 0;

  // Thêm 400ms đệm an toàn để chắc chắn hoạt ảnh Phaser đã hoàn tất và quân cờ đã đứng yên hoàn toàn
  return Math.max(durationForward, durationBackward) + 400;
}

// Hàm giả lập sleep bằng Promise
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
