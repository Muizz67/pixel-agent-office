import { useEffect, useRef } from 'react';
import {
  AGENT_PROFILES,
  AGENT_PROFILE_MAP,
  type AgentId,
  type AgentStatus,
  type AgentView,
  type Run,
  type Task,
} from '../../shared/types';
import { drawAgentSprite, type SpriteId } from './sprites';

const WIDTH = 960;
const HEIGHT = 540;
const WALL_HEIGHT = 104;

interface DeskLayout {
  x: number;
  y: number;
  width: number;
}

const DESKS: Record<AgentId, DeskLayout> = {
  ceo: { x: 480, y: 196, width: 164 },
  researcher: { x: 158, y: 326, width: 128 },
  designer: { x: 802, y: 326, width: 128 },
  engineer: { x: 158, y: 498, width: 128 },
  reviewer: { x: 802, y: 498, width: 128 },
};

const GATHER_POINTS: Record<AgentId, { x: number; y: number }> = {
  ceo: { x: 480, y: 364 },
  researcher: { x: 399, y: 432 },
  designer: { x: 561, y: 432 },
  engineer: { x: 436, y: 462 },
  reviewer: { x: 524, y: 462 },
};

const LOITER_POINTS: Partial<Record<AgentId, { x: number; y: number }>> = {
  researcher: { x: 68, y: 250 },
  designer: { x: 892, y: 250 },
  engineer: { x: 892, y: 430 },
  reviewer: { x: 480, y: 350 },
};

const STATUS_COLORS: Record<AgentStatus, string> = {
  offline: '#4a5c75',
  idle: '#6f849d',
  thinking: '#5aa9ff',
  working: '#f6c453',
  waiting: '#ff9f43',
  blocked: '#ff9f43',
  error: '#ff6b6b',
  celebrating: '#67e8a5',
};

interface AnimAgent {
  id: AgentId;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  facing: 1 | -1;
  phase: number;
  walking: boolean;
  nextWander: number;
  wanderStage: number;
}

interface SceneProps {
  agents: AgentView[];
  run: Run | null;
  tasks: Task[];
  connected: boolean;
}

