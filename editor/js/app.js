// Liga tudo: interface, ferramentas, mapa 2D, prévia 3D, salvar/abrir.
import { BIOMES, BIOME_INDEX } from './biomes.js';
import { WorldMap } from './map.js';
import { MapView } from './render2d.js';
import { View3D } from './view3d.js';
import {
  saveToFile, downloadBlob, novoId, pedirArmazenamentoPersistente, listarMapas, guardarMapa, abrirMapa,
  renomearMapa, excluirMapa, guardarVersao, listarVersoes, abrirVersao, baixarBackup, importarArquivo,
  migrarAntigo, MAX_VERSOES,
} from './storage.js';

const $ = id => document.getElementById(id);

const TOOLS = [
  { id: 'bioma',    ic: '🖌️', nome: 'Pintar',   dica: 'Pinta o bioma escolhido' },
  { id: 'balde',    ic: '🪣', nome: 'Balde',    dica: 'Pinta toda a área do mesmo bioma de uma vez' },
  { id: 'subir',    ic: '⬆️', nome: 'Subir',    dica: 'Levanta o terreno' },
  { id: 'descer',   ic: '⬇️', nome: 'Descer',   dica: 'Abaixa o terreno' },
  { id: 'montanha', ic: '⛰️', nome: 'Montanha', dica: 'Cria montanhas com picos' },
  { id: 'rio',      ic: '🏞️', nome: 'Rio',      dica: 'Desenhe o caminho do rio' },
  { id: 'suavizar', ic: '🧽', nome: 'Alisar',   dica: 'Deixa o terreno mais liso' },
  { id: 'nivelar',  ic: '📏', nome: 'Nivelar',  dica: 'Deixa tudo na mesma altura (a do lugar onde você clicou)' },
  { id: 'pegar',    ic: '💧', nome: 'Pegar bioma', dica: 'Clique no mapa para escolher o bioma de lá', avancado: true },
];
const CONTINUOUS = new Set(['subir', 'descer', 'montanha', 'suavizar', 'nivelar']);
const USES_BIOME = new Set(['bioma', 'balde']);

const state = {
  tool: 'bioma',
  bioma: BIOME_INDEX['minecraft:forest'],
  raio: 10,
  forca: 0.5,
  magico: true,
  nivelClique: true,
  nivelAlvo: 70,
  nome: 'meu-mapa',
  mapaId: null,     // id do mapa na biblioteca do navegador (null até carregar)
};

let map = WorldMap.create(256, 'ilha');
const mapCanvas = $('mapa');
const view = new MapView(mapCanvas, map);
const v3d = new View3D($('tela3d'));

// ---------- avisos ----------
let avisoTimer;
function avisar(txt) {
  const a = $('aviso');
  a.textContent = txt; a.classList.add('mostrar');
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => a.classList.remove('mostrar'), 2600);
}

// ---------- ferramentas e biomas ----------
function buildTools() {
  const box = $('ferramentas'); box.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'ferramenta' + (t.avancado ? ' avancado' : '');
    b.dataset.tool = t.id;
    b.title = t.dica;
    b.innerHTML = `<span class="ic">${t.ic}</span><small>${t.nome}</small>`;
    b.onclick = () => setTool(t.id);
    box.appendChild(b);
  }
}
function buildBiomes() {
  const box = $('biomas'); box.innerHTML = '';
  BIOMES.forEach((bi, i) => {
    const b = document.createElement('button');
    b.className = 'bioma' + (bi.simples ? '' : ' avancado');
    b.dataset.i = i;
    b.title = bi.id;
    b.innerHTML = `<span class="cor" style="background:${bi.cor}">${bi.emoji}</span>${bi.nome}`;
    b.onclick = () => { setBiome(i); if (!USES_BIOME.has(state.tool)) setTool('bioma'); };
    box.appendChild(b);
  });
}
function setTool(id) {
  state.tool = id;
  document.querySelectorAll('.ferramenta').forEach(b => b.classList.toggle('ativo', b.dataset.tool === id));
  $('biomas').classList.toggle('apagado', !USES_BIOME.has(id) && id !== 'pegar');
}
function setBiome(i) {
  state.bioma = i;
  document.querySelectorAll('.bioma').forEach(b => b.classList.toggle('ativo', +b.dataset.i === i));
}
function setRaio(r) {
  state.raio = r;
  $('rngRaio').value = r; $('outRaio').textContent = r;
  document.querySelectorAll('.tam').forEach(b => b.classList.toggle('ativo', +b.dataset.tam === r));
  if (view.cursor) view.cursor.r = r;
}

