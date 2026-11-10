"""Desenha o mundo (visto de cima) a partir dos arquivos de região e conta o que o Minecraft colocou.

  python -I -X utf8 gerador/renderizar.py <pasta region> <info.json> <saida.png>
"""
import json
import os
import struct
import sys
import zlib
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from anvil import Region  # noqa: E402
from chunkfmt import section_blocks, section_biomes  # noqa: E402

TRANSPARENTE = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:light'}
CORES = {
    'grass_block': (95, 159, 53), 'short_grass': (110, 170, 60), 'tall_grass': (110, 170, 60), 'fern': (90, 150, 60),
    'large_fern': (90, 150, 60), 'dirt': (134, 96, 67), 'coarse_dirt': (119, 85, 59), 'podzol': (91, 63, 24),
    'sand': (219, 207, 163), 'sandstone': (216, 203, 155), 'red_sand': (190, 102, 33), 'gravel': (136, 126, 126),
    'stone': (125, 125, 125), 'andesite': (136, 136, 137), 'granite': (149, 103, 85), 'diorite': (188, 188, 188),
    'calcite': (223, 224, 220), 'snow': (249, 254, 254), 'snow_block': (249, 254, 254), 'powder_snow': (248, 253, 253),
    'ice': (145, 183, 253), 'packed_ice': (141, 180, 250), 'water': (48, 92, 210), 'seagrass': (40, 110, 70),
    'tall_seagrass': (40, 110, 70), 'kelp': (60, 120, 50), 'kelp_plant': (60, 120, 50), 'clay': (160, 166, 179),
    'mycelium': (111, 99, 105), 'cactus': (85, 127, 43), 'dead_bush': (107, 79, 41), 'sugar_cane': (148, 192, 101),
    'lily_pad': (32, 128, 48), 'mud': (60, 57, 60), 'moss_block': (89, 109, 45),
    'terracotta': (152, 94, 67), 'orange_terracotta': (161, 83, 37), 'yellow_terracotta': (186, 133, 35),
    'white_terracotta': (209, 178, 161), 'red_terracotta': (143, 61, 46), 'light_gray_terracotta': (135, 107, 98),
    'brown_terracotta': (77, 51, 35), 'red_mushroom_block': (200, 46, 45), 'brown_mushroom_block': (149, 111, 81),
    'mushroom_stem': (203, 196, 185), 'pumpkin': (198, 118, 24), 'melon': (111, 145, 30), 'bamboo': (93, 144, 19),
}


def color_of(name):
    n = name.split(':')[1]
    if n in CORES:
        return CORES[n]
    if 'cherry_leaves' in n: return (240, 170, 205)
    if 'leaves' in n:
        return {'spruce': (60, 98, 60), 'birch': (128, 167, 85), 'jungle': (48, 160, 40),
                'acacia': (100, 140, 40), 'dark_oak': (40, 100, 30)}.get(n.split('_leaves')[0], (60, 130, 40))
    if n.endswith('_log') or n.endswith('_wood'): return (102, 81, 50)
    if 'flower' in n or n in ('poppy', 'dandelion', 'cornflower', 'allium', 'azure_bluet', 'oxeye_daisy',
                              'lily_of_the_valley', 'pink_petals', 'blue_orchid') or n.endswith('tulip'):
        return (230, 200, 60)
    if 'ore' in n: return (125, 125, 125)
    return (150, 150, 150)


def write_png(path, w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def main(region_dir, info_path, out):
    info = json.load(open(info_path, encoding='utf-8'))
    (x0, x1), (z0, z1) = info['chunks_x'], info['chunks_z']
    W, H = (x1 - x0 + 1) * 16, (z1 - z0 + 1) * 16
    top = [None] * (W * H)
    tall = [0] * (W * H)
    all_blocks = Counter()
    biome_cells = Counter()
    status = Counter()
    for name in info['regioes']:
        r = Region(os.path.join(region_dir, name))
        for lx, lz in r.chunks():
            cx, cz = r.rx * 32 + lx, r.rz * 32 + lz
            if not (x0 <= cx <= x1 and z0 <= cz <= z1):
                continue
            ch = r.chunk(lx, lz)
            status[ch.get('Status')] += 1
            bx, bz = (cx - x0) * 16, (cz - z0) * 16
            for s in sorted(ch['sections'], key=lambda s: -s['Y']):
                bl = section_blocks(s)
                bi = section_biomes(s)
                if bi:
                    biome_cells.update(bi)
                if not bl:
                    continue
                all_blocks.update(bl)
                for i in range(4095, -1, -1):
                    col = i & 255
                    k = (bz + (col >> 4)) * W + bx + (col & 15)
                    if top[k] is None and bl[i] not in TRANSPARENTE:
                        top[k] = bl[i]
                        tall[k] = s['Y'] * 16 + (i >> 8)
    rgb = bytearray(W * H * 3)
    for z in range(H):
        for x in range(W):
            k = z * W + x
            c = color_of(top[k] or 'minecraft:air')
            north = tall[k - W] if z > 0 else tall[k]
            sh = 1.0 + max(-0.35, min(0.35, (tall[k] - north) * 0.08))
            if top[k] == 'minecraft:water':
                sh = 1.0
            rgb[k * 3:k * 3 + 3] = bytes(min(255, int(v * sh)) for v in c)
    write_png(out, W, H, rgb)

    def soma(pred): return sum(v for k, v in all_blocks.items() if pred(k))
    resumo = {
        'status dos chunks': dict(status),
        'troncos de árvore': soma(lambda k: k.endswith('_log')),
        'folhas': soma(lambda k: 'leaves' in k),
        'minérios': soma(lambda k: k.endswith('_ore')),
        'neve (camada)': all_blocks.get('minecraft:snow', 0),
        'gelo': all_blocks.get('minecraft:ice', 0),
        'cactos': all_blocks.get('minecraft:cactus', 0),
        'flores/plantas': soma(lambda k: any(t in k for t in ('flower', 'tulip', 'poppy', 'dandelion', 'petals', 'grass', 'fern', 'bush'))),
        'biomas (células)': dict(biome_cells.most_common()),
    }
    print(json.dumps(resumo, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main(*sys.argv[1:4])
