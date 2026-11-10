"""Leitura de arquivos de região Anvil (.mca): 32x32 chunks por arquivo."""
import gzip
import os
import struct
import zlib

from nbt import loads

COMPRESSAO = {1: 'gzip', 2: 'zlib', 3: 'nenhuma', 4: 'lz4'}


class Region:
    def __init__(self, path):
        self.path = path
        self.data = open(path, 'rb').read()
        base = os.path.basename(path).split('.')
        self.rx, self.rz = int(base[1]), int(base[2])

    def location(self, lx, lz):
        """(setor inicial, nº de setores) do chunk local (0..31, 0..31); (0,0) = não existe."""
        off = 4 * (lx + lz * 32)
        v = struct.unpack_from('>I', self.data, off)[0]
        return v >> 8, v & 0xFF

    def timestamp(self, lx, lz):
        return struct.unpack_from('>I', self.data, 4096 + 4 * (lx + lz * 32))[0]

    def raw_chunk(self, lx, lz):
        """Devolve (tipo_compressao, bytes_nbt) ou None."""
        sec, cnt = self.location(lx, lz)
        if sec == 0:
            return None
        p = sec * 4096
        if p + 5 > len(self.data):
            return None  # cópia feita enquanto o servidor escrevia
        length, ctype = struct.unpack_from('>IB', self.data, p)
        body = self.data[p + 5:p + 4 + length]
        external = bool(ctype & 0x80)
        ctype &= 0x7F
        if external:  # chunk muito grande fica num arquivo .mcc ao lado
            cx, cz = self.rx * 32 + lx, self.rz * 32 + lz
            body = open(os.path.join(os.path.dirname(self.path), f'c.{cx}.{cz}.mcc'), 'rb').read()
        if ctype == 1:
            raw = gzip.decompress(body)
        elif ctype == 2:
            raw = zlib.decompress(body)
        elif ctype == 3:
            raw = body
        else:
            raise ValueError(f'compressão {COMPRESSAO.get(ctype, ctype)} não suportada')
        return ctype, raw

    def chunk(self, lx, lz):
        r = self.raw_chunk(lx, lz)
        if r is None:
            return None
        return loads(r[1])[1]

    def chunks(self):
        for lz in range(32):
            for lx in range(32):
                if self.location(lx, lz)[0]:
                    yield lx, lz
