import { useEffect, useRef, type CSSProperties } from 'react';
import { AGENT_PROFILE_MAP, type AgentId, type AgentStatus } from '../../shared/types';
import { drawAgentSprite, type SpriteId } from '../office/sprites';

interface AgentAvatarProps {
  agentId: AgentId;
  size?: number;
  status?: AgentStatus;
  showStatus?: boolean;
}

export function AgentAvatar({ agentId, size = 48, status = 'idle', showStatus = false }: AgentAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const profile = AGENT_PROFILE_MAP[agentId];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    drawAgentSprite(ctx, size / 2, size - 4, size / 27, profile.sprite as SpriteId, {
      facing: 1,
    });
  }, [agentId, profile.sprite, size]);

  const style = {
    width: size,
    height: size,
    '--agent-color': profile.color,
    '--agent-accent': profile.accent,
  } as CSSProperties;

  return (
    <span className={`agent-avatar is-${status}`} style={style} aria-hidden="true">
      <canvas ref={canvasRef} />
      {showStatus ? <span className="agent-avatar-dot" /> : null}
    </span>
  );
}
