import { useEffect, useRef } from 'react';

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
};

const GRAVITY = 0.035;
const DRAG = 0.985;
const SPARKS_PER_BURST = 70;
const BURST_EVERY_FRAMES = 28;

function burst(sparks: Spark[], width: number, height: number): void {
  const x = width * (0.15 + Math.random() * 0.7);
  const y = height * (0.12 + Math.random() * 0.35);
  const hue = Math.floor(Math.random() * 360);
  for (let index = 0; index < SPARKS_PER_BURST; index++) {
    const angle = (index / SPARKS_PER_BURST) * Math.PI * 2;
    const speed = 1.5 + Math.random() * 3.5;
    sparks.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      hue: hue + Math.random() * 40,
    });
  }
}

function step(context: CanvasRenderingContext2D, sparks: Spark[]): Spark[] {
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = 'rgba(0, 0, 0, 0.22)';
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.globalCompositeOperation = 'lighter';
  for (const spark of sparks) {
    spark.vx *= DRAG;
    spark.vy = spark.vy * DRAG + GRAVITY;
    spark.x += spark.vx;
    spark.y += spark.vy;
    spark.life -= 0.012;
    context.fillStyle = `hsla(${spark.hue}, 100%, 65%, ${Math.max(0, spark.life)})`;
    context.fillRect(spark.x, spark.y, 2.5, 2.5);
  }
  return sparks.filter((spark) => spark.life > 0);
}

/** Full-screen fireworks for a perfect score. Purely decorative. */
export function FireworksCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;
    if (canvas === null || context === null) {
      return undefined;
    }

    let sparks: Spark[] = [];
    let frame = 0;
    let raf = 0;
    const resize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    };
    const loop = () => {
      if (frame % BURST_EVERY_FRAMES === 0) {
        burst(sparks, canvas.width, canvas.height);
      }
      sparks = step(context, sparks);
      frame++;
      raf = requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full mix-blend-screen"
    />
  );
}