// ---------- tamanho dos canvas ----------
function resizeCanvas() {
  const r = mapCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  mapCanvas.width = Math.round(r.width * dpr);
  mapCanvas.height = Math.round(r.height * dpr);
  view.dpr = dpr;
  if (view.autoFit !== false) view.fit();
  v3d.resize();
}
new ResizeObserver(resizeCanvas).observe(mapCanvas);

// ---------- pintura com o mouse / toque ----------
const pointers = new Map();
let painting = null;   // { last: {x,y}, lastApply }
let panning = null;
let pinch = null;
let spaceDown = false;

function evPos(e) {
  const r = mapCanvas.getBoundingClientRect();
  const dpr = view.dpr || 1;
  return { sx: (e.clientX - r.left) * dpr, sy: (e.clientY - r.top) * dpr };
}

function brushOpts() {
  return { raio: state.raio, forca: state.forca, bioma: state.bioma, magico: state.magico, alvo: state.alvoAtual };
}

function applyAt(p) {
  map.applyBrush(state.tool, p.x, p.y, brushOpts());
}

function strokeTo(p) {
  const last = painting.last;
  const dx = p.x - last.x, dy = p.y - last.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(0.5, state.raio * (CONTINUOUS.has(state.tool) ? 0.5 : 0.3));
  if (dist < step) return;
  const n = Math.floor(dist / step);
  for (let k = 1; k <= n; k++) applyAt({ x: last.x + dx * k / n, y: last.y + dy * k / n });
  painting.last = p;
  painting.lastApply = performance.now();
}

function inside(p) { return p.x >= 0 && p.y >= 0 && p.x < map.w && p.y < map.h; }

function startPaint(p) {
  if (state.tool === 'pegar') {
    if (inside(p)) { setBiome(map.biome[map.idx(p.x | 0, p.y | 0)]); setTool('bioma'); avisar('Bioma escolhido: ' + BIOMES[state.bioma].nome); }
    return;
  }
  if (state.tool === 'balde') {
    if (!inside(p)) return;
    map.beginStroke(); map.fillBiome(p.x | 0, p.y | 0, state.bioma); map.endStroke();
    updateUndoButtons();
    return;
  }
  if (state.tool === 'nivelar') {
    state.alvoAtual = state.nivelClique && inside(p) ? map.height[map.idx(p.x | 0, p.y | 0)] : state.nivelAlvo;
  }
  map.beginStroke();
  painting = { last: p, lastApply: performance.now() };
  applyAt(p);
}
function endPaint() {
  if (!painting) return false;
  painting = null;
  const pushed = map.endStroke();
  updateUndoButtons();
  return pushed;
}

mapCanvas.addEventListener('contextmenu', e => e.preventDefault());
mapCanvas.addEventListener('pointerdown', e => {
  mapCanvas.setPointerCapture(e.pointerId);
  const pos = evPos(e);
  pointers.set(e.pointerId, pos);
  if (pointers.size === 2) {         // dois dedos: zoom/arrasto, cancela a pintura
    if (painting && endPaint()) { map.undo(); map.redoStack.pop(); updateUndoButtons(); }
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy), cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2 };
    return;
  }
  if (e.button === 1 || e.button === 2 || spaceDown) {
    panning = pos; mapCanvas.classList.add('arrastando');
    return;
  }
  if (e.button === 0) startPaint(view.toMap(pos.sx, pos.sy));
});
mapCanvas.addEventListener('pointermove', e => {
  const pos = evPos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos);
  const p = view.toMap(pos.sx, pos.sy);
  view.cursor = { x: p.x, y: p.y, r: state.raio };
  showInfo(p);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.sx - b.sx, a.sy - b.sy), cx = (a.sx + b.sx) / 2, cy = (a.sy + b.sy) / 2;
    view.panX += cx - pinch.cx; view.panY += cy - pinch.cy;
    view.zoomAt(cx, cy, d / pinch.d);
    pinch = { d, cx, cy };
    return;
  }
  if (panning) {
    view.panX += pos.sx - panning.sx; view.panY += pos.sy - panning.sy;
    view.autoFit = false;
    panning = pos;
    return;
  }
  if (painting) strokeTo(p);
});
function pointerEnd(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (panning) { panning = null; mapCanvas.classList.remove('arrastando'); }
  endPaint();
}
mapCanvas.addEventListener('pointerup', pointerEnd);
mapCanvas.addEventListener('pointercancel', pointerEnd);
mapCanvas.addEventListener('pointerleave', () => { if (!painting) view.cursor = null; $('info').textContent = 'Passe o mouse no mapa'; });
mapCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const pos = evPos(e);
  view.zoomAt(pos.sx, pos.sy, e.deltaY > 0 ? 0.87 : 1.15);
}, { passive: false });

