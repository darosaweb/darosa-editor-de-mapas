// "📷 Importar desenho": transforma a foto de um mapa desenhado no papel num mapa do editor.
// 1) foto  2) ajustar os 4 cantos da folha  3) cada cor vira um bioma  4) relevo automático.
// Tudo roda no navegador; a foto não sai do aparelho.
import { BIOMES, BIOME_INDEX } from './biomes.js';
import { WorldMap, fbm } from './map.js';

const IGNORAR = -1;      // contornos, letras, sombras: viram o bioma vizinho
const MONTANHA = -2;     // vira montanha (o bioma é o que estiver em volta)
const MAX_FOTO = 1600;   // a foto é reduzida para no máximo isso (lado maior) antes de tudo

const $ = id => document.getElementById(id);
const B = id => BIOME_INDEX['minecraft:' + id];

// ---------------------------------------------------------------- cores
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const LIN = new Float32Array(256).map((_, i) => srgbToLin(i));
function rgbToLab(r, g, b) {
  const R = LIN[r | 0], G = LIN[g | 0], Bb = LIN[b | 0];
  let x = (R * 0.4124 + G * 0.3576 + Bb * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + Bb * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + Bb * 0.9505) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

// Palpite de bioma para uma cor de lápis de cor (a criança pode trocar)
// (regras ajustadas com fotos reais de lápis de cor, já com o balanço de branco)
function sugerir([r, g, b]) {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (l < 0.22) return IGNORAR;                                    // contorno preto
  if (s < 0.2) {
    if (l > 0.7) return B('snowy_plains');                         // papel branco = neve
    if (l > 0.62) return MONTANHA;                                  // cinza-claro = montanha
    return B('pale_garden');                                        // cinza-escuro = jardim pálido
  }
  if (h >= 160 && h < 260) {                                        // azuis
    if (l > 0.74) return B('ocean');                                // azul-clarinho do fundo = mar
    if (h < 205 && s > 0.45 && l > 0.55) return B('frozen_ocean');  // ciano = mar congelado
    if (l < 0.5) return B('warm_ocean');                            // azul-escuro forte
    if (s > 0.45) return B('river');                                // azul forte = rio
    return B('ocean');
  }
  if (h >= 70 && h < 160) {                                         // verdes
    if (h < 100 && s > 0.5) return B('plains');                     // verde-amarelado = pradaria
    if (l > 0.78) return B('forest');                               // verde-clarinho
    if (l > 0.6) return B('jungle');
    return B('taiga');                                              // verde-escuro
  }
  if (h >= 40 && h < 70) return s > 0.7 ? B('desert') : B('savanna');            // amarelos
  if (h >= 18 && h < 40) return s > 0.6 ? B('dappled_forest') : B('dark_forest'); // laranja (outono) / marrom
  if (h >= 260 || h < 18) {
    if (s < 0.45) return B('dark_forest');                          // marrom (fica rosado na foto)
    return l > 0.66 ? B('cherry_grove') : B('mushroom_fields');     // rosa-claro / vermelho
  }
  return B('plains');
}

// ---------------------------------------------------------------- geometria
// leva o quadrado (0..1, 0..1) até o quadrilátero p (cantos: sup-esq, sup-dir, inf-dir, inf-esq)
function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}

// recorta e "endireita" a folha: devolve RGB (Float32, W*H*3)
function warp(src, quad, W, H) {
  const T = squareToQuad(quad), sw = src.width, sh = src.height, s = src.data;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let [fx, fy] = T((x + 0.5) / W, (y + 0.5) / H);
    fx = Math.min(sw - 1.001, Math.max(0, fx - 0.5)); fy = Math.min(sh - 1.001, Math.max(0, fy - 0.5));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const i00 = (iy * sw + ix) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
    const o = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) {
      out[o + k] = (s[i00 + k] * (1 - tx) + s[i10 + k] * tx) * (1 - ty) + (s[i01 + k] * (1 - tx) + s[i11 + k] * tx) * ty;
    }
  }
  return out;
}

