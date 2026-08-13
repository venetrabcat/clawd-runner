/* CLAWD RUN — step B3: duck, flying obstacle, difficulty ramp (speed rises
   with run time to a cap, obstacle gaps shrink with speed).
   Namespace window.CLAWD, single script.js, classic script with defer. */

window.CLAWD = (function () {
  'use strict';

  /* ===================== DOM ===================== */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const startScreen = document.getElementById('start-screen');
  const overlayLabel = document.getElementById('overlay-label');
  const overlayResults = document.getElementById('overlay-results');
  const overlayHint = document.getElementById('overlay-hint');

  /* ===================== Canvas (logical px) ===================== */

  const W = canvas.width; // 900
  const H = canvas.height; // 300

  /* ===================== Config ===================== */

  // Difficulty ramp: speed starts at RUN_SPEED and every SPEED_INCREASE_MS of
  // *run time* adds SPEED_RAMP, capped at MAX_SPEED. Tied to time (not distance)
  // so the difficulty keeps climbing even once max speed is reached.
  const RUN_SPEED = 260; // starting world px per second
  const SPEED_INCREASE_MS = 500; // time interval per ramp step, ms
  const SPEED_RAMP = 6; // px/s added per step
  const MAX_SPEED = 500; // difficulty ceiling, px/s
  const START_MIN_GAP = 300; // gap range at start speed, px
  const START_MAX_GAP = 560;
  const END_MIN_GAP = 220; // gap range at max speed, px
  const END_MAX_GAP = 420;

  const GROUND_Y = H - 28; // top edge of the ground line
  const GROUND_PITCH = 18; // spacing between ground dashes
  const MAX_DT = 1 / 20; // clamp dt (seconds) to avoid spiral of death after lag
  const MASCOT_X = 120; // fixed screen X of the runner (left edge of sprite)

  const BODY = '#cd7b5a'; // CLAWD body color (from clawd.svg)
  const DARK = '#1a1a1a'; // CLAWD eye color (from clawd.svg)

  // Pixel map of CLAWD, derived from ~/Downloads/clawd.svg (17x11).
  // '#' = body, 'K' = eye, '.' = transparent. Rows 0-7 are the body/head;
  // the four legs are separate (see SPRITE.legX) so run frames can pose them.
  const SPRITE = {
    scale: 4, // px per cell -> sprite is 68x44 on screen
    w: 17,
    h: 11,
    bodyRows: [
      '....#########.....', //  0: top of head
      '....#########.....', //  1
      '....##KK##KK#.....', //  2: eyes + bridge
      '....##KK##KK#.....', //  3
      '....#########.....', //  4: face
      '..###############.', //  5: wide body
      '..##############..', //  6
      '....#########.....', //  7
    ],
    legX: [4, 6, 10, 12], // column of each leg
    legTopRow: 8, // first leg row (legs draw down from here to the ground)
  };

  // Two run frames: contact (all four legs down, body low) and stride
  // (diagonal legs lifted, body 2px higher). Legs anchor to the ground, the
  // body bob is relative. Own art, no borrowed sprites.
  const RUN_FRAMES = [
    { bob: 0, legHeights: [3, 3, 3, 3] }, // contact
    { bob: -2, legHeights: [2, 3, 3, 2] }, // stride: front-right & back-left planted
  ];

  // Run cycle cadence: one frame swap per this many world px travelled.
  const RUN_CYCLE_PX = 30;

  // Game-over pose: body squashed down, legs tucked. Read as "flattened".
  const DEAD_FRAME = { bob: 2, legHeights: [1, 1, 1, 1] };

  // Duck/crouch pose: single flattened frame, own art — head tucked low, hunched
  // back, stubby feet. Half the standing height (20px vs 44px), same width.
  const DUCK_ROWS = [
    '....##KK##KK#....', //  0: head, eyes tucked low
    '..##############.', //  1: hunched back
    '..#############..', //  2: body
    '...##########....', //  3: taper
    '...####...####...', //  4: stubby feet
  ];
  const DUCK_H = DUCK_ROWS.length * SPRITE.scale;

  // Jump physics. player.y = height above the ground (up is positive).
  // Apex height = JUMP_VELOCITY^2 / (2 * GRAVITY).
  const GRAVITY = 900; // downward acceleration, px/s^2
  const JUMP_VELOCITY = 330; // initial upward velocity, px/s (~60px apex)
  const JUMP_CUT = 0.5; // velocity multiplier when the key is released early

  // Hitboxes are inset by this many px from the visual sprite on all sides so
  // near-misses read as misses (fairer than pixel-perfect, like the reference).
  const HITBOX_PAD = 5;

  // Scoring. World distance (px) is accumulated; score = distance / this.
  const SCORE_PER_PX = 10; // score unit per world px
  const BEST_KEY = 'clawdRunBest'; // localStorage key for the best score
  const HUD_X = W - 16; // right edge of the HUD text
  const HUD_Y = 28; // top of the HUD text

  // Own pixel-art obstacle. On the dark sky a light rock reads clearly.
  // '#' = rock body, 'D' = crack detail, '.' = transparent. Bottom row sits
  // on the ground; width = rows[0].length * scale, height = rows.length * scale.
  const OBSTACLE_ROCK = {
    scale: 4,
    rows: [
      '...##...',
      '..####..',
      '.######.',
      '.#####D.',
      '##D#####',
    ],
    colors: { '#': '#c7b9ac', 'D': '#6b5b4f' },
  };

  // Own flying obstacle: a light glider with an eye, distinct from the rock.
  // '#' = body, 'K' = eye, '.' = transparent.
  const OBSTACLE_BIRD = {
    scale: 4,
    rows: [
      '........##......', //  0: head
      '.......####.....', //  1
      '.##...##K##....#', //  2: wings out + eye
      '.###############', //  3: full wing spread
      '.##...#####...##', //  4
      '........##......', //  5
    ],
    colors: { '#': '#c7b9ac', K: '#1a1a1a' },
  };

  // Flying height: the bird's bottom sits this many px above the ground line.
  // The band is at body level of the standing CLAWD (44px tall): a standing run
  // collides (bird's lower hitbox overlaps the mascot's), ducking (20px) clears
  // it with room to spare. The bird is 24px tall at scale 4 — clearly visible.
  const BIRD_BOTTOM_MIN = 24;
  const BIRD_BOTTOM_MAX = 32;
  const ROCK_CHANCE = 0.6; // spawn probability of a ground rock vs a bird

  // Spawn spacing is measured in world px travelled (which is also the on-screen
  // gap, since obstacles move at world speed). First obstacle gets a grace
  // distance so the run starts calm.
  const FIRST_GAP = 420; // px before the first obstacle

  // A bird is guaranteed to appear within the first MAX_ROCKS_BEFORE_BIRD
  // obstacles of a run, so duck gets a purpose early. After one bird, types
  // are random again.
  const MAX_ROCKS_BEFORE_BIRD = 3;

  // Power-up: one glowing energy crystal. Picking it up grants BOTH a speed
  // boost (world speed multiplier while active) and brief invincibility
  // (obstacles pass through the mascot). Single pickup, own pixel art.
  const POWERUP_CHANCE = 0.08; // spawn chance per obstacle gap
  const POWERUP_AHEAD = 170; // px ahead of the obstacle it spawns with
  const BOOST_TIME = 5; // speed-boost duration, seconds
  const BOOST_MULT = 1.45; // world speed multiplier while boosting
  const INVINCIBLE_TIME = 4; // invincibility duration, seconds

  // Own pixel-art crystal. '#' = glowing body, 'W' = white glint, '.' = empty.
  // Bottom row sits on the ground; width = rows[0].length * scale.
  const POWERUP_CRYSTAL = {
    scale: 4,
    rows: [
      '....###....',
      '...#####...',
      '..#######..',
      '.#########.',
      '.W##...##W.',
      '...#####...',
      '....###....',
    ],
    colors: { '#': '#ffd54a', W: '#fff7d6' },
  };

  /* ===================== State ===================== */

  const IDLE = 'idle';
  const RUNNING = 'running';
  const GAME_OVER = 'game_over';

  let state = IDLE;
  let elapsed = 0; // total simulated time, seconds
  let lastTime = 0; // timestamp of the previous frame

  const world = {
    speed: 0, // world px per second
    distance: 0, // px travelled (score will derive from this later)
  };

  let groundOffset = 0; // scroll offset along the ground dash pattern

  let obstacles = []; // active obstacles: { type, x, y, w, h }
  let distanceSinceSpawn = 0; // world px since the last spawn
  let nextGap = FIRST_GAP; // px until the next spawn

  let score = 0; // current run score
  let best = 0; // best score, loaded from localStorage
  let rocksSinceBird = 0; // ground rocks spawned since the last bird
  let runTime = 0; // time since the run started, ms

  let powerups = []; // active pickups: { x, y, w, h }
  let boostRemaining = 0; // seconds of speed boost left (0 = inactive)
  let invincibleRemaining = 0; // seconds of invincibility left (0 = inactive)

  const player = {
    y: 0, // offset above the ground, px (0 = standing)
    vy: 0, // vertical velocity, px/s
    onGround: true,
    ducking: false, // crouched under low obstacles
  };

  /* ===================== Controls ===================== */

  // Reset a run to its starting condition.
  function resetWorld() {
    world.distance = 0;
    groundOffset = 0;
    obstacles.length = 0;
    distanceSinceSpawn = 0;
    nextGap = FIRST_GAP;
    player.y = 0;
    player.vy = 0;
    player.onGround = true;
    player.ducking = false;
    score = 0;
    rocksSinceBird = 0;
    runTime = 0;
    powerups.length = 0;
    boostRemaining = 0;
    invincibleRemaining = 0;
  }

  function start() {
    resetWorld();
    state = RUNNING;
    world.speed = RUN_SPEED;
    startScreen.classList.remove('record');
    overlayResults.hidden = true;
    startScreen.hidden = true;
  }

  // Game-over overlay: current score and best, with a highlight when the run
  // set a new record. This runs exactly once per death.
  function showGameOver(isRecord) {
    overlayLabel.textContent = 'Game Over';
    overlayResults.textContent = isRecord
      ? `New Best! ${score}`
      : `Score ${score} · Best ${best}`;
    overlayResults.hidden = false;
    overlayHint.textContent = 'Press Space or Tap to Restart';
    startScreen.classList.toggle('record', isRecord);
    startScreen.hidden = false;
  }

  function jump() {
    if (!player.onGround || player.ducking) return;
    player.vy = JUMP_VELOCITY; // up = positive height above ground
    player.onGround = false;
  }

  // Released early while still rising -> cut the jump short (shorter hop).
  function endJump() {
    if (!player.onGround && player.vy > 0) player.vy *= JUMP_CUT;
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    if (e.code === 'ArrowDown') {
      e.preventDefault(); // don't let the page scroll
      player.ducking = true;
      return;
    }
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
      e.preventDefault();
      if (state === IDLE || state === GAME_OVER) {
        start(); // also restarts a finished run without reloading
      } else if (state === RUNNING) {
        jump();
      }
    }
  }

  function onKeyUp(e) {
    if (e.code === 'ArrowDown') {
      player.ducking = false;
      return;
    }
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
      endJump();
    }
  }

  function onPointerDown() {
    if (state === IDLE || state === GAME_OVER) start();
  }

  /* ===================== Update ===================== */

  function updatePlayer(dt) {
    if (player.onGround) return;

    player.vy -= GRAVITY * dt; // gravity pulls down
    player.y += player.vy * dt;
    if (player.y <= 0) {
      player.y = 0;
      player.vy = 0;
      player.onGround = true;
    }
  }

  // Spawn one obstacle: ground rock (sits on the ground) or a bird at a
  // random flying height. Only one obstacle per gap, so rock+bird never force
  // a jump and a duck at the same instant.
  function spawnObstacle() {
    const forceBird = rocksSinceBird >= MAX_ROCKS_BEFORE_BIRD;
    const type =
      forceBird || Math.random() >= ROCK_CHANCE ? OBSTACLE_BIRD : OBSTACLE_ROCK;
    rocksSinceBird = type === OBSTACLE_BIRD ? 0 : rocksSinceBird + 1;
    const w = type.rows[0].length * type.scale;
    const h = type.rows.length * type.scale;

    let y;
    if (type === OBSTACLE_BIRD) {
      const bottom =
        BIRD_BOTTOM_MIN + Math.random() * (BIRD_BOTTOM_MAX - BIRD_BOTTOM_MIN);
      y = GROUND_Y - bottom - h; // bottom floats above the ground
    } else {
      y = GROUND_Y - h; // bottom sits on the ground
    }

    obstacles.push({
      type,
      x: W, // enter just off the right edge
      y,
      w,
      h,
    });

    // With some chance the same gap also carries a power-up. It spawns ahead
    // of the obstacle (closer to the player), so a lucky pickup can be spent
    // on plowing through that very obstacle.
    if (Math.random() < POWERUP_CHANCE) spawnPowerup();
  }

  // Spawn a crystal on the ground, POWERUP_AHEAD px before the obstacle it
  // was rolled with. Same world speed as everything else, so the lead holds.
  function spawnPowerup() {
    const w = POWERUP_CRYSTAL.rows[0].length * POWERUP_CRYSTAL.scale;
    const h = POWERUP_CRYSTAL.rows.length * POWERUP_CRYSTAL.scale;
    powerups.push({
      x: W - POWERUP_AHEAD,
      y: GROUND_Y - h, // bottom sits on the ground
      w,
      h,
    });
  }

  function updateObstacles(dt) {
    const move = world.speed * dt;

    distanceSinceSpawn += move;
    if (distanceSinceSpawn >= nextGap) {
      spawnObstacle();
      distanceSinceSpawn = 0;
      // Gaps lerp from (START_MIN, START_MAX) at start speed to (END_MIN,
      // END_MAX) at max speed. At higher speeds obstacles spend less time on
      // screen, so the run gets harder both from speed and from density.
      const frac = (world.speed - RUN_SPEED) / (MAX_SPEED - RUN_SPEED);
      const minGap = START_MIN_GAP * (1 - frac) + END_MIN_GAP * frac;
      const maxGap = START_MAX_GAP * (1 - frac) + END_MAX_GAP * frac;
      nextGap = minGap + Math.random() * (maxGap - minGap);
    }

    for (let i = obstacles.length - 1; i >= 0; i -= 1) {
      const o = obstacles[i];
      o.x -= move;
      if (o.x + o.w < -20) obstacles.splice(i, 1); // fully off screen
    }

    for (let i = powerups.length - 1; i >= 0; i -= 1) {
      const p = powerups[i];
      p.x -= move;
      if (p.x + p.w < -20) powerups.splice(i, 1); // fully off screen
    }
  }

  // Axis-aligned bounding boxes, each inset by HITBOX_PAD from its visual
  // sprite so grazing hits don't count.
  function playerHitbox() {
    const w = SPRITE.w * SPRITE.scale;
    const h = player.ducking ? DUCK_H : SPRITE.h * SPRITE.scale;
    return {
      x: MASCOT_X + HITBOX_PAD,
      y: GROUND_Y - h - player.y + HITBOX_PAD,
      w: w - 2 * HITBOX_PAD,
      h: h - 2 * HITBOX_PAD,
    };
  }

  function obstacleHitbox(o) {
    return {
      x: o.x + HITBOX_PAD,
      y: o.y + HITBOX_PAD,
      w: o.w - 2 * HITBOX_PAD,
      h: o.h - 2 * HITBOX_PAD,
    };
  }

  function hitboxesOverlap(a, b) {
    return (
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    );
  }

  // A crash ends the run: record the score, then show the result overlay.
  function gameOver() {
    state = GAME_OVER;
    showGameOver(recordBest());
  }

  function checkCollisions() {
    if (invincibleRemaining > 0) return; // invincible — obstacles pass through

    const pb = playerHitbox();
    for (const o of obstacles) {
      if (hitboxesOverlap(pb, obstacleHitbox(o))) {
        gameOver();
        return;
      }
    }
  }

  // Pick up a crystal: grant the full boost + invincibility (refreshes any
  // active effect rather than stacking). Removes the crystal from the road.
  function checkPowerupPickup() {
    const pb = playerHitbox();
    for (let i = powerups.length - 1; i >= 0; i -= 1) {
      if (hitboxesOverlap(pb, powerups[i])) {
        powerups.splice(i, 1);
        boostRemaining = BOOST_TIME;
        invincibleRemaining = INVINCIBLE_TIME;
      }
    }
  }

  // Persist this run's score if it beat the stored best; returns true when it did.
  function recordBest() {
    if (score <= best) return false;
    best = score;
    try {
      localStorage.setItem(BEST_KEY, String(best));
    } catch (err) {
      /* storage unavailable — keep the in-memory best for this session */
    }
    return true;
  }

  function update(dt) {
    elapsed += dt;
    if (state !== RUNNING) return;

    // Difficulty ramp: speed grows in steps with run time, up to a ceiling.
    runTime += dt * 1000;
    const baseSpeed = Math.min(
      MAX_SPEED,
      RUN_SPEED + SPEED_RAMP * Math.floor(runTime / SPEED_INCREASE_MS)
    );
    // Power-up boost: multiply speed (and thus score) while it lasts.
    world.speed = boostRemaining > 0 ? baseSpeed * BOOST_MULT : baseSpeed;

    // Power-up timers tick down.
    if (boostRemaining > 0) boostRemaining -= dt;
    if (invincibleRemaining > 0) invincibleRemaining -= dt;

    world.distance += world.speed * dt;
    groundOffset = (groundOffset + world.speed * dt) % GROUND_PITCH;
    score = Math.floor(world.distance / SCORE_PER_PX);
    updatePlayer(dt);
    updateObstacles(dt);
    checkPowerupPickup();
    checkCollisions();
  }

  /* ===================== Render ===================== */

  function currentFrame() {
    if (state === GAME_OVER) return DEAD_FRAME; // flattened after a crash
    if (state !== RUNNING) return RUN_FRAMES[0]; // standing pose while idle
    return RUN_FRAMES[Math.floor(world.distance / RUN_CYCLE_PX) % 2];
  }

  // Draw any pixel map: rows of chars, 'color' => color, '.' => transparent.
  function drawPixels(rows, colors, x, y, scale) {
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c += 1) {
        const ch = row[c];
        if (ch === '.') continue;
        ctx.fillStyle = colors[ch];
        ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
      }
    });
  }

  // Draw one CLAWD frame. Body rows are drawn at (x, y + bob); legs anchor to
  // the ground so the sprite stays in contact in every pose.
  function drawSprite(x, y, frame) {
    const s = SPRITE;
    const bodyY = y + frame.bob;

    // Body + head
    drawPixels(s.bodyRows, { '#': BODY, K: DARK }, x, bodyY, s.scale);

    // Legs
    s.legX.forEach((lx, i) => {
      const h = frame.legHeights[i];
      for (let k = 0; k < h; k += 1) {
        ctx.fillStyle = BODY;
        ctx.fillRect(
          x + lx * s.scale,
          y + s.legTopRow * s.scale + k * s.scale,
          s.scale,
          s.scale
        );
      }
    });
  }

  // Draw the runner: duck pose while crouching (running only), otherwise the
  // current run/dead frame. Bottom-anchored, so player.y lifts it in jumps.
  function drawMascot() {
    const groundY = GROUND_Y - player.y;
    // Invincibility blink: flicker alpha so the phase-through reads clearly.
    const blink = invincibleRemaining > 0 && state === RUNNING;
    if (blink) ctx.globalAlpha = Math.floor(elapsed * 12) % 2 === 0 ? 1 : 0.35;
    if (player.ducking && state === RUNNING) {
      drawPixels(DUCK_ROWS, { '#': BODY, K: DARK }, MASCOT_X, groundY - DUCK_H, SPRITE.scale);
    } else {
      drawSprite(MASCOT_X, groundY - SPRITE.h * SPRITE.scale, currentFrame());
    }
    ctx.globalAlpha = 1;
  }

  function drawHud() {
    ctx.textAlign = 'right';
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.fillStyle = '#cd7b5a';
    ctx.fillText(`HI ${best}`, HUD_X, HUD_Y);
    ctx.fillStyle = '#efe6dd';
    ctx.fillText(`${score}`, HUD_X - 100, HUD_Y);
  }

  // Power-up indicator: a small crystal and the seconds left, shown top-left
  // while either effect is active. Counts down from whichever lasts longer.
  function drawPowerupHud() {
    const remaining = Math.max(boostRemaining, invincibleRemaining);
    if (remaining <= 0 || state !== RUNNING) return;

    const sec = Math.ceil(remaining);
    const s = POWERUP_CRYSTAL.scale * 0.5; // mini crystal, half scale
    const x = 16;
    const y = 18;
    drawPixels(POWERUP_CRYSTAL.rows, POWERUP_CRYSTAL.colors, x, y, s);

    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd54a';
    ctx.fillText(`${sec}s`, x + POWERUP_CRYSTAL.rows[0].length * s + 6, y + 12);
  }

  // Score plaque above the mascot at game over, mirroring the reference's
  // death bubble. Rises with the corpse if the run ended mid-jump.
  function drawDeathScore() {
    const spriteH = player.ducking ? DUCK_H : SPRITE.h * SPRITE.scale;
    const text = `${score}`;
    const cx = MASCOT_X + (SPRITE.w * SPRITE.scale) / 2;
    const w = 58;
    const h = 28;
    const x = cx - w / 2;
    const y = GROUND_Y - spriteH - player.y - h - 12;

    ctx.fillStyle = '#1d1713';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#6b5b4f';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#efe6dd';
    ctx.fillText(text, cx, y + h / 2 + 6);
  }

  function render() {
    // Sky
    ctx.fillStyle = '#14100e';
    ctx.fillRect(0, 0, W, H);

    // Ground baseline
    ctx.fillStyle = '#6b5b4f';
    ctx.fillRect(0, GROUND_Y, W, 2);

    // Scrolling ground dashes
    ctx.fillStyle = '#cd7b5a';
    for (let i = 0; i * GROUND_PITCH < W + GROUND_PITCH; i += 1) {
      const px = i * GROUND_PITCH - groundOffset;
      ctx.fillRect(px, GROUND_Y - 9, 3, 9);
    }

    // Obstacles
    obstacles.forEach((o) =>
      drawPixels(o.type.rows, o.type.colors, o.x, o.y, o.type.scale)
    );

    // Power-ups: pulsing glow so the pickup reads as alive.
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(elapsed * 8);
    powerups.forEach((p) =>
      drawPixels(
        POWERUP_CRYSTAL.rows,
        POWERUP_CRYSTAL.colors,
        p.x,
        p.y,
        POWERUP_CRYSTAL.scale
      )
    );
    ctx.globalAlpha = 1;

    // Mascot
    drawMascot();

    // Scoreboard + power-up indicator + death score plaque
    drawHud();
    drawPowerupHud();
    if (state === GAME_OVER) drawDeathScore();
  }

  /* ===================== Loop ===================== */

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, MAX_DT);
    lastTime = now;

    update(dt);
    render();

    requestAnimationFrame(frame);
  }

  /* ===================== Init ===================== */

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('pointerdown', onPointerDown);

  try {
    best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
  } catch (err) {
    best = 0; // storage unavailable (private mode, file:// quirks) — play on
  }

  lastTime = performance.now();
  requestAnimationFrame(frame);
})();
