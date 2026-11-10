// Desenho do mapa visto de cima (2D), com zoom e arrasto.
import { BIOME_RGB } from './biomes.js';

// rampa de cores por altura (relativa ao nível do mar)
const RAMP = [
  [-40, [10, 30, 90]], [-1, [40, 110, 200]],
  [0, [215, 205, 140]], [6, [110, 180, 80]], [30, [60, 130, 50]],
  [60, [140, 120, 80]], [100, [130, 130, 130]], [150, [250, 250, 250]],
];
function rampColor(rel) {
  if (rel <= RAMP[0][0]) return RAMP[0][1];
  for (let k = 1; k < RAMP.length; k++) {
    if (rel <= RAMP[k][0]) {
      const [a, ca] = RAMP[k - 1], [b, cb] = RAMP[k];
      const t = (rel - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

export class MapView {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'bioma';       // 'bioma' | 'altura'
    this.relevo = true;        // sombreamento do relevo
    this.grade = false;        // grade de chunks (16x16)
    this.cursor = null;        // {x, y, r} em coordenadas do mapa
    this.setMap(map);
  }

  setMap(map) {
    this.map = map;
    this.off = document.createElement('canvas');
    this.off.width = map.w; this.off.height = map.h;
    this.offCtx = this.off.getContext('2d');
    this.img = this.offCtx.createImageData(map.w, map.h);
    map.markAll();
    this.fit();
  }

  fit() {
    const c = this.canvas, m = this.map;
    const z = Math.min(c.width / m.w, c.height / m.h) * 0.95;
    this.zoom = z;
    this.panX = (c.width - m.w * z) / 2;
    this.panY = (c.height - m.h * z) / 2;
    this.autoFit = true;   // continua ajustando ao mudar o tamanho da janela, até a pessoa mexer no zoom
  }

  // tela -> mapa
  toMap(sx, sy) { return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom }; }

  zoomAt(sx, sy, factor) {
    this.autoFit = false;
    const before = this.toMap(sx, sy);
    this.zoom = Math.min(40, Math.max(0.1, this.zoom * factor));
    this.panX = sx - before.x * this.zoom;
    this.panY = sy - before.y * this.zoom;
  }

  updateImage(full = false) {
    const m = this.map;
    const d = full ? { x0: 0, y0: 0, x1: m.w - 1, y1: m.h - 1 } : m.takeDirty();
    if (full) m.takeDirty();
    if (!d) return false;
    const H = m.height, B = m.biome, w = m.w, h = m.h, px = this.img.data, sea = m.seaLevel;
    for (let y = d.y0; y <= d.y1; y++) for (let x = d.x0; x <= d.x1; x++) {
      const i = y * w + x;
      const hv = H[i];
      let shade = 1;
      if (this.relevo) {
        const l = H[i - (x > 0 ? 1 : 0)], r = H[i + (x < w - 1 ? 1 : 0)];
        const u = H[i - (y > 0 ? w : 0)], dn = H[i + (y < h - 1 ? w : 0)];
        shade = 1 + ((l - r) + (u - dn)) * 0.07;
        shade = shade < 0.55 ? 0.55 : shade > 1.35 ? 1.35 : shade;
      }
      let c;
      if (this.mode === 'altura') {
        c = rampColor(hv - sea);
      } else {
        c = BIOME_RGB[B[i]];
        if (hv < sea - 0.5) {            // debaixo d'água: mistura com azul
          const a = Math.min(0.7, 0.3 + (sea - hv) * 0.03);
          c = [c[0] * (1 - a) + 30 * a, c[1] * (1 - a) + 80 * a, c[2] * (1 - a) + 190 * a];
          shade = 1 + (shade - 1) * 0.3;
        }
      }
      const o = i * 4;
      px[o] = c[0] * shade; px[o + 1] = c[1] * shade; px[o + 2] = c[2] * shade; px[o + 3] = 255;
    }
    this.offCtx.putImageData(this.img, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
    return true;
  }

  draw() {
    const ctx = this.ctx, c = this.canvas, m = this.map, z = this.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fundo-mapa') || '#1b2230';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = z < 1;
    ctx.drawImage(this.off, this.panX, this.panY, m.w * z, m.h * z);

    // contorno do mapa
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panX - 0.5, this.panY - 0.5, m.w * z + 1, m.h * z + 1);

    // grade de chunks
    if (this.grade && z * 16 >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      for (let x = 16; x < m.w; x += 16) { const sx = Math.round(this.panX + x * z) + 0.5; ctx.moveTo(sx, this.panY); ctx.lineTo(sx, this.panY + m.h * z); }
      for (let y = 16; y < m.h; y += 16) { const sy = Math.round(this.panY + y * z) + 0.5; ctx.moveTo(this.panX, sy); ctx.lineTo(this.panX + m.w * z, sy); }
      ctx.stroke();
    }

    // círculo do pincel
    if (this.cursor) {
      const { x, y, r } = this.cursor;
      const sx = this.panX + x * z, sy = this.panY + y * z;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, r * z), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  // imagem PNG do mapa no modo atual (para exportar)
  toPNG(mode) {
    const prev = this.mode; this.mode = mode;
    this.updateImage(true);
    const url = this.off.toDataURL('image/png');
    this.mode = prev; this.updateImage(true);
    return url;
  }
}