// desfoque em caixa (suaviza a textura do lápis)
function boxBlur(rgb, W, H, r) {
  const tmp = new Float32Array(rgb.length);
  const pass = (a, b, horiz) => {
    const n = horiz ? W : H, m = horiz ? H : W;
    for (let j = 0; j < m; j++) for (let k = 0; k < 3; k++) {
      let acc = 0, cnt = 0;
      const at = i => ((horiz ? j * W + i : i * W + j) * 3 + k);
      for (let i = 0; i < Math.min(r, n); i++) { acc += a[at(i)]; cnt++; }
      for (let i = 0; i < n; i++) {
        if (i + r < n) { acc += a[at(i + r)]; cnt++; }
        if (i - r - 1 >= 0) { acc -= a[at(i - r - 1)]; cnt--; }
        b[at(i)] = acc / cnt;
      }
    }
  };
  pass(rgb, tmp, true); pass(tmp, rgb, false);
}

// Balanço de branco: o papel (os pixels mais claros) vira branco de verdade, tirando a cor da luz da foto
function balancoDeBranco(rgb, n) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) hist[k][Math.min(255, rgb[i * 3 + k] | 0)]++;
  const pct = (h, p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= p * n) return Math.max(1, v); } return 255; };
  const branco = hist.map(h => pct(h, 0.985));
  const preto = hist.map(h => pct(h, 0.01));
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const v = (rgb[i * 3 + k] - preto[k]) * 255 / Math.max(1, branco[k] - preto[k]);
    rgb[i * 3 + k] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

// ---------------------------------------------------------------- agrupar cores (k-means em Lab)
const PESO_COR = 2.4;    // lápis de cor diferem mais na cor (a, b) do que no claro/escuro (L)
function agrupar(rgb, W, H, k = 28) {
  const n = W * H;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [L, A, Bv] = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    lab[i * 3] = L; lab[i * 3 + 1] = A * PESO_COR; lab[i * 3 + 2] = Bv * PESO_COR;
  }
  // amostra
  const S = Math.min(n, 24000), amostra = new Int32Array(S);
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < S; i++) amostra[i] = (rnd() * n) | 0;
  const d2 = (i, c) => { const a = lab[i * 3] - c[0], b = lab[i * 3 + 1] - c[1], e = lab[i * 3 + 2] - c[2]; return a * a + b * b + e * e; };
  // k-means++
  const cent = [[...lab.subarray(amostra[0] * 3, amostra[0] * 3 + 3)]];
  const dist = new Float32Array(S).fill(Infinity);
  while (cent.length < k) {
    let tot = 0;
    for (let s = 0; s < S; s++) { dist[s] = Math.min(dist[s], d2(amostra[s], cent[cent.length - 1])); tot += dist[s]; }
    let r = rnd() * tot, s = 0;
    while (s < S - 1 && (r -= dist[s]) > 0) s++;
    cent.push([...lab.subarray(amostra[s] * 3, amostra[s] * 3 + 3)]);
  }
  for (let it = 0; it < 15; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (let s = 0; s < S; s++) {
      const i = amostra[s]; let best = 0, bd = Infinity;
      for (let c = 0; c < cent.length; c++) { const v = d2(i, cent[c]); if (v < bd) { bd = v; best = c; } }
      const a = acc[best]; a[0] += lab[i * 3]; a[1] += lab[i * 3 + 1]; a[2] += lab[i * 3 + 2]; a[3]++;
    }
    acc.forEach((a, c) => { if (a[3]) cent[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  // junta grupos muito parecidos
  for (let a = 0; a < cent.length; a++) for (let b = cent.length - 1; b > a; b--) {
    const dd = Math.hypot(cent[a][0] - cent[b][0], cent[a][1] - cent[b][1], cent[a][2] - cent[b][2]);
    if (dd < 11) { cent[a] = cent[a].map((v, i) => (v + cent[b][i]) / 2); cent.splice(b, 1); }
  }
  // rotula todos os pixels
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < cent.length; c++) { const v = d2(i, cent[c]); if (v < bd) { bd = v; best = c; } }
    labels[i] = best;
  }
  return { labels, k: cent.length };
}

// filtro de maioria 3x3 (tira pontinhos soltos)
function maioria(labels, W, H, k, vezes = 2) {
  let a = labels, b = new Uint8Array(labels.length);
  const cnt = new Uint16Array(k);
  for (let t = 0; t < vezes; t++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      cnt.fill(0);
      let best = a[y * W + x], bc = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
        const l = a[yy * W + xx], c = ++cnt[l];
        if (c > bc) { bc = c; best = l; }
      }
      b[y * W + x] = bc >= 5 ? best : a[y * W + x];
    }
    [a, b] = [b, a];
  }
  return a;
}

