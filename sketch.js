let video;
let handPose;
let hands = [];

let music;      // 魔法阵音效
let bgMusic;    // 背景音乐
let wind;       // 手指滑动风声
let brokeSound; // 握拳破碎音

// ===== 魔法阵状态（唯一主体）=====
let magicSize = 0;
let targetMagicSize = 0;
let magicAlpha = 0;
let targetMagicAlpha = 0;
let rotationAngle = 0;
let rotationVelocity = 0;

// 当前魔法阵中心（用于 translate trick）
let magicCenterX = 0;
let magicCenterY = 0;

// 粒子
let fingertipParticles = [];

// 风声
let lastFingerPos = null;
let windFade = 0;

// 握拳破碎状态（以 hand index 为键）
let brokenStates = {};      // brokenStates[i] = {isBroken:true, endTime:ms}
const BROKE_DURATION_MS = 3000; // 破碎持续时间（ms）
let fistStart = {};         // fistStart[i] = timestamp when fist first detected
const FIST_HOLD_MS = 50;   // 连续握拳需要保持的时间判定为“握拳”

// 破碎碎片数组
let shards = []; // {x,y,vx,vy,ax,ay,life,col}

function preload() {
  handPose = ml5.handPose({ flipped: true });
  music = loadSound("sound.MP3");
  bgMusic = loadSound("music.MP3");
  wind = loadSound("wind.MP3");
  brokeSound = loadSound("broke.MP3");
}

function setup() {
  createCanvas(1920, 1080);
  angleMode(RADIANS);
  userStartAudio();

  bgMusic.setLoop(true);
  bgMusic.setVolume(0.35);
  bgMusic.play();

  video = createCapture(VIDEO, { flipped: true });
  video.size(640, 480);
  video.hide();

  handPose.detectStart(video, gotHands);
}

function gotHands(results) {
  hands = results;
}

function draw() {
  drawBackground();

  let anyActive = false;
  let strongestAlpha = 0;
  let strongestVelocity = 0;

  // 更新并绘制每只手对应的魔法阵（使用全局 drawMagicCircle）
  for (let i = 0; i < hands.length; i++) {
    let hand = hands[i];

    let xs = hand.keypoints.map(p => p.x);
    let ys = hand.keypoints.map(p => p.y);

    // 计算手心（平均点）
    magicCenterX = map(xs.reduce((a, b) => a + b) / xs.length, 0, video.width, 0, width);
    magicCenterY = map(ys.reduce((a, b) => a + b) / ys.length, 0, video.height, 0, height);

    let handSize = (max(xs) - min(xs) + max(ys) - min(ys)) / 2;

    let openAmount =
      dist(hand.thumb_tip.x, hand.thumb_tip.y, hand.index_finger_tip.x, hand.index_finger_tip.y) +
      dist(hand.index_finger_tip.x, hand.index_finger_tip.y, hand.pinky_finger_tip.x, hand.pinky_finger_tip.y);

    let fingerScale = openAmount / handSize;

    // 更新全局 magicSize/magicAlpha（保留你的主逻辑）
    targetMagicSize = map(fingerScale, 0.6, 1.4, 220, 520, true);
    targetMagicAlpha = map(fingerScale, 0.6, 1.4, 90, 210, true);

    magicSize = lerp(magicSize, targetMagicSize, 0.08);
    magicAlpha = lerp(magicAlpha, targetMagicAlpha, 0.08);

    rotationVelocity = lerp(
      rotationVelocity,
      map(handSize, 140, 340, 0.002, 0.05, true),
      0.1
    );
    rotationAngle += rotationVelocity;

    spawnFingertipParticles(hand, handSize);
    detectFingerWind(hand);

    // 握拳检测 & 触发破碎
    handleFistDetection(i, fingerScale, magicCenterX, magicCenterY);

    // 如果该手处于破碎状态，则绘制碎片；否则绘制魔法阵
    if (brokenStates[i] && brokenStates[i].isBroken) {
      // 绘制破碎粒子（在该手心位置）
      drawShardsAt(magicCenterX, magicCenterY);
    } else {
      // 在手心画魔法阵（不改变你主体函数 drawMagicCircle）
      push();
      // 把中心移动到手心：我们让 drawMagicCircle 依然在 canvas 中心绘制，通过平移让其看起来在手心
      translate(magicCenterX - width / 2, magicCenterY - height / 2);
      drawMagicCircle(rotationAngle); // ← **你要求保留的主体代码，完全未改**
      pop();
    }

    anyActive = true;
    if (magicAlpha > strongestAlpha) {
      strongestAlpha = magicAlpha;
      strongestVelocity = rotationVelocity;
    }
  }

  // 当没有手时，也要可能绘制默认中心魔法阵（如果你希望中心始终有阵，可取消注释）
  // 示例保留：如果你想在无手时仍显示中心阵，取消下面注释并调整条件
  // if (hands.length === 0) {
  //   push();
  //   translate(0,0); // no-op
  //   drawMagicCircle(rotationAngle);
  //   pop();
  // }

  updateParticles();
  updateShards(); // 更新碎片物理

  // ===== 魔法阵主音效（取最强阵）=====
  if (anyActive && strongestAlpha > 5) {
    if (!music.isPlaying()) music.loop();
    music.rate(map(strongestVelocity, 0, 0.05, 0.7, 1.3, true));
    music.setVolume(map(strongestAlpha, 0, 210, 0, 0.8, true));
  } else {
    if (music.isPlaying()) music.stop();
  }

  // 风声衰减（若 detectFingerWind 已经设置 windFade，则此处将其慢慢拉回0）
  windFade = lerp(windFade, 0, 0.05);
  wind.setVolume(windFade);
}