function statusColor(status: AgentStatus): string {
  return STATUS_COLORS[status] ?? STATUS_COLORS.idle;
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function drawWall(ctx: CanvasRenderingContext2D, time: number): void {
  px(ctx, 0, 0, WIDTH, WALL_HEIGHT, '#0c1524');
  px(ctx, 0, 0, WIDTH, 5, '#17243a');
  for (let x = 0; x < WIDTH; x += 120) {
    px(ctx, x, 0, 2, WALL_HEIGHT, '#0a111d');
    px(ctx, x + 2, 0, 1, WALL_HEIGHT, '#142036');
  }
  px(ctx, 0, WALL_HEIGHT - 7, WIDTH, 7, '#1a2a42');
  px(ctx, 0, WALL_HEIGHT - 2, WIDTH, 2, '#2b3e5a');

  // Windows with a night city.
  for (const windowX of [42, 714]) {
    px(ctx, windowX - 4, 16, 208, 68, '#1e304b');
    px(ctx, windowX, 20, 200, 60, '#07111f');
    ctx.save();
    ctx.beginPath();
    ctx.rect(windowX, 20, 200, 60);
    ctx.clip();
    for (let i = 0; i < 16; i += 1) {
      const starX = windowX + ((i * 53) % 192) + 4;
      const starY = 25 + ((i * 17) % 26);
      const fade = 0.25 + 0.35 * Math.abs(Math.sin(time * 0.7 + i));
      ctx.fillStyle = `rgba(197, 224, 255, ${fade})`;
      ctx.fillRect(starX, starY, 1, 1);
    }
    for (let i = 0; i < 14; i += 1) {
      const buildingX = windowX + i * 16 - 4;
      const buildingHeight = 18 + ((i * 31) % 36);
      px(ctx, buildingX, 80 - buildingHeight, 13, buildingHeight, i % 3 === 0 ? '#0b1d33' : '#0a1729');
      for (let row = 0; row < Math.floor(buildingHeight / 7); row += 1) {
        for (let column = 0; column < 2; column += 1) {
          if ((i + row + column) % 4 === 0) {
            px(ctx, buildingX + 3 + column * 5, 80 - buildingHeight + 4 + row * 7, 2, 2, '#e7b85b');
          }
        }
      }
    }
    px(ctx, windowX + 198, 20, 2, 60, '#1e304b');
    px(ctx, windowX + 98, 20, 2, 60, '#16263e');
    px(ctx, windowX, 49, 200, 2, '#16263e');
    ctx.restore();
    px(ctx, windowX - 9, 80, 212, 4, '#263b58');
  }

  // Neon studio sign.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '700 24px "Courier New", monospace';
  ctx.shadowColor = 'rgba(246, 196, 83, 0.55)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#f6c453';
  ctx.fillText('PIXEL OPS', 480, 49);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#7789a2';
  ctx.font = '9px "Courier New", monospace';
  ctx.fillText('AI AGENT STUDIO // FLOOR 01', 480, 65);
  ctx.restore();

  // Framed motto and a small clock.
  px(ctx, 306, 22, 126, 54, '#263a56');
  px(ctx, 309, 25, 120, 48, '#0b1525');
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#93a7c1';
  ctx.font = '9px "Courier New", monospace';
  ctx.fillText('SHIP', 369, 41);
  ctx.fillStyle = '#f6c453';
  ctx.fillText('LEARN', 369, 54);
  ctx.fillStyle = '#5aa9ff';
  ctx.fillText('REPEAT', 369, 67);
  ctx.restore();

  px(ctx, 604, 24, 46, 46, '#263a56');
  px(ctx, 607, 27, 40, 40, '#0b1525');
  ctx.save();
  ctx.translate(627, 47);
  ctx.strokeStyle = '#8fa4bf';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.stroke();
  const minute = time / 1000;
  ctx.strokeStyle = '#f6c453';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(minute * 0.2 - Math.PI / 2) * 9, Math.sin(minute * 0.2 - Math.PI / 2) * 9);
  ctx.stroke();
  ctx.strokeStyle = '#dce7f5';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(minute * 0.02 - Math.PI / 2) * 6, Math.sin(minute * 0.02 - Math.PI / 2) * 6);
  ctx.stroke();
  ctx.restore();
}

