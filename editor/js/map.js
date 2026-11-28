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

// Relevo das terras áridas (badlands): platôs em degraus de 7 blocos e desfiladeiros sinuosos.
// Devolve a altura acima do nível do mar.
export function planaltoBadlands(x, y, seed) {
  let alto = 10 + fbm(x / 70, y / 70, seed + 51, 3) * 60;          // 10 a ~70 acima do mar
  const vale = Math.abs(fbm(x / 55, y / 55, seed + 52, 3) * 2 - 1); // perto de 0 = fundo do desfiladeiro
  if (vale < 0.14) alto = 4 + (alto - 4) * Math.pow(vale / 0.14, 1.5);
  const degrau = 7, base = Math.floor(alto / degrau) * degrau, resto = (alto - base) / degrau;
  const t = resto < 0.8 ? 0 : (resto - 0.8) / 0.2;                  // parede curta entre um platô e outro
  return base + degrau * t * t * (3 - 2 * t);
}

const suaveDegrau = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Profundidade do fundo do mar (positiva), igual para oceano normal, quente e congelado:
// ondulações largas e algumas valas, para não ficar um piso liso nem ter degraus entre os tipos.
export function fundoDoMar(x, y, seed) {
  const base = 10 + fbm(x / 90, y / 90, seed + 71, 3) * 9;
  const vala = Math.abs(fbm(x / 70, y / 70, seed + 72, 3) * 2 - 1);
  return base + (vala < 0.06 ? 6 * (1 - vala / 0.06) : 0);
}

// Relevo de cada bioma: altura em relação ao nível do mar (negativa = debaixo d'água).
// Inspirado no Minecraft normal. null = bioma sem relevo próprio.
export function perfilBioma(id, x, y, seed) {
  const f = (escala, s, oit = 3) => fbm(x / escala, y / escala, seed + s, oit);
  switch (id) {
    case 'minecraft:plains': return 2 + f(80, 101) * 7;
    case 'minecraft:snowy_plains': return 2 + f(90, 102) * 6;
    case 'minecraft:meadow': return 10 + f(60, 103) * 22;
    case 'minecraft:forest':
    case 'minecraft:birch_forest': return 4 + f(55, 104) * 14;
    case 'minecraft:dark_forest': return 4 + f(45, 105) * 12;
    case 'minecraft:dappled_forest': return 5 + f(50, 106) * 16;
    case 'minecraft:pale_garden': return 6 + f(50, 107) * 12;
    case 'minecraft:cherry_grove': return 18 + f(55, 108) * 34;
    case 'minecraft:taiga': return 6 + f(50, 109) * 20;
    case 'minecraft:snowy_taiga': return 8 + f(50, 110) * 22;
    case 'minecraft:jungle': {                                 // morrinhos irregulares
      const crista = 1 - Math.abs(f(35, 111, 4) * 2 - 1);
      return 5 + crista * 26;
    }
    case 'minecraft:desert': {                                 // dunas compridas
      const onda = Math.sin((x * 0.6 + y * 0.8) / 9 + f(60, 112) * 7) * 0.5 + 0.5;
      return 3 + onda * 6 + f(70, 113) * 6;
    }
    case 'minecraft:savanna': {                                // planura com platôs de topo reto
      const plato = suaveDegrau((f(90, 114) - 0.6) / 0.06);
      return 3 + f(80, 115) * 6 + plato * 22;
    }
    case 'minecraft:mushroom_fields': return 3 + f(50, 116) * 9;
    case 'minecraft:stony_peaks': return 70 + f(60, 117) * 90;
    case 'minecraft:beach': return 1 + f(40, 118) * 2;
    case 'minecraft:badlands': return planaltoBadlands(x, y, seed);
    case 'minecraft:swamp':
    case 'minecraft:mangrove_swamp': return -0.6 + (fbm(x / 9, y / 9, seed + 77, 2) - 0.5) * 4;   // alagadiço
    case 'minecraft:river': return -3;                         // leito constante
    case 'minecraft:ocean':
    case 'minecraft:warm_ocean':
    case 'minecraft:frozen_ocean': return -fundoDoMar(x, y, seed);
    default: return null;
  }
}

const clampY = v => (v < MIN_Y ? MIN_Y : v > MAX_Y ? MAX_Y : v);