/* ========== 握拳检测与碎裂效果 ========== */

function handleFistDetection(handIndex, fingerScale, centerX, centerY) {
  // 判定握拳：fingerScale 很小表示手指收拢（阈值可微调）
  const FIST_THRESHOLD = 0.75;

  let now = millis();

  // 初始化状态栏
  if (!fistStart[handIndex]) fistStart[handIndex] = null;
  if (!brokenStates[handIndex]) brokenStates[handIndex] = { isBroken: false, endTime: 0 };

// 若处于破碎状态：
// ① 时间到 或 ② 手重新张开 → 立即恢复
if (brokenStates[handIndex].isBroken) {
  if (
    now > brokenStates[handIndex].endTime ||
    fingerScale > FIST_THRESHOLD + 0.15   // ← 张开手的安全阈值
  ) {
    brokenStates[handIndex].isBroken = false;

    // 给魔法阵一个“重新生长”的起点
    magicAlpha = 0;
    magicSize = 0;
  }
}


  // 仅在尚未破碎时检测握拳触发
  if (!brokenStates[handIndex].isBroken) {
    if (fingerScale < FIST_THRESHOLD) {
      // 如果刚开始握拳，记录时间
      if (!fistStart[handIndex]) {
        fistStart[handIndex] = now;
      } else if (now - fistStart[handIndex] >= FIST_HOLD_MS) {
        // 持续握拳满足阈值 → 触发破碎
        triggerBreak(handIndex, centerX, centerY);
        fistStart[handIndex] = null;
      }
    } else {
      // 手打开，重置计时
      fistStart[handIndex] = null;
    }
  }
}

function triggerBreak(handIndex, cx, cy) {
  brokenStates[handIndex] = {
    isBroken: true,
    endTime: millis() + BROKE_DURATION_MS
  };

  // 🔥 关键：立即抹掉魔法阵视觉状态
  magicAlpha = 0;
  magicSize = 0;

  if (brokeSound && !brokeSound.isPlaying()) {
    brokeSound.play();
  }

  spawnShards(cx, cy, 36);
}


/* ========== 碎片粒子实现 ========== */

function spawnShards(x, y, count) {
  for (let i = 0; i < count; i++) {
    let angle = random(TWO_PI);
    let speed = random(3, 10);
    shards.push({
      x: x,
      y: y,
      vx: cos(angle) * speed,
      vy: sin(angle) * speed,
      ax: 0,
      ay: 0.15, // gravity-ish
      life: int(random(60, 140)),
      col: random([[255, 180, 220], [255, 210, 230], [240, 220, 255]])
    });
  }
}

function updateShards() {
  for (let i = shards.length - 1; i >= 0; i--) {
    let s = shards[i];
    s.vx += s.ax;
    s.vy += s.ay;
    s.x += s.vx;
    s.y += s.vy;
    s.life--;
    // 绘制 shard
    push();
    noStroke();
    fill(s.col[0], s.col[1], s.col[2], map(s.life, 0, 140, 0, 220));
    ellipse(s.x, s.y, map(s.life, 0, 140, 0.5, 6));
    pop();
    if (s.life <= 0) shards.splice(i, 1);
  }
}

function drawShardsAt(cx, cy) {
  // 已在 updateShards 中绘制碎片；这里可以做额外效果（比如光晕）
  // 我们在中心绘制一圈短暂光晕（与破碎同步）
  push();
  translate(cx, cy);
  noFill();
  stroke(255, 220, 240, 160);
  ellipse(0, 0, 40);
  pop();
}

/* ================= 手指风声检测（保持原有逻辑） ================= */