// Apaga o que é fino (contornos, letras, rabiscos): um pixel só fica se a cor dele ocupa boa parte
// da vizinhança; o resto é preenchido pela cor "de verdade" mais próxima.
function tirarFinos(labels, W, H, raio) {
  const n = W * H, out = new Uint8Array(labels);
  const lado = 2 * raio + 1, minimo = Math.ceil(lado * lado * 0.45);
  const duvida = new Uint8Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = labels[i];
    let c = 0;
    for (let dy = -raio; dy <= raio; dy++) {
      const yy = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
      for (let dx = -raio; dx <= raio; dx++) {
        const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx;
        if (labels[yy * W + xx] === l) c++;
      }
    }
    if (c < minimo) duvida[i] = 1;
  }
  const { dono } = bfs(W, H, i => !duvida[i]);
  for (let i = 0; i < n; i++) if (duvida[i] && dono[i] >= 0) out[i] = labels[dono[i]];
  return out;
}

// distância (em passos) até o pixel mais próximo onde semente[i] é verdadeiro; também devolve quem é o mais próximo
function bfs(W, H, semente, limite = 1e9) {
  const n = W * H, dist = new Float32Array(n).fill(limite), dono = new Int32Array(n).fill(-1);
  const fila = new Int32Array(n);
  let ini = 0, fim = 0;
  for (let i = 0; i < n; i++) if (semente(i)) { dist[i] = 0; dono[i] = i; fila[fim++] = i; }
  while (ini < fim) {
    const i = fila[ini++], x = i % W, y = (i / W) | 0, d = dist[i] + 1;
    if (d > limite) continue;
    const viz = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of viz) if (j >= 0 && dist[j] > d) { dist[j] = d; dono[j] = dono[i]; fila[fim++] = j; }
  }
  return { dist, dono };
}