function showInfo(p) {
  const s = map.stats(p.x | 0, p.y | 0);
  if (!s) { $('info').textContent = 'Fora do mapa (lá será oceano)'; return; }
  const agua = s.altura < map.seaLevel ? ` · 💧 ${map.seaLevel - s.altura} de água` : '';
  $('info').textContent = `X ${p.x | 0} · Z ${p.y | 0} · altura ${s.altura}${agua} · ${s.bioma.emoji} ${s.bioma.nome}`;
}

// ---------- teclado ----------
window.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); salvar(); }
  else if (k === '[') setRaio(Math.max(1, state.raio - (state.raio > 10 ? 4 : 1)));
  else if (k === ']') setRaio(Math.min(100, state.raio + (state.raio >= 10 ? 4 : 1)));
  else if (k === ' ') { spaceDown = true; e.preventDefault(); }
});
window.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

// ---------- desfazer ----------
function doUndo() { if (map.undo()) updateUndoButtons(); else avisar('Nada para desfazer'); }
function doRedo() { if (map.redo()) updateUndoButtons(); }
function updateUndoButtons() {
  $('btnDesfazer').disabled = map.undoStack.length === 0;
  $('btnRefazer').disabled = map.redoStack.length === 0;
}
$('btnDesfazer').onclick = doUndo;
$('btnRefazer').onclick = doRedo;

// ---------- guardar no navegador (biblioteca "Meus mapas") ----------
const INTERVALO_VERSAO = 3 * 60 * 1000;   // uma "foto" a cada 3 minutos de desenho
let lastSavedVersion = -1, lastAutoSave = 0, salvando = null;
let versaoDaUltimaFoto = -1, horaDaUltimaFoto = 0;

function setStatus(txt, erro = false) {
  const s = $('statusSalvo');
  s.textContent = txt;
  s.classList.toggle('erro', erro);
}

function miniatura() {
  view.updateImage();            // garante que a imagem do mapa está em dia antes da "foto"
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const ctx = c.getContext('2d');
  const k = 96 / Math.max(map.w, map.h);
  ctx.drawImage(view.off, (96 - map.w * k) / 2, (96 - map.h * k) / 2, map.w * k, map.h * k);
  return c.toDataURL('image/png');
}

// Grava o mapa aberto no navegador; de tempos em tempos guarda também uma versão para voltar atrás
async function guardarAgora({ forcarVersao = false } = {}) {
  if (!state.mapaId) return;
  if (salvando) await salvando;
  const m = map, id = state.mapaId, v = m.version;
  const precisa = v !== lastSavedVersion;
  if (!precisa && !forcarVersao) return;
  salvando = (async () => {
    try {
      const blob = await guardarMapa(id, m, state.nome, miniatura());
      if (m === map) lastSavedVersion = v;
      const hora = Date.now();
      if (v !== versaoDaUltimaFoto && (forcarVersao || hora - horaDaUltimaFoto > INTERVALO_VERSAO)) {
        await guardarVersao(id, m, state.nome, blob);
        if (m === map) { versaoDaUltimaFoto = v; horaDaUltimaFoto = hora; }
      }
      setStatus('✓ guardado');
    } catch (err) {
      console.error(err);
      setStatus('⚠️ não consegui guardar — use 💾 Salvar', true);
    }
  })();
  await salvando;
  salvando = null;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) guardarAgora(); });