function detectFingerWind(hand) {
  let tip = hand.index_finger_tip;
  let x = map(tip.x, 0, video.width, 0, width);
  let y = map(tip.y, 0, video.height, 0, height);

  if (lastFingerPos) {
    let speed = dist(x, y, lastFingerPos.x, lastFingerPos.y);
    if (speed > 8) {
      if (!wind.isPlaying()) wind.loop();
      windFade = constrain(map(speed, 8, 50, 0.1, 0.6), 0, 0.6);
      wind.rate(map(speed, 8, 50, 0.9, 1.25, true));
    }
  }
  lastFingerPos = { x, y };
}

/* ================= 背景（保持不变） ================= */

function drawBackground() {
  let c1 = color(18, 10, 32);
  let c2 = color(90, 45, 110);

  for (let y = 0; y < height; y++) {
    let inter = map(y, 0, height, 0, 1);
    stroke(lerpColor(c1, c2, inter));
    line(0, y, width, y);
  }

  noStroke();
  for (let i = 0; i < 90; i++) {
    fill(255, 255, 255, random(5, 18));
    ellipse(random(width), random(height), random(1, 2));
  }
}

/* ================= 魔法阵 ================= */
/* 你要求“魔法阵主体永远是下面这个函数”，我**完全未改动**它 */
function drawMagicCircle(rot) {
  if (magicSize < 10) return;

  push();
  translate(width / 2, height / 2);
  rotate(rot);

  noFill();
  strokeWeight(2);

  // 外层复杂星轨（淡紫）
  stroke(190, 160, 255, magicAlpha * 0.35);
  for (let i = 0; i < 6; i++) {
    let offset = TWO_PI / 6 * i;
    arc(0, 0, magicSize * 1.3, magicSize * 1.3, offset, offset + PI / 3);
  }

  stroke(220, 200, 255, magicAlpha * 0.3);
  ellipse(0, 0, magicSize * 1.45);

  // 主星阵（粉白）
  stroke(255, 190, 230, magicAlpha);
  polygon(0, 0, magicSize * 0.7, 12);

  for (let i = 0; i < 12; i++) {
    let a1 = TWO_PI / 12 * i;
    let a2 = TWO_PI / 12 * ((i + 4) % 12);
    line(
      cos(a1) * magicSize * 0.7,
      sin(a1) * magicSize * 0.7,
      cos(a2) * magicSize * 0.7,
      sin(a2) * magicSize * 0.7
    );
  }

  // 月纹（偏蓝白）
  stroke(220, 235, 255, magicAlpha * 0.9);
  arc(0, 0, magicSize, magicSize, PI * 0.2, PI * 0.8);
  arc(0, 0, magicSize, magicSize, PI * 1.2, PI * 1.8);

  // 符文刻线（淡金粉）
  stroke(255, 220, 200, magicAlpha * 0.75);
  for (let i = 0; i < 24; i++) {
    let a = TWO_PI / 24 * i;
    line(
      cos(a) * magicSize * 0.3,
      sin(a) * magicSize * 0.3,
      cos(a) * magicSize * 0.45,
      sin(a) * magicSize * 0.45
    );
  }

  // 核心
  noStroke();
  fill(255, 235, 250, magicAlpha);
  ellipse(0, 0, magicSize * 0.12);

  pop();
}

function polygon(x, y, radius, npoints) {
  beginShape();
  for (let i = 0; i < npoints; i++) {
    let angle = TWO_PI / npoints * i;
    vertex(x + cos(angle) * radius, y + sin(angle) * radius);
  }
  endShape(CLOSE);
}

/* ================= 粒子 ================= */

function spawnFingertipParticles(hand, handSize) {
  let tips = [
    hand.thumb_tip,
    hand.index_finger_tip,
    hand.middle_finger_tip,
    hand.ring_finger_tip,
    hand.pinky_finger_tip
  ];

  for (let tip of tips) {
    fingertipParticles.push({
      x: map(tip.x, 0, video.width, 0, width),
      y: map(tip.y, 0, video.height, 0, height),
      r: map(handSize, 120, 320, 4, 12, true),
      life: 60,
      col: random([
        [255, 200, 230],
        [240, 220, 255],
        [255, 235, 250]
      ])
    });
  }
}

function updateParticles() {
  for (let i = fingertipParticles.length - 1; i >= 0; i--) {
    let p = fingertipParticles[i];
    p.life--;
    p.y -= 0.2;

    fill(p.col[0], p.col[1], p.col[2], map(p.life, 0, 60, 0, 120));
    noStroke();
    ellipse(p.x, p.y, p.r);

    if (p.life <= 0) fingertipParticles.splice(i, 1);
  }
}