// Distância (em blocos, aproximada em 8 direções) de cada célula passável até a semente mais próxima.
// Células não passáveis ficam Infinity; acima de max também.
function distancia(W, H, max, passavel, ehSemente) {
  const n = W * H, d = new Float32Array(n).fill(Infinity), D = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    if (ehSemente(x, y, k)) d[k] = 0.5;
  }
  const relaxa = (k, j, c) => { if (d[j] + c < d[k]) d[k] = d[j] + c; };
  for (let volta = 0; volta < 2; volta++) {   // duas idas e vindas bastam para contornar rios e lagos
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x; if (!passavel[k]) continue;
      if (x > 0) relaxa(k, k - 1, 1);
      if (y > 0) { relaxa(k, k - W, 1); if (x > 0) relaxa(k, k - W - 1, D); if (x < W - 1) relaxa(k, k - W + 1, D); }
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const k = y * W + x; if (!passavel[k]) continue;
      if (x < W - 1) relaxa(k, k + 1, 1);
      if (y < H - 1) { relaxa(k, k + W, 1); if (x < W - 1) relaxa(k, k + W + 1, D); if (x > 0) relaxa(k, k + W - 1, D); }
    }
  }
  for (let k = 0; k < n; k++) if (d[k] > max) d[k] = Infinity;
  return d;
}

// Pé de serra: sobe as células baixas até nenhuma ficar mais de s por bloco abaixo de uma vizinha
// (só entre células marcadas em m). Montanha não é rebaixada; ela ganha encostas mais largas.
function pedeSerra(a, m, W, H, s) {
  const D = s * Math.SQRT2;
  const puxa = (k, j, c) => { if (m[j] && a[j] - c > a[k]) a[k] = a[j] - c; };
  for (let volta = 0; volta < 2; volta++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x; if (!m[k]) continue;
      if (x > 0) puxa(k, k - 1, s);
      if (y > 0) { puxa(k, k - W, s); if (x > 0) puxa(k, k - W - 1, D); if (x < W - 1) puxa(k, k - W + 1, D); }
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const k = y * W + x; if (!m[k]) continue;
      if (x < W - 1) puxa(k, k + 1, s);
      if (y < H - 1) { puxa(k, k + W, s); if (x < W - 1) puxa(k, k + W + 1, D); if (x > 0) puxa(k, k + W - 1, D); }
    }
  }
}