window.addEventListener('pagehide', () => { guardarAgora(); });

// ---------- trocar de mapa ----------
function useMap(m, nome, id) {
  map = m;
  if (nome) { state.nome = nome; $('nome').value = nome; }
  if (id !== undefined) {
    state.mapaId = id;
    try { localStorage.setItem('mapaAtual', id); } catch {}
  }
  view.setMap(m);
  $('numMar').value = m.seaLevel;
  $('tamanhoInfo').textContent = `Mapa de ${m.w} × ${m.h} blocos (${Math.ceil(m.w / 16) * Math.ceil(m.h / 16)} chunks).`;
  updateUndoButtons();
  lastSavedVersion = m.version;
  versaoDaUltimaFoto = m.version;
  horaDaUltimaFoto = Date.now();
}

async function criarMapaGuardado(m, nome) {
  await guardarAgora();                     // o mapa atual fica guardado antes de trocar
  useMap(m, nome, novoId());
  lastSavedVersion = -1;
  await guardarAgora();
}

// ---------- botões do topo ----------
$('btnNovo').onclick = () => $('dlgNovo').showModal();
$('dlgNovo').addEventListener('close', async () => {
  if ($('dlgNovo').returnValue !== 'ok') return;
  const f = new FormData($('dlgNovo').querySelector('form'));
  await criarMapaGuardado(WorldMap.create(+f.get('tam'), f.get('tipo'), map.seaLevel), 'mapa novo');
  avisar('Mapa novo criado! O anterior continua em 📁 Meus mapas.');
});

async function salvar() {
  try {
    await guardarAgora();
    if (await saveToFile(map, state.nome)) avisar('Arquivo salvo! 💾');
  } catch (err) { avisar('Não consegui salvar: ' + err.message); }
}
$('btnSalvar').onclick = salvar;
$('btnAbrir').onclick = () => abrirMeusMapas();
$('arquivo').onchange = async () => {
  const f = $('arquivo').files[0]; $('arquivo').value = '';
  if (!f) return;
  try {
    await guardarAgora();
    const r = await importarArquivo(f);
    if (r.tipo === 'mapa') {
      useMap(r.map, r.nome, r.id);
      $('dlgMapas').close();
      avisar('Mapa aberto: ' + r.nome);
    } else {
      avisar(`${r.quantidade} mapa(s) importado(s) do backup`);
      mostrarLista();
    }
  } catch (err) { avisar('Não consegui abrir: ' + err.message); }
};

// ---------- janela "Meus mapas" ----------
const quandoTxt = t => {
  const d = new Date(t), hoje = new Date();
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === hoje.toDateString()) return 'hoje, ' + hora;
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return 'ontem, ' + hora;
  return d.toLocaleDateString('pt-BR') + ', ' + hora;
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function abrirMeusMapas() {
  await guardarAgora();
  $('dlgMapas').showModal();
  mostrarLista();
}

async function mostrarLista() {
  $('mapasTitulo').textContent = '📁 Meus mapas';
  $('mapasVoltar').hidden = true;
  $('mapasAcoes').hidden = false;
  const box = $('mapasLista');
  box.innerHTML = '<p class="dica">Carregando…</p>';
  let lista;
  try { lista = await listarMapas(); } catch { box.innerHTML = '<p class="dica">Não consegui ler os mapas guardados neste navegador.</p>'; return; }
  box.innerHTML = '';
  for (const m of lista) {
    const atual = m.id === state.mapaId;
    const item = document.createElement('div');
    item.className = 'mapa-item' + (atual ? ' atual' : '');
    item.innerHTML = `
      ${m.miniatura ? `<img src="${m.miniatura}" alt="">` : '<div class="sem-mini">🗺️</div>'}
      <div class="mapa-info"><b>${esc(m.nome)}</b><small>${m.w}×${m.h} · ${quandoTxt(m.alterado)}${atual ? ' · <em>aberto agora</em>' : ''}</small></div>
      <div class="mapa-botoes">
        ${atual ? '' : '<button data-a="abrir" class="primario">Abrir</button>'}
        <button data-a="versoes" title="Voltar para uma versão anterior">🕘 Versões</button>
        ${atual ? '' : '<button data-a="excluir" class="avancado" title="Excluir para sempre">🗑️</button>'}
      </div>`;
    item.querySelector('[data-a=versoes]').onclick = () => mostrarVersoes(m);
    const ab = item.querySelector('[data-a=abrir]');
    if (ab) ab.onclick = async () => {
      await guardarAgora();
      const r = await abrirMapa(m.id);
      if (!r) { avisar('Não consegui abrir esse mapa'); return; }
      useMap(r.map, r.nome, m.id);
      $('dlgMapas').close();
      avisar('Mapa aberto: ' + r.nome);
    };
    const ex = item.querySelector('[data-a=excluir]');
    if (ex) ex.onclick = async () => {
      if (!confirm(`Excluir o mapa "${m.nome}" e todas as versões dele?\n\nIsso não pode ser desfeito.`)) return;
      await excluirMapa(m.id);
      mostrarLista();
    };
    box.appendChild(item);
  }
  if (!lista.length) box.innerHTML = '<p class="dica">Nenhum mapa guardado ainda.</p>';
}

