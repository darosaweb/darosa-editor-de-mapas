// Salvar / abrir projeto (.mcmapa = JSON compactado com gzip) e autosalvar no navegador.
import { WorldMap } from './map.js';
import { BIOMES, BIOME_INDEX } from './biomes.js';

const FORMATO = 'minicraft-mapa';
const VERSAO = 1;

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const s = atob(str), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Projeto em formato simples para o gerador (Python) ler:
// alturas em Int16 (blocos inteiros), biomas como índice numa lista de nomes.
export function serialize(map, nome) {
  const h16 = new Int16Array(map.w * map.h);
  for (let i = 0; i < h16.length; i++) h16[i] = Math.round(map.height[i]);
  return {
    formato: FORMATO, versao: VERSAO, nome,
    largura: map.w, altura: map.h, nivelMar: map.seaLevel, semente: map.seed,
    biomas: BIOMES.map(b => b.id),
    // dados em little-endian, linha por linha (z), coluna por coluna (x)
    alturas: toB64(new Uint8Array(h16.buffer)),
    biomaGrade: toB64(map.biome),
    // alturas com fração, para continuar editando sem perder suavidade
    alturasFinas: toB64(new Uint8Array(map.height.buffer)),
    // marcadores em coordenadas do mapa (x = coluna, z = linha). O tipo da vila sai do bioma na hora de gerar.
    marcadores: {
      nascer: map.markers.nascer ? { x: Math.floor(map.markers.nascer.x), z: Math.floor(map.markers.nascer.z) } : null,
      vilas: map.markers.vilas.map(v => ({ x: Math.floor(v.x), z: Math.floor(v.z) })),
      entradas: map.markers.entradas.map(v => ({ x: Math.floor(v.x), z: Math.floor(v.z) })),
    },
    // quantidade de cavernas no subsolo: 'nenhuma' | 'poucas' | 'normal' | 'muitas'
    cavernas: map.markers.cavernas,
  };
}

export function deserialize(obj) {
  if (obj.formato !== FORMATO) throw new Error('Este arquivo não é um projeto do editor de mapas.');
  const m = new WorldMap(obj.largura, obj.altura, obj.nivelMar);
  m.seed = obj.semente ?? m.seed;
  if (obj.alturasFinas) {
    m.height.set(new Float32Array(fromB64(obj.alturasFinas).buffer));
  } else {
    const h16 = new Int16Array(fromB64(obj.alturas).buffer);
    for (let i = 0; i < h16.length; i++) m.height[i] = h16[i];
  }
  // remapeia os biomas pelo nome (caso a lista mude entre versões)
  const raw = fromB64(obj.biomaGrade);
  const map = obj.biomas.map(id => BIOME_INDEX[id] ?? BIOME_INDEX['minecraft:plains']);
  for (let i = 0; i < raw.length; i++) m.biome[i] = map[raw[i]];
  const mk = obj.marcadores;
  if (mk) {
    const ok = p => p && p.x >= 0 && p.z >= 0 && p.x < m.w && p.z < m.h;
    m.markers = {
      ...m.markers,
      nascer: ok(mk.nascer) ? { x: mk.nascer.x + 0.5, z: mk.nascer.z + 0.5 } : null,
      vilas: (mk.vilas || []).filter(ok).map(v => ({ x: v.x + 0.5, z: v.z + 0.5 })),
      entradas: (mk.entradas || []).filter(ok).map(v => ({ x: v.x + 0.5, z: v.z + 0.5 })),
    };
  }
  if (['nenhuma', 'poucas', 'normal', 'muitas'].includes(obj.cavernas)) m.markers.cavernas = obj.cavernas;
  m.markAll();
  return { map: m, nome: obj.nome || 'meu-mapa' };
}

async function gzip(text) {
  const cs = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(cs).blob();
}
async function gunzip(blob) {
  const ds = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(ds).text();
}

export async function saveToFile(map, nome) {
  const blob = await gzip(JSON.stringify(serialize(map, nome)));
  const arquivo = (nome || 'meu-mapa').replace(/[^\w\- ]+/g, '').trim() + '.mcmapa';
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: arquivo,
        types: [{ description: 'Projeto de mapa', accept: { 'application/gzip': ['.mcmapa'] } }],
      });
      const wr = await h.createWritable(); await wr.write(blob); await wr.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  downloadBlob(blob, arquivo);
  return true;
}