function drawFloor(ctx: CanvasRenderingContext2D, time: number): void {
  px(ctx, 0, WALL_HEIGHT, WIDTH, HEIGHT - WALL_HEIGHT, '#0a1524');
  const tile = 48;
  for (let y = WALL_HEIGHT; y < HEIGHT; y += tile) {
    for (let x = 0; x < WIDTH; x += tile) {
      const alternate = ((x / tile + y / tile) | 0) % 2 === 0;
      px(ctx, x, y, tile, tile, alternate ? '#0b1727' : '#0c192a');
      px(ctx, x, y, tile, 1, '#0e1c2e');
      px(ctx, x, y, 1, tile, '#0e1c2e');
    }
  }

  // Soft overhead light pools.
  const pools = [
    { x: 480, y: 210, radius: 210, alpha: 0.07 },
    { x: 158, y: 350, radius: 150, alpha: 0.045 },
    { x: 802, y: 350, radius: 150, alpha: 0.045 },
  ];
  for (const pool of pools) {
    const glow = ctx.createRadialGradient(pool.x, pool.y, 10, pool.x, pool.y, pool.radius);
    glow.addColorStop(0, `rgba(246, 196, 83, ${pool.alpha})`);
    glow.addColorStop(1, 'rgba(246, 196, 83, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(pool.x - pool.radius, pool.y - pool.radius, pool.radius * 2, pool.radius * 2);
  }

  // Mission rug.
  px(ctx, 356, 336, 248, 156, '#101e30');
  px(ctx, 360, 340, 240, 148, '#0d1929');
  px(ctx, 364, 344, 232, 140, '#122139');
  for (let i = 0; i < 6; i += 1) {
    px(ctx, 380 + i * 34, 350, 2, 126, '#162a45');
  }
  px(ctx, 370, 352, 220, 2, '#1d3552');
  px(ctx, 370, 474, 220, 2, '#1d3552');

  // Human touches: cable arcs and scuffs.
  ctx.strokeStyle = 'rgba(72, 96, 128, 0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(200, 352);
  ctx.bezierCurveTo(300, 332, 360, 356, 390, 388);
  ctx.stroke();
  px(ctx, 700, 440, 38, 3, '#15243a');
  px(ctx, 90, 214, 26, 2, '#15243a');
  void time;
}

function drawMeetingTable(ctx: CanvasRenderingContext2D, time: number): void {
  px(ctx, 385, 381, 190, 75, 'rgba(0,0,0,0.28)');
  px(ctx, 390, 373, 180, 70, '#493c38');
  px(ctx, 394, 377, 172, 24, '#6a574b');
  px(ctx, 394, 401, 172, 38, '#3d302d');
  px(ctx, 394, 401, 172, 3, '#846d5b');
  px(ctx, 386, 384, 8, 42, '#2b2322');
  px(ctx, 566, 384, 8, 42, '#2b2322');
  for (const chairX of [408, 456, 504, 548]) {
    px(ctx, chairX, 360, 26, 13, '#25364f');
    px(ctx, chairX + 4, 365, 18, 7, '#162439');
    px(ctx, chairX, 443, 26, 13, '#25364f');
    px(ctx, chairX + 4, 448, 18, 7, '#162439');
  }
  // Papers, mugs, and a tiny centerpiece.
  px(ctx, 418, 392, 31, 21, '#d8e2ef');
  for (let line = 0; line < 4; line += 1) {
    px(ctx, 422, 397 + line * 4, 21, 1, '#7f90a5');
  }
  px(ctx, 476, 388, 10, 8, '#e8eef6');
  px(ctx, 479, 385, 4, 3, '#d6deea');
  px(ctx, 477, 396, 8, 2, '#93a3b7');
  px(ctx, 519, 395, 28, 18, '#131e2d');
  px(ctx, 522, 398, 22, 10, '#0a121d');
  px(ctx, 524, 400, 5, 3, '#67e8a5');
  px(ctx, 532, 400, 8, 2, '#f6c453');
  px(ctx, 470, 410, 20, 20, '#20344b');
  px(ctx, 476, 404, 8, 12, '#2d7a5d');
  px(ctx, 473, 398, 4, 8, '#46a87c');
  const steam = Math.sin(time * 0.002) * 1.5;
  ctx.strokeStyle = 'rgba(205, 222, 240, 0.24)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(483, 384);
  ctx.quadraticCurveTo(486 + steam, 379, 483, 374);
  ctx.stroke();
}

function drawDesk(ctx: CanvasRenderingContext2D, id: AgentId, agent: AgentView | undefined, time: number): void {
  const desk = DESKS[id];
  const profile = AGENT_PROFILE_MAP[id];
  const x = desk.x - desk.width / 2;
  const color = agent ? statusColor(agent.status) : STATUS_COLORS.offline;
  const active = agent && ['working', 'thinking', 'waiting'].includes(agent.status);

  px(ctx, x + 6, desk.y + 46, desk.width - 4, 8, 'rgba(0,0,0,0.3)');
  px(ctx, x, desk.y, desk.width, 17, '#6b584a');
  px(ctx, x, desk.y, desk.width, 3, '#8b725e');
  px(ctx, x, desk.y + 14, desk.width, 3, '#4b3c33');
  px(ctx, x + 5, desk.y + 17, 8, 28, '#332922');
  px(ctx, x + desk.width - 13, desk.y + 17, 8, 28, '#332922');
  px(ctx, x + 5, desk.y + 17, desk.width - 10, 28, '#42342c');
  px(ctx, x + 5, desk.y + 17, desk.width - 10, 2, '#5a463a');
  px(ctx, x + 5, desk.y + 18, 4, 25, profile.accent);
  px(ctx, x + 13, desk.y + 24, desk.width - 32, 1, '#2c2320');

  // Monitor offset from the agent's silhouette.
  const monitorX = x + 9;
  const monitorY = desk.y - 25;
  px(ctx, monitorX, monitorY, 48, 31, '#0c1421');
  px(ctx, monitorX + 2, monitorY + 2, 44, 24, active ? '#122c3b' : '#0d1a28');
  if (active) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    px(ctx, monitorX + 2, monitorY + 2, 44, 24, `${color}30`);
    ctx.restore();
  }
  for (let line = 0; line < 5; line += 1) {
    const lineWidth = 10 + ((line * 13) % 26);
    px(ctx, monitorX + 5, monitorY + 6 + line * 4, lineWidth, 1, active ? color : '#28405a');
  }
  px(ctx, monitorX + 22, monitorY + 31, 4, 6, '#1c2a3c');
  px(ctx, monitorX + 15, monitorY + 36, 18, 2, '#26374d');
  px(ctx, monitorX + 56, desk.y + 1, 28, 10, '#141f2e');
  px(ctx, monitorX + 58, desk.y + 3, 24, 6, '#0b121c');
  for (let key = 0; key < 6; key += 1) {
    px(ctx, monitorX + 59 + (key % 3) * 8, desk.y + 3 + Math.floor(key / 3) * 3, 5, 1, '#2b3d55');
  }
  px(ctx, x + desk.width - 31, desk.y - 9, 10, 10, '#dce5ef');
  px(ctx, x + desk.width - 29, desk.y - 7, 6, 6, '#5a3d2e');
  px(ctx, x + desk.width - 26, desk.y - 12, 1, 4, 'rgba(210,225,240,0.3)');

  // Nameplate.
  const label = `${profile.name.split(' ')[0]?.toUpperCase()} // ${id.toUpperCase()}`;
  ctx.save();
  ctx.font = '9px "Courier New", monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111a27';
  ctx.fillRect(x + 18, desk.y + 31, Math.min(desk.width - 34, 95), 11);
  ctx.fillStyle = color;
  ctx.fillRect(x + 21, desk.y + 34, 3, 5);
  ctx.fillStyle = agent ? '#c4d3e4' : '#667992';
  ctx.fillText(label, x + 28, desk.y + 40);
  ctx.restore();

  // Small status light on the monitor.
  const blink = active ? 0.55 + 0.45 * Math.abs(Math.sin(time * 0.004 + desk.x)) : 0.28;
  ctx.globalAlpha = blink;
  px(ctx, monitorX + 46, monitorY + 27, 2, 2, color);
  ctx.globalAlpha = 1;
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1, time = 0): void {
  const sway = Math.sin(time * 0.0015 + x * 0.1) * 1.5;
  px(ctx, x - 9 * scale, y - 14 * scale, 18 * scale, 15 * scale, '#43332c');
  px(ctx, x - 10 * scale, y - 17 * scale, 20 * scale, 5 * scale, '#5c4538');
  px(ctx, x - 2 * scale, y - 35 * scale, 4 * scale, 22 * scale, '#256b50');
  px(ctx, x - 11 * scale + sway, y - 32 * scale, 10 * scale, 5 * scale, '#2f8f68');
  px(ctx, x - 7 * scale + sway, y - 39 * scale, 8 * scale, 5 * scale, '#3ca77a');
  px(ctx, x + 2 * scale - sway, y - 31 * scale, 10 * scale, 4 * scale, '#2b7d5d');
  px(ctx, x + 4 * scale - sway, y - 38 * scale, 7 * scale, 4 * scale, '#4bbd8c');
  px(ctx, x - 5 * scale, y - 27 * scale, 5 * scale, 3 * scale, '#1e5b44');
  px(ctx, x + 5 * scale, y - 25 * scale, 5 * scale, 3 * scale, '#1e5b44');
}