// ---------------------------------------------------------------- montar o mapa
function montarMapa(st, opcoes) {
  const { W, H, labels } = st;
  const n = W * H, sea = 63;
  const cls = new Int16Array(n);
  for (let i = 0; i < n; i++) cls[i] = st.escolha[labels[i]];
  const montanha = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (cls[i] === MONTANHA) montanha[i] = 1;

  // papel em branco encostado na borda da folha (margem, legenda) vira mar
  if (opcoes.bordaMar) {
    const papel = new Uint8Array(st.cores.length);
    st.cores.forEach(c => { const [, s, l] = rgbToHsl(...c.rgb); if (s < 0.2 && l > 0.7) papel[c.i] = 1; });
    const ehPapel = i => papel[labels[i]] || cls[i] === IGNORAR;
    const fila = [], visto = new Uint8Array(n);
    for (let x = 0; x < W; x++) fila.push(x, (H - 1) * W + x);
    for (let y = 0; y < H; y++) fila.push(y * W, y * W + W - 1);
    const oceano = B('ocean');
    while (fila.length) {
      const i = fila.pop();
      if (visto[i] || !ehPapel(i)) continue;
      visto[i] = 1;
      cls[i] = oceano; montanha[i] = 0;
      const x = i % W;
      if (x > 0) fila.push(i - 1);
      if (x < W - 1) fila.push(i + 1);
      if (i >= W) fila.push(i - W);
      if (i < n - W) fila.push(i + W);
    }
  }

  // contornos e montanhas recebem o bioma de verdade mais próximo
  const { dono } = bfs(W, H, i => cls[i] >= 0);
  const bio = new Uint8Array(n);
  const padrao = B('plains');
  for (let i = 0; i < n; i++) bio[i] = cls[i] >= 0 ? cls[i] : (dono[i] >= 0 ? cls[dono[i]] : padrao);

  const agua = i => BIOMES[bio[i]].agua;
  const isOceano = i => agua(i) && bio[i] !== B('river');
  const dAgua = bfs(W, H, agua, 40).dist;           // distância até a água (na terra)
  const dTerra = bfs(W, H, i => !agua(i), 40).dist;  // distância até a terra (na água)

  // praias onde a terra encosta no oceano
  if (opcoes.praias) {
    const dOceano = bfs(W, H, isOceano, 4).dist;
    const semPraia = new Set(['minecraft:desert', 'minecraft:badlands', 'minecraft:snowy_plains', 'minecraft:snowy_taiga',
      'minecraft:stony_peaks', 'minecraft:mushroom_fields', 'minecraft:swamp', 'minecraft:mangrove_swamp']);
    for (let i = 0; i < n; i++) if (!agua(i) && !montanha[i] && dOceano[i] <= 3 && !semPraia.has(BIOMES[bio[i]].id)) bio[i] = B('beach');
  }

  const m = new WorldMap(W, H, sea);
  const seed = m.seed;
  const dentro = bfs(W, H, i => !montanha[i], 200).dist;   // quão "para dentro" da montanha
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let h;
    if (agua(i)) {
      const prof = BIOMES[bio[i]].profundidade || 10;
      h = sea - Math.min(prof, 1 + dTerra[i] * 0.7);
    } else if (BIOMES[bio[i]].rente && !montanha[i]) {
      // pântano / manguezal: no nível da água, com poças
      h = sea - 0.6 + (fbm(x / 9, y / 9, seed + 77, 2) - 0.5) * 4;
    } else {
      const d = Math.min(dAgua[i], 24);
      h = sea + 1 + d * 0.45 + (fbm(x / 40, y / 40, seed, 4) - 0.5) * 10 * Math.min(1, d / 8);
      if (montanha[i]) {
        const ridge = 1 - Math.abs(fbm(x / 22, y / 22, seed + 31, 4) * 2 - 1);
        h += 10 + Math.min(dentro[i], 60) * 2.2 * (0.55 + ridge * 0.9);
      }
    }
    m.height[i] = Math.min(240, h);
    m.biome[i] = bio[i];
  }
  // suaviza o relevo sem deixar terra afundar nem água subir
  for (let pass = 0; pass < 2; pass++) {
    const src = Float32Array.from(m.height);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[i + dy * W + dx];
      let v = s / 9;
      if (agua(i)) v = Math.min(v, sea - 1);
      else if (!BIOMES[bio[i]].rente) v = Math.max(v, sea);
      m.height[i] = v;
    }
  }
  m.markAll();
  return m;
}