async function mostrarVersoes(m) {
  await guardarAgora();
  $('mapasTitulo').textContent = '🕘 Versões de ' + m.nome;
  $('mapasVoltar').hidden = false;
  $('mapasAcoes').hidden = true;
  const box = $('mapasLista');
  const versoes = await listarVersoes(m.id);
  box.innerHTML = `<p class="dica">O editor guarda uma versão a cada 3 minutos de desenho (as ${MAX_VERSOES} mais recentes).
    Voltar para uma versão não apaga nada: o mapa como está agora vira mais uma versão.</p>`;
  for (const v of versoes) {
    const item = document.createElement('div');
    item.className = 'mapa-item';
    item.innerHTML = `<div class="sem-mini">🕘</div>
      <div class="mapa-info"><b>${quandoTxt(v.quando)}</b><small>${esc(v.nome)}</small></div>
      <div class="mapa-botoes"><button class="primario">Voltar para esta</button></div>`;
    item.querySelector('button').onclick = async () => {
      // guarda o estado atual do mapa como versão antes de voltar
      if (m.id === state.mapaId) await guardarAgora({ forcarVersao: true });
      else {
        const atual = await abrirMapa(m.id);
        if (atual) await guardarVersao(m.id, atual.map, atual.nome);
        await guardarAgora();
      }
      const r = await abrirVersao(v.vid);
      if (!r) { avisar('Não consegui abrir essa versão'); return; }
      useMap(r.map, r.nome, m.id);
      lastSavedVersion = -1;
      await guardarAgora();
      $('dlgMapas').close();
      avisar('Voltei para a versão de ' + quandoTxt(v.quando));
    };
    box.appendChild(item);
  }
  if (!versoes.length) box.insertAdjacentHTML('beforeend', '<p class="dica">Ainda não há versões deste mapa.</p>');
}

$('mapasVoltar').onclick = () => mostrarLista();
$('mapasFechar').onclick = () => $('dlgMapas').close();
$('mapasArquivo').onclick = () => $('arquivo').click();
$('mapasBackup').onclick = async () => {
  try { const n = await baixarBackup(); avisar(`Backup com ${n} mapa(s) baixado`); }
  catch (err) { avisar('Não consegui fazer o backup: ' + err.message); }
};
$('btnExportar').onclick = () => $('dlgExportar').showModal();
$('dlgExportar').addEventListener('close', () => {
  const v = $('dlgExportar').returnValue;
  if (!v.startsWith('png-')) return;
  const modo = v.slice(4);
  const url = view.toPNG(modo);
  fetch(url).then(r => r.blob()).then(b => downloadBlob(b, `${state.nome}-${modo}.png`));
});
$('nome').oninput = () => { state.nome = $('nome').value || 'meu-mapa'; };
$('nome').onchange = () => { if (state.mapaId) renomearMapa(state.mapaId, state.nome).catch(() => {}); };