function drawServerRack(ctx: CanvasRenderingContext2D, time: number): void {
  const x = 900;
  const y = 130;
  px(ctx, x - 3, y + 5, 48, 88, 'rgba(0,0,0,0.3)');
  px(ctx, x, y, 44, 86, '#121e2d');
  px(ctx, x + 3, y + 4, 38, 78, '#0a1320');
  for (let row = 0; row < 6; row += 1) {
    px(ctx, x + 5, y + 7 + row * 12, 34, 9, '#152337');
    for (let light = 0; light < 3; light += 1) {
      const on = Math.sin(time * 0.006 + row * 1.7 + light) > 0.25;
      px(ctx, x + 9 + light * 5, y + 10 + row * 12, 2, 2, on ? '#67e8a5' : '#275042');
    }
    px(ctx, x + 27, y + 10 + row * 12, 8, 1, '#2b3c55');
  }
  px(ctx, x + 2, y + 84, 40, 2, '#263852');
  px(ctx, x + 12, y + 86, 20, 2, '#60e0bc');
}

function drawCoffeeCart(ctx: CanvasRenderingContext2D, time: number): void {
  const x = 38;
  const y = 236;
  px(ctx, x, y, 62, 43, '#42332c');
  px(ctx, x + 3, y + 3, 56, 31, '#5b4539');
  px(ctx, x + 6, y + 5, 22, 18, '#1a2636');
  px(ctx, x + 8, y + 7, 18, 10, '#0b1420');
  px(ctx, x + 11, y + 9, 12, 1, '#f6c453');
  px(ctx, x + 11, y + 12, 8, 1, '#5aa9ff');
  px(ctx, x + 35, y + 8, 15, 17, '#d8e2ef');
  px(ctx, x + 38, y + 5, 9, 4, '#aebccd');
  px(ctx, x + 33, y + 25, 21, 3, '#2a201b');
  px(ctx, x + 7, y + 34, 48, 4, '#2b211c');
  px(ctx, x + 10, y + 38, 3, 5, '#1c1511');
  px(ctx, x + 49, y + 38, 3, 5, '#1c1511');
  const steam = Math.sin(time * 0.003) * 2;
  ctx.strokeStyle = 'rgba(208, 225, 244, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 42, y + 4);
  ctx.quadraticCurveTo(x + 45 + steam, y - 3, x + 41, y - 9);
  ctx.stroke();
}

