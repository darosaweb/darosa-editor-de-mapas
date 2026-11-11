// Dados do mapa: altura e bioma de cada coluna de blocos, mais desfazer/refazer.
import { BIOMES, OCEAN, RIVER, PLAINS, FOREST, BEACH } from './biomes.js';

export const MIN_Y = -56;   // abaixo disso fica a camada de bedrock
export const MAX_Y = 300;   // topo do mundo é 320; deixamos folga
const TILE = 32;            // tamanho do bloco usado para guardar o "desfazer"

// ---------- ruído simples (para relevo natural) ----------
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, seed, oct = 4) {
  let s = 0, amp = 1, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) {
    s += valueNoise(x * f, y * f, seed + i * 17) * amp;
    tot += amp; amp *= 0.5; f *= 2;
  }
  return s / tot; // 0..1
}

const clampY = v => (v < MIN_Y ? MIN_Y : v > MAX_Y ? MAX_Y : v);

export class WorldMap {
  constructor(w, h, seaLevel = 63) {
    this.w = w; this.h = h;
    this.seaLevel = seaLevel;
    this.height = new Float32Array(w * h);
    this.biome = new Uint8Array(w * h);
    this.seed = (Math.random() * 1e6) | 0;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = null;     // retângulo que precisa ser redesenhado
    this.version = 0;      // muda a cada alteração (usado pela prévia 3D e pelo autosalvar)
    // marcadores: onde os jogadores nascem e onde ficam as vilas (coordenadas do mapa)
    // cavernas: quantidade de cavernas no subsolo ('nenhuma' | 'poucas' | 'normal' | 'muitas')
    this.markers = { nascer: null, vilas: [], entradas: [], cavernas: 'normal' };
    this.markAll();
  }

  idx(x, y) { return y * this.w + x; }

