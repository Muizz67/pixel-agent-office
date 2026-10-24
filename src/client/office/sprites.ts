export type SpriteId = 'ceo' | 'researcher' | 'designer' | 'engineer' | 'reviewer';

interface Palette {
  skin: string;
  skinShade: string;
  hair: string;
  hairShade: string;
  outfit: string;
  outfitShade: string;
  accent: string;
  pants: string;
  shoes: string;
}

const PALETTES: Record<SpriteId, Palette> = {
  ceo: {
    skin: '#e7b58b',
    skinShade: '#c68f68',
    hair: '#2c2118',
    hairShade: '#1a130d',
    outfit: '#1d2a44',
    outfitShade: '#111a2c',
    accent: '#f6c453',
    pants: '#111827',
    shoes: '#090d14',
  },
  researcher: {
    skin: '#d9a77c',
    skinShade: '#b8845d',
    hair: '#20242b',
    hairShade: '#111318',
    outfit: '#2f8f72',
    outfitShade: '#1d6250',
    accent: '#7bf0c8',
    pants: '#1a2a2e',
    shoes: '#0b1215',
  },
  designer: {
    skin: '#f0c4a2',
    skinShade: '#cd9d7b',
    hair: '#ff8fc5',
    hairShade: '#c75b91',
    outfit: '#d95f92',
    outfitShade: '#9b3560',
    accent: '#ffe0ef',
    pants: '#242338',
    shoes: '#12101b',
  },
  engineer: {
    skin: '#c98f68',
    skinShade: '#a26d4b',
    hair: '#131c28',
    hairShade: '#0a1018',
    outfit: '#2f6fb3',
    outfitShade: '#1d4a7b',
    accent: '#5aa9ff',
    pants: '#172538',
    shoes: '#0a111c',
  },
  reviewer: {
    skin: '#9b6548',
    skinShade: '#764a34',
    hair: '#241a2e',
    hairShade: '#140e1b',
    outfit: '#6f55b5',
    outfitShade: '#4c3982',
    accent: '#d7c9ff',
    pants: '#19152a',
    shoes: '#0c0913',
  },
};

export interface DrawAgentOptions {
  bob?: number;
  walking?: boolean;
  facing?: 1 | -1;
  ghosted?: boolean;
}

/**
 * Draws a 16x24 pixel character with its feet at (x, y). All coordinates are
 * snapped to whole pixels so the sprite stays crisp at any integer scale.
 */
