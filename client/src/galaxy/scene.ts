export interface SceneDevice {
  id: string;
  name: string;
  online: boolean;
  joinAt: number;
}

export interface SceneOpts {
  getDevices: () => SceneDevice[];
  getSelfId: () => string;
  /** 已建立连接的设备对（用于画连线） */
  getLinks: () => [string, string][];
  onSelect: (id: string | null) => void;
}

const PALETTE = ['#ffd479', '#7aa2ff', '#ff8f6b', '#8de6b0', '#d9a1ff', '#7fd8ff', '#ff9fc2', '#f6e58d'];
const RING_GAP = 95;
const ORBIT_SQUASH = 0.53; // 椭圆轨道纵向压扁比，与背景星系盘 rotateX(58°) 的透视一致
const BG_STAR_COUNT = 320;
const SHOOT_CYCLE = 4.5; // 每 4.5 秒一波流星

function hexA(a: number): string {
  return Math.max(0, Math.min(255, Math.round(a * 255))).toString(16).padStart(2, '0');
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StarPos {
  angle: number;
  ring: number;
  jitter: number;
  phase: number;
  color: string;
  size: number;
  hasRing: boolean;
  ringTilt: number;
  ringSquash: number;
  moonCount: number;
  moonSpeed: number;
  bands: number;
}

interface BgStar {
  ox: number; // 相对中心的偏移（-1.25..1.25，乘以画布对角线一半）
  oy: number;
  r: number;
  color: string;
  phase: number;
  speed: number;
  base: number;
}

interface Nebula {
  ox: number;
  oy: number;
  r: number;
  color: string;
  alpha: number;
  phase: number;
}

export class Galaxy {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: SceneOpts;
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private pos = new Map<string, StarPos>();
  private hit = new Map<string, { x: number; y: number; r: number }>();
  private bg: BgStar[] = [];
  private nebulas: Nebula[] = [];

  constructor(canvas: HTMLCanvasElement, opts: SceneOpts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.opts = opts;

    const rand = mulberry32(20261016);
    const nebulaDefs: [number, number, number, string, number][] = [
      [-0.55, -0.45, 300, '139,108,255', 0.09],
      [0.6, -0.3, 260, '64,150,255', 0.08],
      [0.5, 0.55, 320, '40,190,170', 0.07],
      [-0.45, 0.5, 240, '255,150,90', 0.06],
    ];
    for (const [ox, oy, r, color, alpha] of nebulaDefs) {
      this.nebulas.push({ ox, oy, r, color, alpha, phase: rand() * Math.PI * 2 });
    }

    canvas.addEventListener('click', (e) => this.onClick(e));
    canvas.addEventListener('mousemove', (e) => this.onHover(e));
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.buildBg();
  }

  /** 背景星按屏幕面积生成：PC 大屏自动加密，与手机小屏观感一致 */
  private buildBg(): void {
    const count = Math.max(BG_STAR_COUNT, Math.min(1100, Math.round((this.w * this.h) / 2400)));
    const rand = mulberry32(20261016);
    const starColors = ['#cdd7ff', '#cdd7ff', '#ffffff', '#ffe0b0', '#a8c8ff', '#ffc0d8'];
    this.bg = [];
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * 1.25;
      this.bg.push({
        ox: Math.cos(a) * d,
        oy: Math.sin(a) * d,
        r: 0.3 + rand() * 1.4,
        color: starColors[Math.floor(rand() * starColors.length)],
        phase: rand() * Math.PI * 2,
        speed: 0.25 + rand() * 1.4,
        base: 0.15 + rand() * 0.55,
      });
    }
  }

  private assign(devices: SceneDevice[]): void {
    const ids = new Set(devices.map((d) => d.id));
    for (const id of [...this.pos.keys()]) {
      if (!ids.has(id)) this.pos.delete(id);
    }
    for (const d of devices) {
      if (this.pos.has(d.id)) continue;
      let angle = hash01(d.id) * Math.PI * 2;
      const ring = 1 + Math.floor(hash01(d.id + 'ring') * 4);
      const jitter = 0.96 + hash01(d.id + 'j') * 0.08; // 轻微偏移，行星紧贴轨道线
      for (let i = 0; i < 12; i++) {
        const a = angle + i * 0.37;
        const x = Math.cos(a) * ring * RING_GAP * jitter;
        const y = Math.sin(a) * ring * RING_GAP * jitter;
        let ok = true;
        for (const [, p] of this.pos) {
          if (p.ring !== ring) continue;
          const ox = Math.cos(p.angle) * p.ring * RING_GAP * p.jitter;
          const oy = Math.sin(p.angle) * p.ring * RING_GAP * p.jitter;
          if (Math.hypot(x - ox, y - oy) < 55) {
            ok = false;
            break;
          }
        }
        if (ok || i === 11) {
          angle = a;
          break;
        }
      }
      this.pos.set(d.id, {
        angle, ring, jitter,
        phase: hash01(d.id + 'p') * Math.PI * 2,
        color: PALETTE[Math.floor(hash01(d.id + 'c') * PALETTE.length)],
        size: 7.5 + hash01(d.id + 's') * 4.5,
        hasRing: true, // 每颗星球都带环，倾角/扁率随机区分个性
        ringTilt: (hash01(d.id + 'rtilt') - 0.5) * 0.9,
        ringSquash: 0.3 + hash01(d.id + 'rsq') * 0.25,
        moonCount: 1 + Math.floor(hash01(d.id + 'moons') * 3),
        moonSpeed: 0.4 + hash01(d.id + 'mspeed') * 0.7,
        bands: 2 + Math.floor(hash01(d.id + 'bands') * 3),
      });
    }
  }

  private loop(tms: number): void {
    this.draw(tms / 1000);
    this.raf = requestAnimationFrame(this.loop);
  }

  private draw(t: number): void {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.hit.clear();

    const cx = w / 2;
    const cy = h / 2;
    const halfDiag = Math.hypot(w, h) / 2;
    const scale = Math.max(0.5, Math.min(1.1, (Math.min(w, h) / 2 - 60) / (4 * RING_GAP)));

    // 星云（半径随视口缩放，PC 上不会显得小）
    const nScale = Math.min(2.4, Math.max(1, Math.min(w, h) / 700));
    for (const n of this.nebulas) {
      const a = n.alpha * (0.8 + 0.2 * Math.sin(t * 0.4 + n.phase));
      const nr = n.r * nScale;
      const g = ctx.createRadialGradient(
        cx + n.ox * halfDiag, cy + n.oy * halfDiag, 10,
        cx + n.ox * halfDiag, cy + n.oy * halfDiag, nr,
      );
      g.addColorStop(0, `rgba(${n.color},${a.toFixed(3)})`);
      g.addColorStop(1, `rgba(${n.color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // 缓慢旋转的星空
    const rot = t * 0.008;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    for (const s of this.bg) {
      const x = cx + (s.ox * cosR - s.oy * sinR) * halfDiag;
      const y = cy + (s.ox * sinR + s.oy * cosR) * halfDiag;
      if (x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;
      const tw = s.base + 0.35 * Math.sin(t * s.speed + s.phase) ** 2;
      ctx.globalAlpha = Math.max(0.05, Math.min(1, tw));
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 流星（每波 1~2 颗）：飞越大半屏，全程带渐入→巡航→渐出包络，绝不瞬间消失
    const drawMeteor = (seed: string, p: number): void => {
      if (p <= 0 || p >= 1) return;
      const r1 = hash01(seed + 'x');
      const r2 = hash01(seed + 'y');
      const r3 = hash01(seed + 'z');
      const travel = Math.max(w, h) * (0.5 + 0.25 * r3);
      const sx = w * (0.02 + 0.55 * r1);
      const sy = h * (-0.06 + 0.28 * r2);
      const dx = 0.62 + 0.35 * r2;
      const dy = 0.38 + 0.3 * r3;
      const dl = Math.hypot(dx, dy);
      const ux = dx / dl;
      const uy = dy / dl;
      const hx = sx + ux * travel * p;
      const hy = sy + uy * travel * p;
      const len = 130 + r3 * 100;
      // 生命周期包络：0~12% 渐入，12%~68% 稳定，68%~100% 平滑渐出到 0
      const env = p < 0.12 ? p / 0.12 : p > 0.68 ? Math.max(0, (1 - p) / 0.32) : 1;
      const ease = env * env * (3 - 2 * env); // smoothstep
      const tail = ctx.createLinearGradient(hx - ux * len, hy - uy * len, hx, hy);
      tail.addColorStop(0, 'rgba(210,225,255,0)');
      tail.addColorStop(0.6, `rgba(215,230,255,${(0.35 * ease).toFixed(3)})`);
      tail.addColorStop(1, `rgba(240,246,255,${(0.92 * ease).toFixed(3)})`);
      ctx.strokeStyle = tail;
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx - ux * len, hy - uy * len);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      const head = ctx.createRadialGradient(hx, hy, 0, hx, hy, 5);
      head.addColorStop(0, `rgba(255,255,255,${(0.95 * ease).toFixed(3)})`);
      head.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = head;
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
    };
    const metIdx = Math.floor(t / SHOOT_CYCLE);
    const metCycle = t % SHOOT_CYCLE;
    if (metCycle < 1.7) {
      const p = metCycle / 1.7;
      drawMeteor(`m${metIdx}a`, p);
      if (metIdx % 2 === 0) drawMeteor(`m${metIdx}b`, p * 0.7 + 0.18); // 错峰的第二颗
      if (metIdx % 3 === 0) drawMeteor(`m${metIdx}c`, p * 0.55 + 0.4); // 更晚的第三颗
    }

    // 椭圆轨道：与背景星系盘同心的透视椭圆，近侧更亮（行星滑行其上）
    for (let ring = 1; ring <= 4; ring++) {
      const or = ring * RING_GAP * scale;
      const og = ctx.createLinearGradient(cx, cy - or * ORBIT_SQUASH, cx, cy + or * ORBIT_SQUASH);
      og.addColorStop(0, 'rgba(150,170,230,0.09)'); // 远侧淡
      og.addColorStop(0.5, 'rgba(165,185,250,0.055)');
      og.addColorStop(1, 'rgba(195,210,255,0.17)'); // 近侧亮
      ctx.strokeStyle = og;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, or, or * ORBIT_SQUASH, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    const devices = this.opts.getDevices();
    this.assign(devices);
    const selfId = this.opts.getSelfId();

    // 椭圆轨道布局：按 y 排序，远侧（盘面上方）先画、从太阳背后经过
    const placed = devices
      .map((d) => ({ d, p: this.pos.get(d.id), pos: this.xy(d.id, cx, cy, scale) }))
      .filter((e): e is { d: SceneDevice; p: StarPos; pos: { x: number; y: number } } => !!(e.p && e.pos))
      .sort((a, b) => a.pos.y - b.pos.y);
    for (const e of placed) {
      if (e.pos.y <= cy) this.drawDevice(e.d, e.p, e.pos, t, selfId, scale);
    }

    // 中心恒星：多层日冕 + 双层旋转光芒 + 米粒组织 + 临边昏暗 + 耀斑环
    const sunR = 26;

    // 外层日冕（呼吸脉动）
    const coronaP = 1 + Math.sin(t * 1.1) * 0.06;
    const corona = ctx.createRadialGradient(cx, cy, sunR * 0.5, cx, cy, sunR * 3.2 * coronaP);
    corona.addColorStop(0, 'rgba(255,238,190,0.5)');
    corona.addColorStop(0.35, 'rgba(255,190,90,0.2)');
    corona.addColorStop(0.7, 'rgba(255,150,60,0.06)');
    corona.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(cx, cy, sunR * 3.2 * coronaP, 0, Math.PI * 2);
    ctx.fill();

    // 极外柔光晕：把日冕与深空自然衔接
    const haze = ctx.createRadialGradient(cx, cy, sunR, cx, cy, sunR * 6);
    haze.addColorStop(0, 'rgba(255,180,90,0.05)');
    haze.addColorStop(1, 'rgba(255,180,90,0)');
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, sunR * 6, 0, Math.PI * 2);
    ctx.fill();

    // 双层日冕羽流：多层渐隐的细曲线（粗细叠加出柔光），外层顺转、内层逆转
    const coronaRays = (count: number, lenK: number, speed: number, seed: number) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * speed);
      ctx.lineCap = 'round';
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + hash01(`st${seed}x${i}`) * 0.5;
        ctx.save();
        ctx.rotate(a);
        const len = sunR * (lenK + 0.5 * Math.sin(t * 0.45 + i * 1.9 + seed));
        const bend = sunR * 0.35 * Math.sin(t * 0.3 + i * 2.3 + seed);
        // 三层描边由粗到细叠加，模拟光线的柔散感；沿路径渐隐到 0
        for (const [wMul, aMul] of [[3.4, 0.05], [1.6, 0.1], [0.7, 0.18]] as [number, number][]) {
          const g = ctx.createLinearGradient(0, -sunR * 0.85, bend, -len);
          g.addColorStop(0, `rgba(255,208,132,${(0.5 * aMul).toFixed(3)})`);
          g.addColorStop(0.45, `rgba(255,196,110,${(0.34 * aMul).toFixed(3)})`);
          g.addColorStop(1, 'rgba(255,190,110,0)');
          ctx.strokeStyle = g;
          ctx.lineWidth = wMul;
          ctx.beginPath();
          ctx.moveTo(0, -sunR * 0.85);
          ctx.quadraticCurveTo(bend * 0.45, -len * 0.55, bend, -len);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    };
    coronaRays(14, 2.7, 0.08, 0);
    coronaRays(10, 1.9, -0.13, 4.2);

    // 恒星本体：核心高光 → 金黄 → 橙红的球面渐变
    const core = ctx.createRadialGradient(cx - sunR * 0.25, cy - sunR * 0.3, sunR * 0.1, cx, cy, sunR);
    core.addColorStop(0, '#fff8e6');
    core.addColorStop(0.3, '#ffe9ae');
    core.addColorStop(0.6, '#ffc45e');
    core.addColorStop(0.85, '#ff9a3c');
    core.addColorStop(1, '#ef701f');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
    ctx.fill();

    // 表面细节（裁剪在本体内）
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
    ctx.clip();
    // 米粒组织：明暗对流胞，缓慢漂移
    for (let i = 0; i < 7; i++) {
      const a = hash01(`g${i}a`) * Math.PI * 2 + t * 0.05 * (i % 2 === 0 ? 1 : -1);
      const d = hash01(`g${i}d`) * sunR * 0.75;
      const gx = cx + Math.cos(a) * d;
      const gy = cy + Math.sin(a) * d;
      const gr = sunR * (0.16 + hash01(`g${i}r`) * 0.2);
      const bright = i % 3 !== 2;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      g.addColorStop(0, bright ? 'rgba(255,244,214,0.2)' : 'rgba(200,90,20,0.16)');
      g.addColorStop(1, 'rgba(255,244,214,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.fill();
    }
    // 临边昏暗：球面边缘变暗变红（真实太阳特征）
    const limb = ctx.createRadialGradient(cx, cy, sunR * 0.5, cx, cy, sunR);
    limb.addColorStop(0, 'rgba(150,50,0,0)');
    limb.addColorStop(0.8, 'rgba(150,50,0,0.12)');
    limb.addColorStop(1, 'rgba(120,30,0,0.4)');
    ctx.fillStyle = limb;
    ctx.fillRect(cx - sunR, cy - sunR, sunR * 2, sunR * 2);
    // 耀斑环：磁力线弧圈从表面升起再消散
    for (let k = 0; k < 3; k++) {
      const cyc = (t * 0.22 + k * 1.31) % 3;
      if (cyc >= 1.7) continue;
      const p = Math.sin((cyc / 1.7) * Math.PI);
      const baseA = hash01(`flare${k}`) * Math.PI * 2;
      const x1 = cx + Math.cos(baseA) * sunR * 0.96;
      const y1 = cy + Math.sin(baseA) * sunR * 0.96;
      const x2 = cx + Math.cos(baseA + 0.5) * sunR * 0.96;
      const y2 = cy + Math.sin(baseA + 0.5) * sunR * 0.96;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const nx = mx - cx;
      const ny = my - cy;
      const nl = Math.hypot(nx, ny) || 1;
      const outR = sunR * (0.35 + 0.45 * p);
      ctx.strokeStyle = `rgba(255,180,90,${(0.5 * p).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx + (nx / nl) * outR, my + (ny / nl) * outR, x2, y2);
      ctx.stroke();
    }
    ctx.restore();

    // 已建立连接的连线（带流动光点）
    const links = this.opts.getLinks();
    for (const [a, b] of links) {
      const pa = this.xy(a, cx, cy, scale);
      const pb = this.xy(b, cx, cy, scale);
      if (!pa || !pb) continue;
      const alpha = 0.35 + 0.2 * Math.sin(t * 2.2);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = `rgba(255,212,121,${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const k = (t * 0.35) % 1;
      const mx = pa.x + (pb.x - pa.x) * k;
      const my = pa.y + (pb.y - pa.y) * k;
      ctx.fillStyle = 'rgba(255,230,170,0.9)';
      ctx.beginPath();
      ctx.arc(mx, my, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 近侧行星（盘面下方）后画，遮挡太阳
    for (const e of placed) {
      if (e.pos.y > cy) this.drawDevice(e.d, e.p, e.pos, t, selfId, scale);
    }
  }

  /** 椭圆轨道上的位置：与背景星系盘同心的透视椭圆 */
  private xy(id: string, cx: number, cy: number, scale: number): { x: number; y: number } | null {
    const p = this.pos.get(id);
    if (!p) return null;
    const r = p.ring * RING_GAP * scale * p.jitter;
    return { x: cx + Math.cos(p.angle) * r, y: cy + Math.sin(p.angle) * r * ORBIT_SQUASH };
  }

  /** 单颗设备星：行星/离线残影 + 名称标签 */
  private drawDevice(d: SceneDevice, p: StarPos, pos: { x: number; y: number }, t: number, selfId: string, scale: number): void {
    const ctx = this.ctx;
    const { x, y } = pos;
    const r = p.size * (0.9 + scale * 0.2);
    this.hit.set(d.id, { x, y, r: Math.max(r, 16) });

    if (d.online) {
      this.drawPlanet(x, y, r, p, t);
    } else {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#8b90a8';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.font = '12px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = d.online ? 'rgba(235,240,255,0.92)' : 'rgba(150,155,175,0.5)';
    const label = d.id === selfId ? `${d.name}（我）` : d.name;
    ctx.fillText(label, x, y + r + 16);
  }

  /** 立体行星：球体明暗 + 大气辉光 + 表面条纹 + 晨昏线 + 可选行星环 + 绕转卫星 */
  private drawPlanet(x: number, y: number, r: number, p: StarPos, t: number): void {
    const ctx = this.ctx;
    const pulse = 1 + Math.sin(t * 2 + p.phase) * 0.12;

    // 大气辉光
    const atm = ctx.createRadialGradient(x, y, r * 0.7, x, y, r * 2.6 * pulse);
    atm.addColorStop(0, p.color + '55');
    atm.addColorStop(0.5, p.color + '22');
    atm.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = atm;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.6 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // 卫星：沿星环所在平面滑行（与环同倾角、同扁率），sin<0 时在星球后面
    const moons: { mx: number; my: number; behind: boolean }[] = [];
    for (let i = 0; i < p.moonCount; i++) {
      const a = t * p.moonSpeed * (i % 2 === 0 ? 1 : -1) + p.phase + i * 2.4;
      // 轨道半径在星环外侧依次排开
      const md = r * (2.55 + i * 0.42);
      // 与星环同一变换：先按扁率压扁，再按环倾角旋转
      const ex = Math.cos(a) * md;
      const ey = Math.sin(a) * md * p.ringSquash;
      moons.push({
        mx: x + ex * Math.cos(p.ringTilt) - ey * Math.sin(p.ringTilt),
        my: y + ex * Math.sin(p.ringTilt) + ey * Math.cos(p.ringTilt),
        behind: Math.sin(a) < 0,
      });
    }
    const drawMoons = (behind: boolean) => {
      for (const m of moons) {
        if (m.behind !== behind) continue;
        const g = ctx.createRadialGradient(m.mx, m.my, 0, m.mx, m.my, 5);
        g.addColorStop(0, 'rgba(220,228,250,0.9)');
        g.addColorStop(1, 'rgba(220,228,250,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(m.mx, m.my, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e8edff';
        ctx.beginPath();
        ctx.arc(m.mx, m.my, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    // 行星环：立体渲染——三重环带（内亮外暗）、近大远小、行星本影、球体遮挡
    const LIGHT = { x: -0.72, y: -0.6 }; // 光源方向（左上），与球体受光面一致
    const drawRing = (front: boolean) => {
      if (!p.hasRing) return;
      const rx = r * 2.25;
      // 近大远小：前半环纵向撑开，后半环压扁收窄
      const ry = rx * p.ringSquash * (front ? 1.08 : 0.86);
      // 三重环带：tone=亮度系数，内环致密最亮、外环稀薄偏暗
      const bands = [
        { k: 1.05, w: r * 0.30, tone: 0.5 },
        { k: 0.84, w: r * 0.28, tone: 0.85 },
        { k: 0.64, w: r * 0.16, tone: 1.0 },
      ];
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.ringTilt);
      const segs = 40;
      const start = front ? 0 : Math.PI;
      for (const b of bands) {
        for (let i = 0; i < segs; i++) {
          const a0 = start + (i / segs) * Math.PI;
          const am = start + ((i + 0.5) / segs) * Math.PI;
          // 段中心的世界方向（含环倾斜），用于计算行星本影
          const cosT = Math.cos(p.ringTilt);
          const sinT = Math.sin(p.ringTilt);
          const wx = Math.cos(am) * cosT - Math.sin(am) * sinT;
          const wy = Math.cos(am) * sinT + Math.sin(am) * cosT;
          // 背光方向（右下）的环段落入行星阴影，平滑淡出
          const sdot = wx * -LIGHT.x + wy * -LIGHT.y;
          const shadow = sdot > 0.25 ? Math.max(0.06, 1 - (sdot - 0.25) * 1.2) : 1;
          // 中段（球体两侧）最亮，端头渐隐；远半整体压暗
          const mid = Math.sin(((am - start) / Math.PI) * Math.PI);
          const depth = front ? 0.5 + 0.5 * mid : 0.14 + 0.24 * mid;
          const alpha = b.tone * depth * shadow;
          ctx.strokeStyle = p.color + hexA(alpha);
          ctx.lineWidth = Math.max(0.8, b.w * (front ? 1 : 0.78));
          ctx.beginPath();
          ctx.ellipse(0, 0, rx * b.k, ry * b.k, 0, a0, a0 + (Math.PI / segs) * 1.15);
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    drawMoons(true);
    drawRing(false);

    // 球体：左上受光、右下暗边
    const sph = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.12, x, y, r * 1.05);
    sph.addColorStop(0, '#ffffff');
    sph.addColorStop(0.3, p.color);
    sph.addColorStop(0.75, p.color);
    sph.addColorStop(1, '#0a0c1c');
    ctx.fillStyle = sph;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // 表面条纹 + 晨昏线阴影（裁剪在球体内）
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = '#0a0c1c';
    ctx.lineWidth = Math.max(1, r * 0.16);
    const drift = (t * 0.015) % 1;
    for (let i = 0; i < p.bands; i++) {
      const by = y - r + (((i + 0.5 + drift) % p.bands) / p.bands) * r * 2;
      ctx.beginPath();
      ctx.ellipse(x, by, r * 1.1, r * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const sh = ctx.createRadialGradient(x + r * 0.55, y + r * 0.6, r * 0.2, x + r * 0.2, y + r * 0.2, r * 1.55);
    sh.addColorStop(0, 'rgba(4,6,18,0.55)');
    sh.addColorStop(1, 'rgba(4,6,18,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();

    // 环影：环平面横穿球面的暗带（背光侧），土星式立体标志
    if (p.hasRing) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(x, y);
      ctx.rotate(p.ringTilt);
      ctx.strokeStyle = 'rgba(4,6,18,0.42)';
      ctx.lineWidth = r * 0.3;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.95, r * 0.95 * p.ringSquash * 1.08, 0, 0, Math.PI);
      ctx.stroke();
      ctx.restore();
    }

    drawRing(true);
    drawMoons(false);
  }

  private pick(e: MouseEvent): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, h] of this.hit) {
      const d = Math.hypot(x - h.x, y - h.y);
      if (d <= h.r + 6 && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    return best;
  }

  private onClick(e: MouseEvent): void {
    this.opts.onSelect(this.pick(e));
  }

  private onHover(e: MouseEvent): void {
    this.canvas.style.cursor = this.pick(e) ? 'pointer' : 'default';
  }
}