function drawDecor(ctx: CanvasRenderingContext2D, time: number): void {
  drawPlant(ctx, 894, 238, 1, time);
  drawPlant(ctx, 75, 164, 0.85, time);
  drawPlant(ctx, 908, 514, 0.9, time);
  drawPlant(ctx, 52, 512, 1.1, time);
  drawServerRack(ctx, time);
  drawCoffeeCart(ctx, time);
  px(ctx, 320, 486, 18, 22, '#263b55');
  px(ctx, 322, 488, 14, 16, '#0f1a29');
  px(ctx, 325, 491, 8, 1, '#49647f');
  px(ctx, 325, 494, 6, 1, '#49647f');
  px(ctx, 337, 482, 4, 4, '#f6c453');
}

function drawConnections(ctx: CanvasRenderingContext2D, agents: AgentView[], active: boolean): void {
  if (!active) return;
  const ceoHome = AGENT_PROFILE_MAP.ceo.home;
  for (const agent of agents) {
    if (agent.id === 'ceo') continue;
    if (!['working', 'thinking', 'waiting'].includes(agent.status)) continue;
    const home = AGENT_PROFILE_MAP[agent.id].home;
    ctx.save();
    ctx.strokeStyle = `${statusColor(agent.status)}28`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(ceoHome.x, ceoHome.y - 10);
    ctx.bezierCurveTo(
      ceoHome.x + (home.x - ceoHome.x) * 0.3,
      ceoHome.y + 80,
      home.x,
      home.y - 110,
      home.x,
      home.y - 44,
    );
    ctx.stroke();
    ctx.restore();
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1] ?? '';
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  agent: AgentView,
  x: number,
  y: number,
  time: number,
): void {
  if (!agent.message) return;
  const age = Date.now() - Date.parse(agent.updatedAt);
  const fresh = Number.isFinite(age) && age < 16_000;
  if (!fresh && !['working', 'thinking', 'waiting', 'error'].includes(agent.status)) return;

  const color = statusColor(agent.status);
  ctx.save();
  ctx.font = '11px "Courier New", monospace';
  const lines = wrapText(ctx, agent.message, 178, 3);
  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const width = Math.min(196, Math.max(82, textWidth + 18));
  const height = 14 + lines.length * 14;
  const bubbleX = Math.max(14, Math.min(WIDTH - width - 14, x - width / 2));
  const bubbleY = Math.max(116, y - 78 - height + Math.sin(time * 0.003 + x) * 1.5);

  px(ctx, bubbleX + 4, bubbleY + 4, width, height, 'rgba(0,0,0,0.28)');
  px(ctx, bubbleX, bubbleY, width, height, 'rgba(9, 16, 28, 0.96)');
  ctx.strokeStyle = `${color}99`;
  ctx.lineWidth = 1;
  ctx.strokeRect(bubbleX + 0.5, bubbleY + 0.5, width - 1, height - 1);
  px(ctx, bubbleX, bubbleY, 3, height, color);

  // Tail.
  const tailX = Math.max(bubbleX + 12, Math.min(bubbleX + width - 18, x - 5));
  px(ctx, tailX, bubbleY + height, 9, 2, `${color}99`);
  px(ctx, tailX + 3, bubbleY + height + 2, 5, 2, `${color}99`);
  px(ctx, tailX + 5, bubbleY + height + 4, 2, 2, `${color}99`);

  ctx.fillStyle = '#d4e2f1';
  lines.forEach((line, index) => {
    ctx.fillText(line, bubbleX + 9, bubbleY + 16 + index * 14);
  });
  ctx.restore();
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  anim: AnimAgent,
  agent: AgentView,
  time: number,
): void {
  const profile = AGENT_PROFILE_MAP[anim.id];
  const color = statusColor(agent.status);
  const bob = anim.walking
    ? Math.abs(Math.sin(time * 0.012 + anim.phase)) * 2
    : ['thinking', 'working', 'celebrating'].includes(agent.status)
      ? 0.8 + Math.sin(time * 0.0035 + anim.phase) * 0.8
      : Math.sin(time * 0.0014 + anim.phase) * 0.6;

  if (['working', 'thinking', 'waiting'].includes(agent.status)) {
    const aura = ctx.createRadialGradient(anim.x, anim.y - 24, 4, anim.x, anim.y - 24, 44);
    aura.addColorStop(0, `${color}20`);
    aura.addColorStop(1, `${color}00`);
    ctx.fillStyle = aura;
    ctx.fillRect(anim.x - 46, anim.y - 72, 92, 92);
  }

  drawAgentSprite(ctx, anim.x, anim.y, 3, profile.sprite as SpriteId, {
    bob,
    walking: anim.walking,
    facing: anim.facing,
  });

  // Status pip above the head.
  const pipY = anim.y - 79 - bob;
  ctx.save();
  ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(time * 0.004 + anim.phase));
  px(ctx, anim.x + 10, pipY, 8, 8, '#0a1220');
  px(ctx, anim.x + 11, pipY + 1, 6, 6, color);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.font = '8px "Courier New", monospace';
  ctx.textAlign = 'left';
  ctx.fillText(agent.status.toUpperCase(), anim.x + 22, pipY + 7);
  ctx.restore();

  // Name tag when away from the desk.
  const home = profile.home;
  if (Math.abs(anim.x - home.x) > 28 || Math.abs(anim.y - home.y) > 20) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '9px "Courier New", monospace';
    const width = Math.max(48, ctx.measureText(profile.name).width + 12);
    px(ctx, anim.x - width / 2, anim.y + 5, width, 12, 'rgba(9, 16, 28, 0.85)');
    ctx.fillStyle = color;
    ctx.fillRect(anim.x - width / 2, anim.y + 5, 2, 12);
    ctx.fillStyle = '#a8b9cd';
    ctx.fillText(profile.name, anim.x + 1, anim.y + 14);
    ctx.restore();
  }
}