  markAll() { this.markDirty(0, 0, this.w - 1, this.h - 1); }
  markDirty(x0, y0, x1, y1) {
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
    x1 = Math.min(this.w - 1, x1 + 1); y1 = Math.min(this.h - 1, y1 + 1);
    const d = this.dirty;
    this.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) }
                   : { x0, y0, x1, y1 };
    this.version++;
  }
  takeDirty() { const d = this.dirty; this.dirty = null; return d; }

  // ---------- mapas iniciais ----------
  static create(size, kind, seaLevel = 63) {
    const m = new WorldMap(size, size, seaLevel);
    const s = m.seed, sea = seaLevel;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = m.idx(x, y);
      if (kind === 'oceano') {
        m.height[i] = sea - 14; m.biome[i] = OCEAN;
      } else if (kind === 'planicie') {
        m.height[i] = sea + 4 + fbm(x / 60, y / 60, s, 3) * 4; m.biome[i] = PLAINS;
      } else { // ilha
        const dx = (x - size / 2) / (size / 2), dy = (y - size / 2) / (size / 2);
        const r = Math.sqrt(dx * dx + dy * dy) + (fbm(x / 70, y / 70, s, 4) - 0.5) * 0.6;
        const land = 1 - r / 0.75;                 // >0 = terra
        const hills = fbm(x / 45, y / 45, s + 99, 4);
        let hh = land > 0 ? sea + 1 + land * 18 * (0.4 + hills) : sea + land * 40;
        hh = Math.max(sea - 18, hh);
        m.height[i] = hh;
        if (hh < sea - 1) m.biome[i] = OCEAN;
        else if (hh < sea + 2.5) m.biome[i] = BEACH;
        else m.biome[i] = fbm(x / 50, y / 50, s + 7, 3) > 0.52 ? FOREST : PLAINS;
      }
    }
    m.markAll();
    return m;
  }

  // ---------- desfazer / refazer ----------
  beginStroke() {
    this.stroke = { tiles: new Map() };
  }
  backupRect(x0, y0, x1, y1) {
    const st = this.stroke; if (!st) return;
    const tw = Math.ceil(this.w / TILE);
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++)
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
        const key = ty * tw + tx;
        if (st.tiles.has(key)) continue;
        st.tiles.set(key, this.copyTile(tx, ty));
      }
  }
  copyTile(tx, ty) {
    const x0 = tx * TILE, y0 = ty * TILE;
    const tw = Math.min(TILE, this.w - x0), th = Math.min(TILE, this.h - y0);
    const hh = new Float32Array(tw * th), bb = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) {
      const o = this.idx(x0, y0 + y);
      hh.set(this.height.subarray(o, o + tw), y * tw);
      bb.set(this.biome.subarray(o, o + tw), y * tw);
    }
    return { tx, ty, tw, th, hh, bb };
  }
  restoreTile(t) {
    const cur = this.copyTile(t.tx, t.ty);
    const x0 = t.tx * TILE, y0 = t.ty * TILE;
    for (let y = 0; y < t.th; y++) {
      const o = this.idx(x0, y0 + y);
      this.height.set(t.hh.subarray(y * t.tw, (y + 1) * t.tw), o);
      this.biome.set(t.bb.subarray(y * t.tw, (y + 1) * t.tw), o);
    }
    this.markDirty(x0, y0, x0 + t.tw - 1, y0 + t.th - 1);
    return cur;
  }
  endStroke() {
    const st = this.stroke; this.stroke = null;
    if (!st || st.tiles.size === 0) return false;
    this.undoStack.push([...st.tiles.values()]);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }
  // Uma entrada do desfazer é uma lista de blocos do terreno ou {markers} (marcadores de antes)
  swapEntry(e) {
    if (e.markers) {
      const atual = this.cloneMarkers();
      this.markers = e.markers;
      this.version++;
      return { markers: atual };
    }
    return e.map(t => this.restoreTile(t));
  }
  undo() {
    const e = this.undoStack.pop(); if (!e) return false;
    this.redoStack.push(this.swapEntry(e));
    return true;
  }
  redo() {
    const e = this.redoStack.pop(); if (!e) return false;
    this.undoStack.push(this.swapEntry(e));
    return true;
  }

  // ---------- marcadores ----------
  cloneMarkers() {
    const mk = this.markers;
    return {
      nascer: mk.nascer && { ...mk.nascer },
      vilas: mk.vilas.map(v => ({ ...v })),
      entradas: mk.entradas.map(v => ({ ...v })),
      cavernas: mk.cavernas,
    };
  }
  // muda os marcadores guardando o estado anterior no desfazer
  changeMarkers(fn) {
    const antes = this.cloneMarkers();
    fn(this.markers);
    this.undoStack.push({ markers: antes });
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.version++;
  }
  isWater(x, z) {
    const i = this.idx(Math.floor(x), Math.floor(z));
    return Math.round(this.height[i]) < this.seaLevel || BIOMES[this.biome[i]].agua;
  }
  // ---------- pincéis ----------
  // tool: 'bioma' | 'subir' | 'descer' | 'suavizar' | 'nivelar' | 'montanha' | 'rio'
  // o: { raio, forca (0..1), bioma, magico, alvo }
  applyBrush(tool, cx, cy, o) {
    const r = Math.max(0.5, o.raio);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    if (x0 > x1 || y0 > y1) return;
    this.backupRect(x0, y0, x1, y1);
    const H = this.height, B = this.biome, sea = this.seaLevel, f = o.forca;
    const seed = this.seed;

    let src = null; // cópia local para suavizar
    if (tool === 'suavizar') {
      src = new Float32Array((x1 - x0 + 3) * (y1 - y0 + 3));
    }
    if (src) {
      const sw = x1 - x0 + 3;
      for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
        const cx2 = Math.min(this.w - 1, Math.max(0, x)), cy2 = Math.min(this.h - 1, Math.max(0, y));
        src[(y - y0 + 1) * sw + (x - x0 + 1)] = H[this.idx(cx2, cy2)];
      }
    }

    const bio = o.bioma != null ? BIOMES[o.bioma] : null;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d > 1) continue;
      const t = 1 - d * d, fall = t * t;      // 1 no centro, 0 na borda
      const i = this.idx(x, y);
      switch (tool) {
        case 'bioma': {
          // borda levemente irregular para parecer natural
          const edge = 0.82 + 0.36 * fbm(x / 6, y / 6, seed + 5, 2);
          if (d <= edge || r < 3) B[i] = o.bioma;
          if (o.magico && bio) {
            if (bio.agua) {
              const alvo = sea - bio.profundidade;
              if (H[i] > alvo) H[i] += (alvo - H[i]) * fall * 0.35;
            } else if (bio.rente) {
              // alagadiço: o chão fica em volta do nível da água, com poças
              const alvo = sea - 0.6 + (fbm(x / 9, y / 9, seed + 77, 2) - 0.5) * 4;
              H[i] += (alvo - H[i]) * fall * 0.35;
            } else if (H[i] < sea + 2) {
              H[i] += (sea + 2 - H[i]) * fall * 0.35;
            }
          }
          break;
        }
        case 'subir': H[i] = clampY(H[i] + f * 3 * fall); break;
        case 'descer': H[i] = clampY(H[i] - f * 3 * fall); break;
        case 'nivelar': H[i] += (o.alvo - H[i]) * Math.min(1, f * 0.6 * fall * 2); break;
        case 'suavizar': {
          const sw = x1 - x0 + 3, sx = x - x0 + 1, sy = y - y0 + 1;
          let s = 0;
          for (let k = -1; k <= 1; k++) for (let l = -1; l <= 1; l++) s += src[(sy + k) * sw + sx + l];
          H[i] += (s / 9 - H[i]) * Math.min(1, f * fall * 1.5);
          break;
        }
        case 'montanha': {
          const ridge = 1 - Math.abs(fbm(x / 18, y / 18, seed + 31, 4) * 2 - 1);
          const prof = Math.pow(1 - d, 1.6);
          H[i] = clampY(H[i] + f * 5 * prof * (0.5 + ridge));
          break;
        }
        case 'rio': {
          const leito = sea - 3;
          const core = 0.5 + 0.15 * fbm(x / 5, y / 5, seed + 11, 2);
          if (d < core) {
            H[i] += (Math.min(H[i], leito) - H[i]) * Math.min(1, 0.5 + f);
            B[i] = RIVER;
          } else {
            // margens: desce suavemente até perto da água
            const k = (1 - d) / (1 - core);
            const margem = sea + 1;
            if (H[i] > margem) H[i] += (margem - H[i]) * k * 0.4 * (0.5 + f);
          }
          break;
        }
      }
    }
    this.markDirty(x0, y0, x1, y1);
  }

  // Balde: pinta toda a área conectada que tem o mesmo bioma
  fillBiome(sx, sy, newB) {
    const B = this.biome, w = this.w, h = this.h;
    const old = B[this.idx(sx, sy)];
    if (old === newB) return;
    const seen = new Uint8Array(w * h);
    const stack = [sx, sy];
    let minx = sx, maxx = sx, miny = sy, maxy = sy;
    const cells = [];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      const i = y * w + x;
      if (seen[i] || B[i] !== old) continue;
      seen[i] = 1; cells.push(i);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0) stack.push(x - 1, y);
      if (x < w - 1) stack.push(x + 1, y);
      if (y > 0) stack.push(x, y - 1);
      if (y < h - 1) stack.push(x, y + 1);
    }
    this.backupRect(minx, miny, maxx, maxy);
    for (const i of cells) B[i] = newB;
    this.markDirty(minx, miny, maxx, maxy);
  }

  setSeaLevel(v) {
    this.seaLevel = v;
    this.markAll();
  }

  stats(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = this.idx(x, y);
    return { altura: Math.round(this.height[i]), bioma: BIOMES[this.biome[i]] };
  }
}
