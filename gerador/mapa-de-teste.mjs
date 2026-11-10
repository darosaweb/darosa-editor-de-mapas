// Cria um mapa de teste 256x256 usando o MESMO código do editor (map.js / storage.js),
// para garantir que o gerador lê exatamente o que o editor salva.
// Uso: node gerador/mapa-de-teste.mjs saida.mcmapa
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { WorldMap } from '../editor/js/map.js';
import { BIOME_INDEX } from '../editor/js/biomes.js';
import { serialize } from '../editor/js/storage.js';

const out = process.argv[2] || 'teste.mcmapa';
const m = WorldMap.create(256, 'ilha');
m.seed = 12345;
const B = id => BIOME_INDEX['minecraft:' + id];
const paint = (tool, pts, o) => {
  m.beginStroke();
  for (const [x, y] of pts) m.applyBrush(tool, x, y, { raio: 10, forca: 0.6, magico: true, ...o });
  m.endStroke();
};
const line = (x0, y0, x1, y1, n = 40) => Array.from({ length: n + 1 }, (_, k) => [x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
const blob = (cx, cy, r) => { const p = []; for (let a = 0; a < 6.28; a += 0.3) for (let rr = 0; rr <= r; rr += 6) p.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); return p; };

paint('bioma', blob(85, 85, 30), { bioma: B('desert'), raio: 12 });
paint('bioma', blob(170, 80, 28), { bioma: B('snowy_taiga'), raio: 12 });
paint('bioma', blob(85, 170, 26), { bioma: B('cherry_grove'), raio: 12 });
paint('bioma', blob(175, 170, 28), { bioma: B('jungle'), raio: 12 });
paint('bioma', blob(128, 128, 14), { bioma: B('forest'), raio: 10 });
for (let k = 0; k < 14; k++) paint('montanha', [[90, 175]], { raio: 30, forca: 0.8 });
for (let k = 0; k < 10; k++) paint('montanha', [[170, 75]], { raio: 26, forca: 0.8 });
paint('suavizar', blob(90, 175, 24), { raio: 14, forca: 0.5 });
paint('rio', line(40, 128, 220, 140, 120), { raio: 6, forca: 0.7 });

const json = JSON.stringify(serialize(m, 'teste-256'));
writeFileSync(out, gzipSync(json));
let mx = -999; for (const v of m.height) mx = Math.max(mx, v);
console.log(`ok: ${out} (${m.w}x${m.h}), altura máxima ${Math.round(mx)}`);
