"""Gerador: transforma um projeto do editor (.mcmapa) em arquivos de região Anvil (.mca) do Minecraft 26.3.

Cada chunk é gravado com status "minecraft:terrain": pedra, água, superfície e biomas prontos.
O Minecraft completa o resto (árvores, flores, minérios, neve, luz) — ver analise/ESTRUTURA.md.

Uso:
  python -I -X utf8 gerar.py projeto.mcmapa pasta_saida [--anel 8]

Coordenadas: o centro do desenho fica no centro do mundo (X=0, Z=0).
"""
import argparse
import base64
import gzip
import json
import math
import os
import struct
import sys
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nbt import Byte, Int, Long, LongArray, NbtList, dumps  # noqa: E402
from chunkfmt import pack, bits_for  # noqa: E402

DATA_VERSION = 5023          # Minecraft 26.3 (lido do mundo da Pi)
MIN_Y, MAX_Y = -64, 319
SEC_MIN, SEC_MAX = -4, 19    # 24 seções

AIR, WATER, STONE, DEEPSLATE, BEDROCK = ('minecraft:air', 'minecraft:water', 'minecraft:stone',
                                         'minecraft:deepslate', 'minecraft:bedrock')
OCEAN_DEPTH = 14             # profundidade do oceano em volta do desenho
BLEND = 24                   # blocos para o terreno descer suavemente até o oceano fora do desenho

AQUATIC = {'minecraft:ocean', 'minecraft:warm_ocean', 'minecraft:frozen_ocean', 'minecraft:river',
           'minecraft:deep_ocean', 'minecraft:lukewarm_ocean', 'minecraft:cold_ocean'}
# mesmo critério do editor (editor/js/biomes.js): estilo de vila que combina com o bioma
VILA_POR_BIOMA = {
    'minecraft:desert': 'desert', 'minecraft:badlands': 'desert', 'minecraft:beach': 'desert',
    'minecraft:savanna': 'savanna', 'minecraft:taiga': 'taiga',
    'minecraft:snowy_plains': 'snowy', 'minecraft:snowy_taiga': 'snowy',
}
BADLANDS_BANDS = ['minecraft:terracotta', 'minecraft:orange_terracotta', 'minecraft:yellow_terracotta',
                  'minecraft:terracotta', 'minecraft:white_terracotta', 'minecraft:orange_terracotta',
                  'minecraft:red_terracotta', 'minecraft:terracotta', 'minecraft:light_gray_terracotta',
                  'minecraft:brown_terracotta', 'minecraft:orange_terracotta']


def rnd(x, y, z, salt=0):
    """Número pseudo-aleatório estável 0..1 por posição (para bedrock, transição de deepslate etc.)."""
    h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (salt * 2654435761)
    h &= 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return h / 4294967296.0