// Média numa caixa de raio R contando só as células marcadas em m (as outras não puxam a média).
function borrarTerra(a, m, W, H, R) {
  const tmpS = new Float64Array(W * H), tmpC = new Float64Array(W * H), out = new Float32Array(W * H);
  const linhaS = new Float64Array(Math.max(W, H) + 1), linhaC = new Float64Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) {            // horizontal
    for (let x = 0; x < W; x++) { const k = y * W + x; linhaS[x + 1] = linhaS[x] + (m[k] ? a[k] : 0); linhaC[x + 1] = linhaC[x] + m[k]; }
    for (let x = 0; x < W; x++) {
      const l = Math.max(0, x - R), r = Math.min(W, x + R + 1), k = y * W + x;
      tmpS[k] = linhaS[r] - linhaS[l]; tmpC[k] = linhaC[r] - linhaC[l];
    }
  }
  for (let x = 0; x < W; x++) {            // vertical
    for (let y = 0; y < H; y++) { const k = y * W + x; linhaS[y + 1] = linhaS[y] + tmpS[k]; linhaC[y + 1] = linhaC[y] + tmpC[k]; }
    for (let y = 0; y < H; y++) {
      const t = Math.max(0, y - R), b = Math.min(H, y + R + 1), k = y * W + x;
      const c = linhaC[b] - linhaC[t];
      out[k] = c > 0 ? (linhaS[b] - linhaS[t]) / c : a[k];
    }
  }
  return out;
}

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
    const r = st.rect;   // área mexida no traço todo (para suavizar no fim)
    st.rect = r ? { x0: Math.min(r.x0, x0), y0: Math.min(r.y0, y0), x1: Math.max(r.x1, x1), y1: Math.max(r.y1, y1) }
                : { x0, y0, x1, y1 };
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
    // montanhas são grandes: o pincel de montanha usa o dobro do tamanho escolhido
    const r = Math.max(0.5, tool === 'montanha' ? o.raio * 2 : o.raio);
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
            if (bio.id === 'minecraft:river') {
              // rio: leito na mesma profundidade em todo lugar (rebaixa e também enche buracos, fora do mar fundo)
              const alvo = sea - bio.profundidade;
              if (H[i] > alvo || H[i] > sea - 8) H[i] += (alvo - H[i]) * Math.min(1, fall * 0.8);
            } else {
              const perfil = perfilBioma(bio.id, x, y, seed);
              if (perfil !== null) {
                // cada bioma tem o seu relevo (dunas, colinas, platôs, fundo do mar…);
                // montanhas feitas à mão (bem mais altas que o relevo do bioma) não são achatadas
                const alvo = sea + perfil;
                if (bio.agua || H[i] < alvo + 15) H[i] += (alvo - H[i]) * fall * 0.35;
              } else if (H[i] < sea + 2) {
                H[i] += (sea + 2 - H[i]) * fall * 0.35;
              }
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
          // domo largo e suave (em vez de ponta), com um pouco de relevo de cristas por cima
          const crista = fbm(x / 40, y / 40, seed + 31, 3);
          const prof = fall * (0.8 + 0.4 * crista);
          H[i] = clampY(H[i] + f * 9 * prof);
          break;
        }
        case 'rio': {
          const leito = sea - 3;
          const core = 0.5 + 0.15 * fbm(x / 5, y / 5, seed + 11, 2);
          if (d < core) {
            // leito sempre na mesma profundidade: rebaixa o alto e enche os buracos (menos no mar fundo)
            if (H[i] > leito || H[i] > sea - 8) H[i] += (leito - H[i]) * Math.min(1, 0.5 + f);
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

  // Balde: pinta toda a área conectada que tem o mesmo bioma.
  // Com "relevo automático" (magico), a área ganha o relevo do bioma novo, igual ao pincel,
  // chegando aos poucos perto da borda para não fazer degrau com os vizinhos.
  fillBiome(sx, sy, newB, magico = false) {
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
    if (magico) {
      this.reliefFill(cells, newB);
      this.suavizarTransicoes(minx, miny, maxx, maxy);   // a passagem para os vizinhos fica suave
    }
    this.markDirty(minx, miny, maxx, maxy);
  }

  // relevo do bioma numa área inteira (cells); a passagem para os vizinhos é feita por suavizarTransicoes
  reliefFill(cells, b) {
    const H = this.height, w = this.w, sea = this.seaLevel, seed = this.seed;
    const bio = BIOMES[b];
    for (const i of cells) {
      const x = i % w, y = (i / w) | 0;
      if (bio.id === 'minecraft:river') {
        const alvo = sea - bio.profundidade;
        if (H[i] > alvo || H[i] > sea - 8) H[i] = alvo;
      } else {
        const perfil = perfilBioma(bio.id, x, y, seed);
        if (perfil !== null) {
          const alvo = sea + perfil;
          if (bio.agua || H[i] < alvo + 15) H[i] = alvo;   // montanhas feitas à mão ficam
        } else if (H[i] < sea + 2) {
          H[i] = sea + 2;
        }
      }
    }
  }

  // Deixa o terreno andável perto do retângulo (x0..x1, y0..y1):
  //  1. na divisa entre dois biomas de terra, rampa suave em vez de parede (ou de valeta);
  //  2. nenhuma subida mais íngreme que INCLINACAO blocos por bloco: as montanhas ganham "pé de serra"
  //     (no gerador, encosta de 4+ blocos vira parede de pedra);
  //  3. perto dos rios, a terra desce em vale até a água, sem parar de repente;
  //  4. o leito do rio é raso na beira e mais fundo no meio.
  // Oceano não entra na conta (a costa já tem o seu próprio ajuste). Terras áridas ficam com os seus degraus.
  suavizarTransicoes(x0 = 0, y0 = 0, x1 = this.w - 1, y1 = this.h - 1) {
    const R = 12;              // raio do borrão (2 passadas => rampa de até ~48 blocos)
    const FAIXA = 2 * R;       // até onde a divisa mexe no terreno
    const INCLINACAO = 2;      // subida máxima por bloco
    const E = 150;             // até onde uma mudança no retângulo pode chegar (pé de serra de montanha bem alta, vale)
    const BEIRA = 16;          // perto do fim dessa área a mudança vai sumindo (sem degrau com o resto)
    const M = E + 2 * R + 2;   // + o que o borrão precisa ler
    const bx0 = Math.max(0, x0 - M), by0 = Math.max(0, y0 - M);
    const bx1 = Math.min(this.w - 1, x1 + M), by1 = Math.min(this.h - 1, y1 + M);
    const W = bx1 - bx0 + 1, Hh = by1 - by0 + 1, n = W * Hh;
    const H = this.height, B = this.biome, sea = this.seaLevel;
    const RIO = RIVER, PROF_RIO = BIOMES[RIVER].profundidade;
    const terra = new Uint8Array(n), alt = new Float32Array(n), bio = new Uint8Array(n);
    const rio = new Uint8Array(n), serra = new Uint8Array(n);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const g = this.idx(bx0 + x, by0 + y), k = y * W + x, b = BIOMES[B[g]];
      bio[k] = B[g]; alt[k] = H[g]; terra[k] = b.agua ? 0 : 1; rio[k] = B[g] === RIO ? 1 : 0;
      serra[k] = terra[k] && b.id !== 'minecraft:badlands' ? 1 : 0;
    }
    const dentro = (x, y) => x + bx0 >= x0 - 1 && x + bx0 <= x1 + 1 && y + by0 >= y0 - 1 && y + by0 <= y1 + 1;
    const beiraAgua = (x, y, k, m) => (x > 0 && m[k - 1]) || (x < W - 1 && m[k + 1]) || (y > 0 && m[k - W]) || (y < Hh - 1 && m[k + W]);
    const agua = terra.map(t => 1 - t);

    // ---- 1. divisas entre biomas de terra
    const dDiv = distancia(W, Hh, FAIXA, terra, (x, y, k) => {
      if (!terra[k] || !dentro(x, y)) return false;
      const b = bio[k];
      return (x > 0 && terra[k - 1] && bio[k - 1] !== b) || (x < W - 1 && terra[k + 1] && bio[k + 1] !== b) ||
             (y > 0 && terra[k - W] && bio[k - W] !== b) || (y < Hh - 1 && terra[k + W] && bio[k + W] !== b);
    });
    // borrão: a água conta como a superfície do mar (a costa não vira paredão nem afunda o fundo do mar)
    const sup = new Float32Array(n), todos = new Uint8Array(n).fill(1);
    for (let k = 0; k < n; k++) sup[k] = terra[k] ? alt[k] : sea;
    const liso = borrarTerra(borrarTerra(sup, todos, W, Hh, R), todos, W, Hh, R);
    const COSTA = 8;           // bem na beira da água a costa fica como está (senão vira degrau com o fundo)
    const dAgua = distancia(W, Hh, COSTA, terra, (x, y, k) => terra[k] && beiraAgua(x, y, k, agua));
    for (let k = 0; k < n; k++) {
      if (!terra[k] || dDiv[k] > FAIXA) continue;
      const t = dDiv[k] / FAIXA, c = Math.min(1, dAgua[k] / COSTA);
      const peso = (1 - t * t * (3 - 2 * t)) * c * c * (3 - 2 * c);
      let novo = alt[k] + (liso[k] - alt[k]) * peso;
      const piso = Math.min(alt[k], sea + 1);   // terra não afunda abaixo da água por causa do borrão
      if (novo < piso) novo = piso;
      alt[k] = novo;
    }

    // ---- 2. pé de serra: o lado baixo sobe até a encosta ficar com no máximo INCLINACAO por bloco
    pedeSerra(alt, serra, W, Hh, INCLINACAO);

    // ---- 3. vales dos rios: suave perto da água, depois sobe INCLINACAO por bloco até encontrar o terreno
    const dRio = distancia(W, Hh, 1e9, terra, (x, y, k) => terra[k] && beiraAgua(x, y, k, rio));
    const dVira = (INCLINACAO - 0.5) / 0.04;                    // onde a curva chega na inclinação máxima
    const tVira = 1 + dVira * 0.5 + dVira * dVira * 0.02;
    for (let k = 0; k < n; k++) {
      if (!terra[k] || dRio[k] === Infinity) continue;
      const d = dRio[k];
      const teto = sea + (d < dVira ? 1 + d * 0.5 + d * d * 0.02 : tVira + (d - dVira) * INCLINACAO);
      if (alt[k] > teto) alt[k] = teto;
    }

    // ---- 4. leito do rio: 1 bloco de fundura na beira, 2 no seguinte, depois a fundura normal
    const dBeira = distancia(W, Hh, PROF_RIO + 1, rio, (x, y, k) => rio[k] && beiraAgua(x, y, k, terra));
    for (let k = 0; k < n; k++) {
      if (!rio[k] || alt[k] <= sea - 8) continue;               // onde já desemboca em mar fundo, fica
      alt[k] = sea - Math.min(PROF_RIO, dBeira[k] + 0.5);
    }

    // grava, sumindo aos poucos perto do fim da área (a beira do mapa não conta)
    const lx0 = x0 - E, lx1 = x1 + E, ly0 = y0 - E, ly1 = y1 + E;
    let mx0 = Infinity, my0 = Infinity, mx1 = -1, my1 = -1;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const gx = bx0 + x, gy = by0 + y, k = y * W + x, g = this.idx(gx, gy);
      if ((!terra[k] && !rio[k]) || Math.abs(alt[k] - H[g]) < 0.01) continue;
      if (gx < lx0 || gx > lx1 || gy < ly0 || gy > ly1) continue;
      let db = Infinity;
      if (lx0 > 0) db = Math.min(db, gx - lx0);
      if (ly0 > 0) db = Math.min(db, gy - ly0);
      if (lx1 < this.w - 1) db = Math.min(db, lx1 - gx);
      if (ly1 < this.h - 1) db = Math.min(db, ly1 - gy);
      const t = Math.min(1, db / BEIRA), fade = t * t * (3 - 2 * t);
      if (mx0 === Infinity) this.backupRect(bx0, by0, bx1, by1);
      H[g] += (alt[k] - H[g]) * fade;
      mx0 = Math.min(mx0, gx); mx1 = Math.max(mx1, gx);
      my0 = Math.min(my0, gy); my1 = Math.max(my1, gy);
    }
    if (mx1 >= 0) this.markDirty(mx0, my0, mx1, my1);
    return mx1 >= 0;
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