// ---------------------------------------------------------------- interface
export function abrirImportar(onCriar, avisar) {
  const dlg = $('dlgImportar');
  const st = { img: null, quad: null, escolha: [], cores: [] };
  const passo = n => {
    dlg.querySelectorAll('[data-passo]').forEach(e => { e.hidden = +e.dataset.passo !== n; });
    st.passo = n;
  };
  passo(1);
  $('impArquivo').value = '';
  dlg.showModal();

  $('impArquivo').onchange = async () => {
    const f = $('impArquivo').files[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const k = Math.min(1, MAX_FOTO / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      st.img = c;
      st.src = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      st.nome = f.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'desenho';
      st.quad = acharFolha(st.src);
      passo(2);
      desenharCantos();
    } catch (err) { avisar('Não consegui abrir essa imagem: ' + err.message); }
  };

  // ---- passo 2: cantos
  const cv = $('impCantos'), ctx = cv.getContext('2d');
  let arrastando = -1;
  const escala = () => {
    const r = cv.getBoundingClientRect();
    return { k: Math.min(r.width / st.img.width, r.height / st.img.height), r };
  };
  function desenharCantos() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const k = Math.min(r.width / st.img.width, r.height / st.img.height) * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(st.img, 0, 0, st.img.width * k, st.img.height * k);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.rect(0, 0, cv.width, cv.height);
    st.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#cc3467'; ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    st.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath(); ctx.stroke();
    for (const [x, y] of st.quad) {
      ctx.beginPath(); ctx.arc(x * k, y * k, 11 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    }
  }
  cv.onpointerdown = e => {
    const { k, r } = escala();
    const px = (e.clientX - r.left) / k, py = (e.clientY - r.top) / k;
    let best = -1, bd = 40 / k;
    st.quad.forEach(([x, y], i) => { const d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = i; } });
    arrastando = best;
    if (best >= 0) cv.setPointerCapture(e.pointerId);
  };
  cv.onpointermove = e => {
    if (arrastando < 0) return;
    const { k, r } = escala();
    st.quad[arrastando] = [
      Math.min(st.img.width, Math.max(0, (e.clientX - r.left) / k)),
      Math.min(st.img.height, Math.max(0, (e.clientY - r.top) / k)),
    ];
    desenharCantos();
  };
  cv.onpointerup = () => { arrastando = -1; };
  $('impCantosReset').onclick = () => { st.quad = acharFolha(st.src); desenharCantos(); };
  $('impCantosTudo').onclick = () => {
    const w = st.img.width, h = st.img.height;
    st.quad = [[0, 0], [w, 0], [w, h], [0, h]]; desenharCantos();
  };

  // ---- passo 3: cores -> biomas
  $('impProximo').onclick = async () => {
    const lado = +$('impTamanho').value;
    const q = st.quad, L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const largura = (L(q[0], q[1]) + L(q[3], q[2])) / 2, altura = (L(q[0], q[3]) + L(q[1], q[2])) / 2;
    const r16 = v => Math.max(64, Math.round(v / 16) * 16);
    st.W = r16(largura >= altura ? lado : lado * largura / altura);
    st.H = r16(altura >= largura ? lado : lado * altura / largura);
    $('impProcessando').hidden = false;
    await new Promise(r => setTimeout(r, 30));       // deixa a tela mostrar "processando"
    const rgb = warp(st.src, st.quad, st.W, st.H);
    balancoDeBranco(rgb, st.W * st.H);
    boxBlur(rgb, st.W, st.H, Math.max(1, Math.round(st.W / 300)));
    boxBlur(rgb, st.W, st.H, Math.max(1, Math.round(st.W / 300)));
    const { labels, k } = agrupar(rgb, st.W, st.H);
    st.labels = tirarFinos(maioria(labels, st.W, st.H, k, 2), st.W, st.H, Math.max(2, Math.round(st.W / 170)));
    // média de cor e tamanho de cada grupo
    const soma = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < st.labels.length; i++) {
      const s = soma[st.labels[i]]; s[0] += rgb[i * 3]; s[1] += rgb[i * 3 + 1]; s[2] += rgb[i * 3 + 2]; s[3]++;
    }
    st.cores = soma.map((s, i) => ({ i, rgb: s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [0, 0, 0], frac: s[3] / st.labels.length }));
    st.escolha = st.cores.map(c => (c.frac < 0.003 ? IGNORAR : sugerir(c.rgb)));
    $('impProcessando').hidden = true;
    passo(3);
    listarCores();
    preview();
  };

  function opcoesBioma(sel) {
    const ops = [`<option value="${IGNORAR}">✖ Ignorar (contorno, letras)</option>`,
      `<option value="${MONTANHA}">⛰️ Montanha (relevo alto)</option>`,
      ...BIOMES.map((b, i) => `<option value="${i}">${b.emoji} ${b.nome}</option>`)];
    return ops.join('').replace(`value="${sel}"`, `value="${sel}" selected`);
  }
  function listarCores() {
    const box = $('impCores');
    box.innerHTML = '';
    const ordem = [...st.cores].filter(c => c.frac > 0).sort((a, b) => b.frac - a.frac);
    const pequenas = ordem.filter(c => c.frac < 0.01);
    let destino = box;
    for (const c of ordem) {
      if (c.frac < 0.01 && destino === box) {           // cores pequenas ficam numa seção recolhida
        const det = document.createElement('details');
        det.className = 'imp-pequenas';
        det.innerHTML = `<summary>Cores pequenas (${pequenas.length})</summary>`;
        box.appendChild(det);
        destino = det;
      }
      const hex = '#' + c.rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
      const row = document.createElement('label');
      row.className = 'imp-cor';
      row.innerHTML = `<span class="amostra" style="background:${hex}"></span>
        <small>${(c.frac * 100).toFixed(c.frac < 0.01 ? 1 : 0)}%</small>
        <select>${opcoesBioma(st.escolha[c.i])}</select>`;
      row.querySelector('select').onchange = e => { st.escolha[c.i] = +e.target.value; preview(); };
      row.onmouseenter = () => preview(c.i);
      row.onmouseleave = () => preview();
      destino.appendChild(row);
    }
  }
  // prévia: cada pixel na cor do bioma escolhido (destaca um grupo ao passar o mouse)
  function preview(destaque = -1) {
    const pv = $('impPrevia'), W = st.W, H = st.H;
    pv.width = W; pv.height = H;
    const p = pv.getContext('2d'), img = p.createImageData(W, H), d = img.data;
    const cor = st.escolha.map(e => {
      if (e === IGNORAR) return [30, 30, 30];
      if (e === MONTANHA) return [150, 150, 150];
      const n = parseInt(BIOMES[e].cor.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
    for (let i = 0; i < st.labels.length; i++) {
      const l = st.labels[i];
      let c = cor[l];
      if (destaque >= 0 && l !== destaque) c = [c[0] * 0.35, c[1] * 0.35, c[2] * 0.35];
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
    }
    p.putImageData(img, 0, 0);
  }

  $('impVoltar1').onclick = () => passo(1);
  $('impVoltar2').onclick = () => { passo(2); desenharCantos(); };
  $('impCriar').onclick = async () => {
    $('impProcessando').hidden = false;
    await new Promise(r => setTimeout(r, 30));
    try {
      const m = montarMapa(st, { praias: $('impPraias').checked, bordaMar: $('impBordaMar').checked });
      dlg.close();
      await onCriar(m, st.nome);
    } catch (err) {
      avisar('Não consegui montar o mapa: ' + err.message);
    } finally { $('impProcessando').hidden = true; }
  };
  $('impFechar').onclick = () => dlg.close();
}

// Acha a folha na foto: os pixels claros, e os 4 pontos mais "de canto" deles
function acharFolha(src) {
  const { width: w, height: h, data } = src;
  const passo = Math.max(1, Math.round(Math.max(w, h) / 300));
  let soma = 0, cnt = 0;
  for (let y = 0; y < h; y += passo) for (let x = 0; x < w; x += passo) {
    const o = (y * w + x) * 4; soma += data[o] + data[o + 1] + data[o + 2]; cnt++;
  }
  const limiar = Math.max(330, (soma / cnt) * 1.05);
  let tl = null, tr = null, br = null, bl = null;
  for (let y = 0; y < h; y += passo) for (let x = 0; x < w; x += passo) {
    const o = (y * w + x) * 4;
    if (data[o] + data[o + 1] + data[o + 2] < limiar) continue;
    if (!tl || x + y < tl[0] + tl[1]) tl = [x, y];
    if (!br || x + y > br[0] + br[1]) br = [x, y];
    if (!tr || x - y > tr[0] - tr[1]) tr = [x, y];
    if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
  }
  if (!tl) return [[0, 0], [w, 0], [w, h], [0, h]];
  return [tl, tr, br, bl];
}

export const _teste = { sugerir, squareToQuad, acharFolha, montarMapa, agrupar, warp, maioria, balancoDeBranco, boxBlur, rgbToHsl, tirarFinos };