// modo avançado
$('chkAvancado').onchange = () => {
  document.body.classList.toggle('simples', !$('chkAvancado').checked);
  try { localStorage.setItem('avancado', $('chkAvancado').checked ? '1' : ''); } catch {}
  if (!$('chkAvancado').checked && (TOOLS.find(t => t.id === state.tool)?.avancado)) setTool('bioma');
  if (!$('chkAvancado').checked && !BIOMES[state.bioma].simples) setBiome(BIOME_INDEX['minecraft:forest']);
  requestAnimationFrame(resizeCanvas);
};

// vistas 2D
document.querySelectorAll('[data-vista]').forEach(b => b.onclick = () => {
  view.mode = b.dataset.vista;
  document.querySelectorAll('[data-vista]').forEach(x => x.classList.toggle('ativo', x === b));
  view.updateImage(true);
});
$('zoomMais').onclick = () => view.zoomAt(mapCanvas.width / 2, mapCanvas.height / 2, 1.3);
$('zoomMenos').onclick = () => view.zoomAt(mapCanvas.width / 2, mapCanvas.height / 2, 1 / 1.3);
$('zoomAjustar').onclick = () => view.fit();

// tamanho / força / ajustes
document.querySelectorAll('.tam').forEach(b => b.onclick = () => setRaio(+b.dataset.tam));
$('rngRaio').oninput = () => setRaio(+$('rngRaio').value);
$('rngForca').oninput = () => { state.forca = $('rngForca').value / 100; $('outForca').textContent = $('rngForca').value + '%'; };
$('chkMagico').onchange = () => { state.magico = $('chkMagico').checked; };
$('chkNivelClique').onchange = () => { state.nivelClique = $('chkNivelClique').checked; };
$('numNivel').onchange = () => { state.nivelAlvo = +$('numNivel').value; };
$('numMar').onchange = () => {
  const v = Math.round(+$('numMar').value);
  if (Number.isFinite(v)) { map.setSeaLevel(Math.max(-40, Math.min(200, v))); avisar('Nível do mar: ' + map.seaLevel); }
};
$('rngExagero').oninput = () => { v3d.exagero = $('rngExagero').value / 10; v3d.needDraw = true; };
$('chkRelevo').onchange = () => { view.relevo = $('chkRelevo').checked; view.updateImage(true); };
$('chkGrade').onchange = () => { view.grade = $('chkGrade').checked; };

// ---------- laço de desenho ----------
function loop(now) {
  requestAnimationFrame(loop);   // agenda o próximo quadro primeiro: um erro aqui não congela o editor
  if (painting && CONTINUOUS.has(state.tool) && now - painting.lastApply > 80) {
    painting.lastApply = now;
    applyAt(painting.last);
  }
  view.updateImage();
  view.draw();
  v3d.frame(map, now);
  if (map.version !== lastSavedVersion && !salvando) {
    setStatus('✏️ desenhando…');
    if (!painting && now - lastAutoSave > 5000) {
      lastAutoSave = now;
      guardarAgora();
    }
  }
}

// acesso pelo console do navegador, para diagnóstico
window.editor = { get map() { return map; }, view, v3d, state };

// ---------- início ----------
buildTools();
buildBiomes();
setTool('bioma');
setBiome(state.bioma);
setRaio(10);
try { if (localStorage.getItem('avancado')) { $('chkAvancado').checked = true; document.body.classList.remove('simples'); } } catch {}
useMap(map);
resizeCanvas();
requestAnimationFrame(loop);

// Abre o último mapa usado (ou cria o primeiro). Até isso terminar, nada é guardado.
(async () => {
  pedirArmazenamentoPersistente();
  try {
    await migrarAntigo();
    let id = null;
    try { id = localStorage.getItem('mapaAtual'); } catch {}
    let r = id ? await abrirMapa(id) : null;
    if (!r) {
      const lista = await listarMapas();
      if (lista.length) { id = lista[0].id; r = await abrirMapa(id); }
    }
    if (r) {
      useMap(r.map, r.nome, id);
      avisar('Continuando o mapa "' + r.nome + '" 👍');
    } else {
      state.mapaId = novoId();
      try { localStorage.setItem('mapaAtual', state.mapaId); } catch {}
      lastSavedVersion = -1;
      await guardarAgora();
    }
    setStatus('✓ guardado');
  } catch (err) {
    console.error(err);
    setStatus('⚠️ este navegador não deixa guardar — use 💾 Salvar', true);
  }
})();