export function drawAgentSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  sprite: SpriteId,
  options: DrawAgentOptions = {},
): void {
  const palette = PALETTES[sprite];
  const facing = options.facing ?? 1;
  const bob = options.bob ?? 0;
  const walking = options.walking ?? false;

  ctx.save();
  ctx.globalAlpha = options.ghosted ? 0.35 : 1;
  ctx.translate(Math.round(x), Math.round(y));

  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.beginPath();
  ctx.ellipse(0, -1, 9 * scale, 2.5 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(0, -bob);
  if (facing === -1) ctx.scale(-1, 1);

  const px = (gx: number, gy: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect((gx - 8) * scale, (gy - 24) * scale, w * scale, h * scale);
  };

  // Legs and shoes. A one-pixel lift on alternating legs sells the walk cycle.
  const leftLift = walking ? 1 : 0;
  px(5, 17, 3, 5, palette.pants);
  px(9, 17, 3, 5 + (walking ? 0 : 0), palette.pants);
  px(4, 22 - leftLift, 4, 2, palette.shoes);
  px(9, 22, 4, 2, palette.shoes);
  px(5, 18, 1, 3, palette.outfitShade);
  px(9, 18, 1, 3, palette.outfitShade);

  // Torso.
  px(4, 10, 8, 8, palette.outfit);
  px(4, 10, 8, 2, palette.outfitShade);
  px(5, 12, 6, 1, palette.accent);
  px(4, 16, 8, 1, palette.outfitShade);

  if (sprite === 'ceo') {
    px(7, 12, 2, 5, '#dce8f5');
    px(7, 12, 1, 5, palette.accent);
    px(6, 10, 4, 1, '#f1f6fb');
  } else if (sprite === 'researcher') {
    px(5, 12, 6, 1, palette.accent);
    px(10, 13, 2, 3, '#22313a');
    px(11, 14, 1, 1, '#f1d36a');
  } else if (sprite === 'designer') {
    px(6, 14, 4, 1, palette.accent);
    px(4, 10, 2, 5, palette.outfitShade);
    px(10, 10, 2, 5, palette.outfitShade);
  } else if (sprite === 'engineer') {
    px(5, 13, 2, 2, '#dce8f5');
    px(9, 13, 2, 2, '#dce8f5');
    px(4, 10, 8, 1, '#4b8dce');
  } else {
    px(4, 10, 8, 5, palette.outfit);
    px(4, 10, 1, 4, '#f6f0ff');
    px(11, 10, 1, 4, '#f6f0ff');
  }

  // Arms.
  px(2, 11, 2, 6, palette.outfitShade);
  px(12, 11, 2, 6, palette.outfit);
  px(2, 16, 2, 2, palette.skinShade);
  px(12, 16, 2, 2, palette.skin);

  // Neck and head.
  px(7, 9, 2, 2, palette.skinShade);
  px(4, 3, 8, 8, palette.skin);
  px(4, 9, 8, 1, palette.skinShade);
  px(4, 3, 1, 4, palette.skinShade);
  px(3, 4, 1, 4, palette.skinShade);

  // Hair varies by character.
  if (sprite === 'designer') {
    px(3, 2, 10, 3, palette.hair);
    px(2, 3, 2, 7, palette.hair);
    px(12, 3, 2, 6, palette.hairShade);
    px(3, 5, 2, 1, palette.hairShade);
    px(13, 8, 1, 1, '#f7d365');
  } else if (sprite === 'engineer') {
    px(3, 2, 10, 3, palette.hair);
    px(2, 3, 1, 4, palette.hairShade);
    px(11, 1, 4, 2, palette.accent);
    px(14, 2, 2, 1, palette.accent);
    px(4, 4, 2, 1, palette.hairShade);
  } else if (sprite === 'reviewer') {
    px(2, 2, 12, 4, palette.hair);
    px(2, 3, 2, 5, palette.hair);
    px(12, 3, 2, 5, palette.hairShade);
    px(3, 6, 1, 2, palette.hairShade);
    px(12, 6, 1, 2, palette.hairShade);
  } else if (sprite === 'researcher') {
    px(3, 2, 10, 3, palette.hair);
    px(3, 4, 1, 2, palette.hairShade);
    px(12, 3, 1, 3, palette.hair);
    px(2, 3, 1, 3, palette.hairShade);
  } else {
    px(3, 2, 10, 3, palette.hair);
    px(2, 3, 1, 3, palette.hairShade);
    px(13, 3, 1, 3, palette.hair);
    px(4, 2, 3, 1, palette.hairShade);
  }

  // Eyes and optional glasses.
  const eyeY = 6;
  if (sprite === 'engineer') {
    px(5, eyeY, 2, 1, '#f8fafc');
    px(9, eyeY, 2, 1, '#f8fafc');
    px(6, eyeY, 1, 1, '#1a2433');
    px(9, eyeY, 1, 1, '#1a2433');
  } else {
    px(5, eyeY, 1, 2, '#20242d');
    px(10, eyeY, 1, 2, '#20242d');
    if (sprite === 'researcher' || sprite === 'reviewer') {
      px(4, eyeY - 1, 3, 1, '#f7f3e8');
      px(9, eyeY - 1, 3, 1, '#f7f3e8');
      px(4, eyeY - 1, 1, 3, '#f7f3e8');
      px(11, eyeY - 1, 1, 3, '#f7f3e8');
      px(7, eyeY, 2, 1, '#f7f3e8');
    }
  }

  // Mouth.
  px(7, 9, 2, 1, sprite === 'designer' ? '#b3486f' : palette.skinShade);

  // A little laptop glint for the engineer / CEO lapel pin.
  if (sprite === 'ceo') px(10, 12, 1, 1, '#f6c453');
  if (sprite === 'researcher') px(3, 14, 1, 2, palette.accent);

  ctx.restore();
}

export function drawAvatar(canvas: HTMLCanvasElement, sprite: SpriteId, color: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = 64;
  const height = 76;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = `${color}18`;
  ctx.fillRect(3, 3, width - 6, height - 6);
  ctx.strokeStyle = `${color}55`;
  ctx.lineWidth = 1;
  ctx.strokeRect(3.5, 3.5, width - 7, height - 7);
  drawAgentSprite(ctx, width / 2, height - 7, 2.5, sprite);
}