function drawConfetti(ctx: CanvasRenderingContext2D, time: number): void {
  const colors = ['#f6c453', '#5aa9ff', '#ff7ab6', '#67e8a5', '#b08cff'];
  for (let index = 0; index < 38; index += 1) {
    const speed = 15 + (index % 5) * 7;
    const x = (index * 97 + Math.sin(time * 0.001 + index) * 30) % WIDTH;
    const y = (index * 61 + time * 0.001 * speed) % HEIGHT;
    ctx.fillStyle = colors[index % colors.length] ?? '#f6c453';
    ctx.globalAlpha = 0.32 + (index % 4) * 0.14;
    ctx.fillRect(x, y, 2 + (index % 2), 4 + (index % 3));
  }
  ctx.globalAlpha = 1;
}

function drawVignette(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 180, WIDTH / 2, HEIGHT / 2, 600);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

export function OfficeCanvas({ agents, run, tasks, connected }: SceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef<SceneProps>({ agents, run, tasks, connected });
  propsRef.current = { agents, run, tasks, connected };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const animations = new Map<AgentId, AnimAgent>();
    for (const profile of AGENT_PROFILES) {
      animations.set(profile.id, {
        id: profile.id,
        x: profile.home.x,
        y: profile.home.y,
        targetX: profile.home.x,
        targetY: profile.home.y,
        facing: 1,
        phase: Math.random() * Math.PI * 2,
        walking: false,
        nextWander: performance.now() + 4_000 + Math.random() * 6_000,
        wanderStage: 0,
      });
    }

    let frame = 0;
    let last = 0;
    let stopped = false;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const render = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(render);
      if (now - last < 32) return;
      const dt = Math.min(0.08, (now - last) / 1000) || 0.016;
      last = now;

      const current = propsRef.current;
      const active = current.run?.status === 'planning' || current.run?.status === 'running';
      const gathered =
        current.run?.status === 'completed' &&
        (!current.run.completedAt || Date.now() - Date.parse(current.run.completedAt) < 180_000);
      const viewById = new Map(current.agents.map((agent) => [agent.id, agent]));

      for (const profile of AGENT_PROFILES) {
        const anim = animations.get(profile.id);
        if (!anim) continue;
        const view = viewById.get(profile.id);
        const status = view?.status ?? 'idle';

        let targetX = profile.home.x;
        let targetY = profile.home.y;
        if (gathered) {
          const gather = GATHER_POINTS[profile.id];
          targetX = gather.x;
          targetY = gather.y;
        } else if (!active && status === 'idle' && profile.id !== 'ceo' && !reduceMotion) {
          const loiter = LOITER_POINTS[profile.id];
          if (loiter && now > anim.nextWander && anim.wanderStage === 0) {
            anim.wanderStage = 1;
            anim.nextWander = now + 3_500;
          } else if (anim.wanderStage === 1 && now > anim.nextWander) {
            anim.wanderStage = 0;
            anim.nextWander = now + 9_000 + Math.random() * 8_000;
          }
          if (anim.wanderStage === 1 && loiter) {
            targetX = loiter.x;
            targetY = loiter.y;
          }
        } else {
          anim.wanderStage = 0;
          anim.nextWander = now + 8_000;
        }

        anim.targetX = targetX;
        anim.targetY = targetY;
        const dx = targetX - anim.x;
        const dy = targetY - anim.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 1.5) {
          const speed = reduceMotion ? 240 : status === 'celebrating' ? 45 : 82;
          const step = Math.min(distance, speed * dt);
          anim.x += (dx / distance) * step;
          anim.y += (dy / distance) * step;
          anim.facing = dx > 0 ? 1 : -1;
          anim.walking = !reduceMotion;
        } else {
          anim.x = targetX;
          anim.y = targetY;
          anim.walking = false;
        }
      }

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      drawWall(ctx, now);
      drawFloor(ctx, now);
      drawConnections(ctx, current.agents, Boolean(active));

      const viewByIdForDesk = new Map(current.agents.map((agent) => [agent.id, agent]));
      for (const profile of AGENT_PROFILES) {
        drawDesk(ctx, profile.id, viewByIdForDesk.get(profile.id), now);
      }
      drawMeetingTable(ctx, now);
      drawDecor(ctx, now);

      const drawables = [...animations.values()]
        .map((anim) => ({
          anim,
          view: viewById.get(anim.id) ?? {
            id: anim.id,
            status: 'idle' as AgentStatus,
            message: null,
            updatedAt: new Date().toISOString(),
          },
        }))
        .sort((a, b) => a.anim.y - b.anim.y);

      const fullAgents: AgentView[] = [];
      for (const drawable of drawables) {
        const full = current.agents.find((agent) => agent.id === drawable.anim.id);
        if (full) {
          fullAgents.push(full);
          drawAgent(ctx, drawable.anim, full, now);
        }
      }

      for (const agent of fullAgents) {
        const anim = animations.get(agent.id);
        if (anim) drawBubble(ctx, agent, anim.x, anim.y, now);
      }

      if (gathered) drawConfetti(ctx, now);
      drawVignette(ctx);

      if (!connected && active) {
        px(ctx, 12, 12, 132, 24, 'rgba(9, 16, 28, 0.92)');
        px(ctx, 12, 12, 3, 24, '#ff9f43');
        ctx.fillStyle = '#ffb86b';
        ctx.font = '10px "Courier New", monospace';
        ctx.fillText('RECONNECTING FEED', 23, 28);
      }

      // A tiny live indicator keeps the stage feeling alive even when idle.
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.35 * Math.abs(Math.sin(now * 0.002));
      px(ctx, 926, 18, 6, 6, active ? '#f6c453' : '#4d647f');
      ctx.restore();
    };

    frame = requestAnimationFrame(render);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  const label = run
    ? `Pixel office scene. Mission status ${run.status}. ${agents
        .map((agent) => `${agent.name}: ${agent.status}`)
        .join(', ')}.`
    : 'Pixel office scene with five idle AI agents.';
  const activeTasks = tasks.filter((task) => task.status === 'running').length;

  return (
    <div className="office-canvas-wrap">
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="office-canvas"
        role="img"
        aria-label={label}
      />
      <div className="office-canvas-overlay" aria-hidden="true">
        <div className="office-floor-tag">
          <span className={`live-dot ${run?.status === 'running' || run?.status === 'planning' ? 'is-live' : ''}`} />
          <span>FLOOR 01</span>
          <span className="floor-sep">//</span>
          <span>{activeTasks} ACTIVE</span>
        </div>
        <div className="office-coords">960×540 · PX</div>
      </div>
    </div>
  );
}