# ---------------------------------------------------------------- projeto
def load_project(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    p = json.loads(raw.decode('utf-8'))
    if p.get('formato') != 'minicraft-mapa':
        raise SystemExit('arquivo não é um projeto do editor de mapas')
    w, h = p['largura'], p['altura']
    heights = struct.unpack(f'<{w * h}h', base64.b64decode(p['alturas']))
    biome_idx = base64.b64decode(p['biomaGrade'])
    names = p['biomas']
    biomes = [names[i] for i in biome_idx]
    return p, w, h, heights, biomes


class World:
    """Altura e bioma de qualquer coluna do mundo, inclusive fora do desenho (oceano)."""

    def __init__(self, w, h, sea, heights, biomes):
        self.w, self.h, self.sea = w, h, sea
        self.heights, self.biomes = heights, biomes
        self.ox, self.oz = -w // 2, -h // 2     # coordenada do mundo do pixel (0,0)
        self.floor = sea - OCEAN_DEPTH

    def column(self, wx, wz):
        x, z = wx - self.ox, wz - self.oz
        if 0 <= x < self.w and 0 <= z < self.h:
            i = z * self.w + x
            return self.heights[i], self.biomes[i]
        # fora do desenho: continua a borda e desce até o fundo do oceano
        cx, cz = min(max(x, 0), self.w - 1), min(max(z, 0), self.h - 1)
        d = math.hypot(x - cx, z - cz)
        edge_h = self.heights[cz * self.w + cx]
        t = min(1.0, d / BLEND)
        t = t * t * (3 - 2 * t)
        hh = round(edge_h + (self.floor - edge_h) * t)
        return hh, 'minecraft:ocean'


# ---------------------------------------------------------------- superfície por bioma
def surface_layers(biome, top, sea, slope, wx, wz):
    """Blocos do topo da coluna, de cima para baixo: lista de (y, bloco)."""
    under = top < sea - 1          # coberto de água
    if under:
        depth = sea - 1 - top
        if biome in ('minecraft:river',) or depth <= 5:
            mat = ['minecraft:sand'] * 3 + ['minecraft:sandstone']
        elif biome == 'minecraft:swamp':
            mat = ['minecraft:dirt'] * 3
        else:
            mat = (['minecraft:gravel'] if rnd(wx, 0, wz, 7) < 0.6 else ['minecraft:sand']) * 3
            if rnd(wx, 1, wz, 8) < 0.04:
                mat[0] = 'minecraft:clay'
        return [(top - i, b) for i, b in enumerate(mat)]

    if biome == 'minecraft:desert':
        mat = ['minecraft:sand'] * 4 + ['minecraft:sandstone'] * 3
    elif biome == 'minecraft:beach':
        mat = ['minecraft:sand'] * 4 + ['minecraft:sandstone']
    elif biome == 'minecraft:badlands':
        mat = ['minecraft:red_sand'] + [BADLANDS_BANDS[(top - 1 - i) % len(BADLANDS_BANDS)] for i in range(12)]
    elif biome == 'minecraft:mushroom_fields':
        mat = ['minecraft:mycelium'] + ['minecraft:dirt'] * 3
    elif biome == 'minecraft:stony_peaks':
        mat = ['minecraft:stone'] if rnd(wx, top, wz, 3) < 0.8 else ['minecraft:calcite']
    elif biome in AQUATIC:   # oceano/rio pintado mas acima da água: praia
        mat = ['minecraft:sand'] * 3 + ['minecraft:sandstone']
    else:
        mat = ['minecraft:grass_block'] + ['minecraft:dirt'] * 3

    # encostas íngremes viram pedra (como no Minecraft normal)
    if slope >= 4 and biome not in ('minecraft:desert', 'minecraft:badlands', 'minecraft:beach'):
        mat = ['minecraft:stone'] if slope >= 7 else ['minecraft:gravel' if rnd(wx, 2, wz, 4) < 0.3 else 'minecraft:stone']
    # topos muito altos com neve
    if top >= 175 and biome not in ('minecraft:desert', 'minecraft:badlands', 'minecraft:savanna', 'minecraft:jungle'):
        mat = ['minecraft:snow_block'] * 2
    return [(top - i, b) for i, b in enumerate(mat)]


# ---------------------------------------------------------------- chunk
def build_chunk(world, cx, cz):
    sea = world.sea
    # alturas com 1 bloco de margem (para medir inclinação)
    hgt = {}
    bio = {}
    for dz in range(-1, 17):
        for dx in range(-1, 17):
            hh, bb = world.column(cx * 16 + dx, cz * 16 + dz)
            hgt[(dx, dz)] = max(MIN_Y + 5, min(MAX_Y - 1, int(hh)))
            bio[(dx, dz)] = bb

    cols = []   # índice z*16+x
    for z in range(16):
        for x in range(16):
            top = hgt[(x, z)]
            slope = max(abs(top - hgt[(x + 1, z)]), abs(top - hgt[(x - 1, z)]),
                        abs(top - hgt[(x, z + 1)]), abs(top - hgt[(x, z - 1)]))
            wx, wz = cx * 16 + x, cz * 16 + z
            surf = dict(surface_layers(bio[(x, z)], top, sea, slope, wx, wz))
            cols.append((top, surf, wx, wz))

    tops = [c[0] for c in cols]
    max_top, min_top = max(tops), min(tops)
    min_surf = min(min(c[1]) if c[1] else c[0] for c in cols)

    def block(c, y):
        top, surf, wx, wz = c
        if y > top:
            return WATER if y < sea else AIR
        b = surf.get(y)
        if b:
            return b
        if y <= MIN_Y + 4:
            if y == MIN_Y or rnd(wx, y, wz, 1) < (MIN_Y + 5 - y) / 5:
                return BEDROCK
            return DEEPSLATE
        if y < 0:
            return DEEPSLATE
        if y < 8:
            return DEEPSLATE if rnd(wx, y, wz, 2) < (8 - y) / 8 else STONE
        return STONE

    sections = []
    for sy in range(SEC_MIN, SEC_MAX + 1):
        base = sy * 16
        top_y = base + 15
        if base > max_top and base >= sea:
            uniform = AIR
        elif top_y < min_surf and base >= 8:
            uniform = STONE
        elif top_y < min_surf and top_y < 0 and base > MIN_Y + 4:
            uniform = DEEPSLATE
        else:
            uniform = None
        if uniform:
            bs = {'palette': NbtList([uniform], 8)}
        else:
            palette = {}
            idx = []
            for y in range(base, base + 16):
                for c in cols:
                    name = block(c, y)
                    i = palette.get(name)
                    if i is None:
                        i = palette[name] = len(palette)
                    idx.append(i)
            names = list(palette)
            if len(names) == 1:
                bs = {'palette': NbtList(names, 8)}
            else:
                bs = {'palette': NbtList(names, 8), 'data': LongArray(pack(idx, bits_for(len(names), 4)))}

        # biomas: células 4x4x4, mesmo bioma em toda a altura
        bpal = {}
        bidx = []
        for _y in range(4):
            for qz in range(4):
                for qx in range(4):
                    name = bio[(qx * 4 + 2, qz * 4 + 2)]
                    i = bpal.get(name)
                    if i is None:
                        i = bpal[name] = len(bpal)
                    bidx.append(i)
        bnames = list(bpal)
        biomes = {'palette': NbtList(bnames, 8)}
        if len(bnames) > 1:
            biomes['data'] = LongArray(pack(bidx, bits_for(len(bnames), 1)))
        sections.append({'Y': Byte(sy), 'biomes': biomes, 'block_states': bs})

    # heightmaps (valor = y do bloco mais alto + 1 - MIN_Y)
    surface = [max(t, sea - 1) + 1 - MIN_Y for t in tops]      # água conta
    floor = [t + 1 - MIN_Y for t in tops]                      # só sólidos
    hm = lambda vals: LongArray(pack(vals, 9))  # noqa: E731
    heightmaps = {
        'MOTION_BLOCKING': hm(surface), 'MOTION_BLOCKING_NO_LEAVES': hm(surface),
        'OCEAN_FLOOR': hm(floor), 'OCEAN_FLOOR_WG': hm(floor),
        'WORLD_SURFACE': hm(surface), 'WORLD_SURFACE_WG': hm(surface),
    }
    empty = lambda: NbtList([], 0)  # noqa: E731
    return {
        'DataVersion': Int(DATA_VERSION),
        'xPos': Int(cx), 'yPos': Int(SEC_MIN), 'zPos': Int(cz),
        'Status': 'minecraft:terrain',
        'InhabitedTime': Long(0), 'LastUpdate': Long(0),
        'sections': NbtList(sections, 10),
        'Heightmaps': heightmaps,
        'structures': {'References': {}, 'starts': {}},
        'PostProcessing': NbtList([empty() for _ in range(SEC_MAX - SEC_MIN + 1)], 9),
        'block_ticks': empty(), 'fluid_ticks': empty(),
        'block_entities': empty(), 'entities': empty(),
    }


# ---------------------------------------------------------------- região
def write_region(path, chunks):
    """chunks: {(lx, lz): bytes NBT}."""
    locations = bytearray(4096)
    stamps = bytearray(4096)
    body = bytearray()
    sector = 2
    now = int(time.time())
    for (lx, lz), raw in sorted(chunks.items()):
        comp = zlib.compress(raw, 6)
        payload = struct.pack('>IB', len(comp) + 1, 2) + comp
        n = (len(payload) + 4095) // 4096
        if n > 255:
            raise ValueError('chunk grande demais')
        payload += b'\x00' * (n * 4096 - len(payload))
        off = 4 * (lx + lz * 32)
        struct.pack_into('>I', locations, off, (sector << 8) | n)
        struct.pack_into('>I', stamps, off, now)
        body += payload
        sector += n
    with open(path, 'wb') as f:
        f.write(locations + stamps + body)


def find_spawn(world):
    """Coluna de terra firme mais perto do centro do desenho."""
    for r in range(0, max(world.w, world.h) // 2, 2):
        for dx in range(-r, r + 1, 2):
            for dz in (-r, r) if abs(dx) != r else range(-r, r + 1, 2):
                h, b = world.column(dx, dz)
                if h >= world.sea and b not in AQUATIC:
                    return dx, h + 1, dz
    return 0, world.sea + 1, 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('projeto')
    ap.add_argument('saida')
    ap.add_argument('--anel', type=int, default=8, help='chunks de oceano em volta do desenho (padrão 8)')
    a = ap.parse_args()

    p, w, h, heights, biomes = load_project(a.projeto)
    if w % 16 or h % 16:
        raise SystemExit('largura e altura do mapa precisam ser múltiplos de 16')
    sea = p['nivelMar']
    world = World(w, h, sea, heights, biomes)
    c0x, c0z = world.ox // 16 - a.anel, world.oz // 16 - a.anel
    c1x, c1z = (world.ox + w) // 16 + a.anel - 1, (world.oz + h) // 16 + a.anel - 1

    os.makedirs(os.path.join(a.saida, 'region'), exist_ok=True)
    regions = {}
    t0 = time.time()
    total = (c1x - c0x + 1) * (c1z - c0z + 1)
    done = 0
    for cz in range(c0z, c1z + 1):
        for cx in range(c0x, c1x + 1):
            raw = dumps(build_chunk(world, cx, cz))
            regions.setdefault((cx >> 5, cz >> 5), {})[(cx & 31, cz & 31)] = raw
            done += 1
        print(f'\r  chunks: {done}/{total}', end='', flush=True)
    print()
    for (rx, rz), chunks in regions.items():
        write_region(os.path.join(a.saida, 'region', f'r.{rx}.{rz}.mca'), chunks)

    marcadores = p.get('marcadores') or {}
    spawn, spawn_origem = find_spawn(world), 'automático (terra firme mais perto do centro)'
    nascer = marcadores.get('nascer')
    if nascer:
        wx, wz = nascer['x'] + world.ox, nascer['z'] + world.oz
        hh, bb = world.column(wx, wz)
        if hh >= sea and bb not in AQUATIC:
            spawn, spawn_origem = (wx, hh + 1, wz), 'marcado no editor 🏠'
        else:
            print('  aviso: o ponto 🏠 está na água; usando o automático')
    vilas = []
    for v in marcadores.get('vilas') or []:
        wx, wz = v['x'] + world.ox, v['z'] + world.oz
        hh, bb = world.column(wx, wz)
        if hh < sea or bb in AQUATIC:
            print(f'  aviso: a vila em X {wx} Z {wz} ficou na água; ignorada')
            continue
        vilas.append({'x': wx, 'y': hh + 1, 'z': wz, 'bioma': bb,
                      'estrutura': f'minecraft:village_{VILA_POR_BIOMA.get(bb, "plains")}'})
    info = {
        'projeto': p.get('nome'), 'largura': w, 'altura': h, 'nivelMar': sea,
        'desenho_x': [world.ox, world.ox + w - 1], 'desenho_z': [world.oz, world.oz + h - 1],
        'chunks_x': [c0x, c1x], 'chunks_z': [c0z, c1z],
        # borda do mundo: o desenho + 16 blocos de mar, centrada no 0,0
        'borda_centro': [0, 0], 'borda_tamanho': max(w, h) + 32,
        'spawn': spawn,
        'spawn_origem': spawn_origem,
        'vilas': vilas,
        'regioes': sorted(f'r.{rx}.{rz}.mca' for rx, rz in regions),
    }
    json.dump(info, open(os.path.join(a.saida, 'info.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(f'{total} chunks em {len(regions)} regiões, {time.time() - t0:.1f}s.')
    print(f'Spawn: {spawn} ({spawn_origem}). Vilas marcadas: {len(vilas)}'
          + ''.join(f'\n  - {v["estrutura"]} em X {v["x"]} Z {v["z"]}' for v in vilas))


if __name__ == '__main__':
    main()