export async function loadFromFile(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const text = head[0] === 0x1f && head[1] === 0x8b ? await gunzip(file) : await file.text();
  return deserialize(JSON.parse(text));
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- biblioteca "Meus mapas" (IndexedDB do navegador) ----------
// mapas:   { id, nome, criado, alterado, w, h, miniatura }   (lista leve)
// dados:   id -> Blob gzip do projeto                        (o mapa em si)
// versoes: { vid (auto), mapaId, quando, nome, blob }        (fotos antigas para voltar atrás)
export const MAX_VERSOES = 15;
let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('minicraft-editor', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projetos')) d.createObjectStore('projetos');   // versão 1 (só "ultimo")
      if (!d.objectStoreNames.contains('mapas')) d.createObjectStore('mapas', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('dados')) d.createObjectStore('dados');
      if (!d.objectStoreNames.contains('versoes')) {
        d.createObjectStore('versoes', { keyPath: 'vid', autoIncrement: true }).createIndex('mapaId', 'mapaId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbPromise = null; rej(r.error); };
  });
  return dbPromise;
}
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function tx(stores, mode, fn) {
  const d = await db();
  const t = d.transaction(stores, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const out = await fn(...[].concat(stores).map(s => t.objectStore(s)));
  await done;
  return out;
}

export function novoId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Pede ao navegador para não apagar os dados quando faltar espaço
export async function pedirArmazenamentoPersistente() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

export async function listarMapas() {
  const all = await tx('mapas', 'readonly', s => req(s.getAll()));
  return all.sort((a, b) => b.alterado - a.alterado);
}

export async function guardarMapa(id, map, nome, miniatura, criado) {
  const blob = await gzip(JSON.stringify(serialize(map, nome)));
  await tx(['mapas', 'dados'], 'readwrite', async (m, d) => {
    const antigo = await req(m.get(id));
    m.put({
      id, nome, w: map.w, h: map.h,
      criado: antigo?.criado ?? criado ?? Date.now(),
      alterado: Date.now(),
      miniatura: miniatura ?? antigo?.miniatura ?? null,
    });
    d.put(blob, id);
  });
  return blob;
}

export async function abrirMapa(id) {
  const [meta, blob] = await tx(['mapas', 'dados'], 'readonly', (m, d) => Promise.all([req(m.get(id)), req(d.get(id))]));
  if (!meta || !blob) return null;
  return { ...deserialize(JSON.parse(await gunzip(blob))), meta };
}

export async function renomearMapa(id, nome) {
  await tx('mapas', 'readwrite', async m => {
    const meta = await req(m.get(id));
    if (meta) { meta.nome = nome; m.put(meta); }
  });
}

export async function excluirMapa(id) {
  await tx(['mapas', 'dados', 'versoes'], 'readwrite', async (m, d, v) => {
    m.delete(id); d.delete(id);
    const vids = await req(v.index('mapaId').getAllKeys(id));
    for (const k of vids) v.delete(k);
  });
}

// Guarda uma "foto" do mapa; mantém só as MAX_VERSOES mais recentes de cada mapa
export async function guardarVersao(mapaId, map, nome, blobPronto) {
  const blob = blobPronto ?? await gzip(JSON.stringify(serialize(map, nome)));
  await tx('versoes', 'readwrite', async v => {
    v.add({ mapaId, quando: Date.now(), nome, blob });
    const keys = await req(v.index('mapaId').getAllKeys(mapaId));
    keys.sort((a, b) => a - b);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VERSOES))) v.delete(k);
  });
}

export async function listarVersoes(mapaId) {
  const all = await tx('versoes', 'readonly', v => req(v.index('mapaId').getAll(mapaId)));
  return all.map(({ vid, quando, nome }) => ({ vid, quando, nome })).sort((a, b) => b.quando - a.quando);
}

export async function abrirVersao(vid) {
  const rec = await tx('versoes', 'readonly', v => req(v.get(vid)));
  return rec ? deserialize(JSON.parse(await gunzip(rec.blob))) : null;
}

// Backup de todos os mapas num arquivo só (mapas + versões)
export async function baixarBackup() {
  const mapas = await listarMapas();
  const itens = [];
  for (const meta of mapas) {
    const blob = await tx('dados', 'readonly', d => req(d.get(meta.id)));
    if (blob) itens.push({ meta, projeto: JSON.parse(await gunzip(blob)) });
  }
  const conteudo = JSON.stringify({ formato: 'minicraft-biblioteca', versao: 1, quando: Date.now(), mapas: itens });
  const data = new Date().toISOString().slice(0, 10);
  downloadBlob(await gzip(conteudo), `meus-mapas-backup-${data}.mcbackup`);
  return itens.length;
}

// Importa um backup (.mcbackup) ou um projeto solto (.mcmapa). Nunca apaga nada: tudo entra como mapa novo
// se já existir um mapa com o mesmo id e conteúdo diferente.
export async function importarArquivo(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const text = head[0] === 0x1f && head[1] === 0x8b ? await gunzip(file) : await file.text();
  const obj = JSON.parse(text);
  if (obj.formato === 'minicraft-biblioteca') {
    const existentes = new Set((await listarMapas()).map(m => m.id));
    let n = 0;
    for (const { meta, projeto } of obj.mapas) {
      const { map, nome } = deserialize(projeto);
      const id = existentes.has(meta.id) ? novoId() : meta.id;
      await guardarMapa(id, map, existentes.has(meta.id) ? `${nome} (importado)` : nome, meta.miniatura, meta.criado);
      n++;
    }
    return { tipo: 'backup', quantidade: n };
  }
  const { map, nome } = deserialize(obj);
  const id = novoId();
  await guardarMapa(id, map, nome, null);
  return { tipo: 'mapa', id, map, nome };
}

// Traz o autosalvamento antigo (versão 1 do editor, um único "último mapa") para a biblioteca
export async function migrarAntigo() {
  try {
    const rec = await tx('projetos', 'readonly', p => req(p.get('ultimo')));
    if (!rec) return null;
    const { map, nome } = deserialize(JSON.parse(await gunzip(rec.blob)));
    const id = novoId();
    await guardarMapa(id, map, nome, null, rec.quando);
    await tx('projetos', 'readwrite', p => p.delete('ultimo'));
    return id;
  } catch { return null; }
}
