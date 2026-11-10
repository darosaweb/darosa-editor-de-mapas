// Prévia 3D simplificada (técnica "voxel space": desenha o relevo coluna por coluna).
// Leve o bastante para rodar ao vivo enquanto se pinta, sem bibliotecas externas.
import { BIOME_RGB } from './biomes.js';

const SKY_TOP = [120, 175, 235], SKY_BOTTOM = [205, 228, 250];
const pack = (r, g, b) => (255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.angle = Math.PI * 0.25;  // rotação em volta do mapa
    this.dist = 0.75;             // distância (múltiplo do tamanho do mapa)
    this.altura = 0.55;           // altura da câmera (múltiplo da distância)
    this.exagero = 1.5;           // exagero vertical, para o relevo aparecer melhor
    this.builtVersion = -1;
    this.needDraw = true;
    this.lastBuild = 0;
    this.resize();
    this.bindControls();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const W = Math.max(160, Math.round(r.width)), H = Math.max(100, Math.round(r.height));
    // resolução interna menor = mais rápido; o navegador amplia
    const scale = Math.min(1, 520 / W);
    this.canvas.width = Math.round(W * scale);
    this.canvas.height = Math.round(H * scale);
    this.img = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.buf = new Uint32Array(this.img.data.buffer);
    this.ybuf = new Int32Array(this.canvas.width);
    this.needDraw = true;
  }

  bindControls() {
    let drag = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      this.angle -= (e.clientX - drag.x) * 0.01;
      this.altura = Math.min(2.5, Math.max(0.12, this.altura - (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
      this.needDraw = true;
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.dist = Math.min(3, Math.max(0.25, this.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
      this.needDraw = true;
    }, { passive: false });
  }

  // Monta as cores e alturas a partir do mapa (só quando o mapa mudou)
  build(map) {
    const n = map.w * map.h;
    if (!this.col || this.col.length !== n) {
      this.col = new Uint32Array(n);
      this.hgt = new Float32Array(n);
    }
    const H = map.height, B = map.biome, sea = map.seaLevel, w = map.w, h = map.h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hv = H[i];
      let [r, g, b] = BIOME_RGB[B[i]];
      if (hv < sea) {
        const a = Math.min(0.85, 0.45 + (sea - hv) * 0.03);
        r = r * (1 - a) + 35 * a; g = g * (1 - a) + 95 * a; b = b * (1 - a) + 200 * a;
        this.hgt[i] = sea;
      } else {
        const l = H[i - (x > 0 ? 1 : 0)], rr = H[i + (x < w - 1 ? 1 : 0)];
        const u = H[i - (y > 0 ? w : 0)], d = H[i + (y < h - 1 ? w : 0)];
        let s = 1 + ((l - rr) * 0.6 + (u - d) * 0.4) * 0.12;
        s = s < 0.55 ? 0.55 : s > 1.35 ? 1.35 : s;
        r *= s; g *= s; b *= s;
        this.hgt[i] = hv;
      }
      this.col[i] = pack(r | 0, g | 0, b | 0);
    }
    this.builtVersion = map.version;
    this.needDraw = true;
  }

  // Chamado a cada quadro; só redesenha quando precisa
  frame(map, now) {
    const semDados = !this.col || this.col.length !== map.w * map.h;
    if (semDados || (map.version !== this.builtVersion && now - this.lastBuild > 250)) {
      this.lastBuild = now;
      this.build(map);
    }
    const key = this.markersKey(map);
    if (key !== this.lastMarkers) { this.lastMarkers = key; this.needDraw = true; }
    if (!this.needDraw) return;
    this.needDraw = false;
    this.render(map);
  }

  render(map) {
    const W = this.canvas.width, Hs = this.canvas.height, buf = this.buf, ybuf = this.ybuf;
    const size = Math.max(map.w, map.h);
    const sea = map.seaLevel;

    // céu
    for (let y = 0; y < Hs; y++) {
      const t = y / Hs;
      const c = pack(SKY_TOP[0] + (SKY_BOTTOM[0] - SKY_TOP[0]) * t | 0,
                     SKY_TOP[1] + (SKY_BOTTOM[1] - SKY_TOP[1]) * t | 0,
                     SKY_TOP[2] + (SKY_BOTTOM[2] - SKY_TOP[2]) * t | 0);
      buf.fill(c, y * W, (y + 1) * W);
    }
    ybuf.fill(Hs);

    const sin = Math.sin(this.angle), cos = Math.cos(this.angle);
    const D = this.dist * size;
    const px = map.w / 2 + sin * D, py = map.h / 2 + cos * D;   // posição da câmera
    const camH = sea + D * this.altura;
    const horizon = Hs * 0.18;
    const scaleH = (W / 2) * this.exagero;
    const far = D + size * 1.6;
    const oceanCol = pack(35, 95, 200);
    const fogR = SKY_BOTTOM[0], fogG = SKY_BOTTOM[1], fogB = SKY_BOTTOM[2];
    const mw = map.w, mh = map.h, col = this.col, hgt = this.hgt;

    let dz = 1;
    for (let z = 1; z < far; z += dz) {
      let lx = -cos * z - sin * z + px, ly = sin * z - cos * z + py;
      const rx = cos * z - sin * z + px, ry = -sin * z - cos * z + py;
      const ddx = (rx - lx) / W, ddy = (ry - ly) / W;
      const fog = Math.min(1, Math.max(0, (z - D * 0.9) / (far - D * 0.9)));
      const invz = 1 / z;
      for (let i = 0; i < W; i++, lx += ddx, ly += ddy) {
        const mx = lx | 0, my = ly | 0;
        let hv, c;
        if (lx >= 0 && ly >= 0 && mx < mw && my < mh) {
          const k = my * mw + mx; hv = hgt[k]; c = col[k];
        } else { hv = sea; c = oceanCol; }        // fora do desenho: oceano
        let ys = ((camH - hv) * invz * scaleH + horizon) | 0;
        if (ys < 0) ys = 0;
        const yb = ybuf[i];
        if (ys >= yb) continue;
        if (fog > 0) {
          const r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255;
          c = pack(r + (fogR - r) * fog | 0, g + (fogG - g) * fog | 0, b + (fogB - b) * fog | 0);
        }
        for (let y = ys; y < yb; y++) buf[y * W + i] = c;
        ybuf[i] = ys;
      }
      dz += 0.004 * dz + 0.002;
    }
    this.ctx.putImageData(this.img, 0, 0);

    // marcadores (vilas e nascimento) por cima do relevo
    const pins = [...map.markers.entradas.map(v => [v, '🕳️']), ...map.markers.vilas.map(v => [v, '🏘️'])];
    if (map.markers.nascer) pins.push([map.markers.nascer, '🏠']);
    const ctx = this.ctx;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = `${Math.max(12, Math.round(W / 26))}px system-ui, "Segoe UI Emoji", sans-serif`;
    for (const [m, ic] of pins) {
      const dx = m.x - px, dz = m.z - py;
      const depth = dx * -sin + dz * -cos;          // distância para a frente da câmera
      if (depth < 2) continue;
      const side = dx * cos + dz * -sin;            // para a direita
      const sx = (side / depth + 1) * W / 2;
      const i = (m.z | 0) * mw + (m.x | 0);
      const sy = (camH - hgt[i]) / depth * scaleH + horizon;
      if (sx < 0 || sx > W || sy < 0 || sy > Hs) continue;
      ctx.fillText(ic, sx, sy);
    }
  }

  // os marcadores mudam sem mudar o relevo: redesenha quando mudarem
  markersKey(map) {
    const mk = map.markers;
    return JSON.stringify([mk.nascer, mk.vilas, mk.entradas]);
  }
}
