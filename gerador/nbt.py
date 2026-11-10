"""Leitura e escrita de NBT (formato binário do Minecraft Java), só com a biblioteca padrão.

Os valores viram tipos Python "marcados" para que a escrita reproduza exatamente o tipo original:
  Byte, Short, Int, Long, Float, Double  -> subclasses de int/float
  String -> str ; Compound -> dict ; List -> NbtList (guarda o tipo dos itens)
  ByteArray, IntArray, LongArray -> classes próprias (listas de int)
"""
import gzip
import io
import struct
import zlib


class Byte(int): tag = 1
class Short(int): tag = 2
class Int(int): tag = 3
class Long(int): tag = 4
class Float(float): tag = 5
class Double(float): tag = 6
class ByteArray(list): tag = 7
class IntArray(list): tag = 11
class LongArray(list): tag = 12


class NbtList(list):
    tag = 9

    def __init__(self, items=(), item_tag=0):
        super().__init__(items)
        self.item_tag = item_tag


TAG_NAMES = {0: 'End', 1: 'Byte', 2: 'Short', 3: 'Int', 4: 'Long', 5: 'Float', 6: 'Double',
             7: 'ByteArray', 8: 'String', 9: 'List', 10: 'Compound', 11: 'IntArray', 12: 'LongArray'}


# ---------------- leitura ----------------
class _Reader:
    def __init__(self, data):
        self.b = data
        self.p = 0

    def take(self, n):
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def unpack(self, fmt):
        s = struct.calcsize(fmt)
        v = struct.unpack_from(fmt, self.b, self.p)
        self.p += s
        return v[0]

    def string(self):
        n = self.unpack('>H')
        raw = self.take(n)
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:  # "modified UTF-8" do Java em casos raros
            return raw.decode('utf-8', 'surrogatepass')

    def payload(self, t):
        if t == 1: return Byte(self.unpack('>b'))
        if t == 2: return Short(self.unpack('>h'))
        if t == 3: return Int(self.unpack('>i'))
        if t == 4: return Long(self.unpack('>q'))
        if t == 5: return Float(self.unpack('>f'))
        if t == 6: return Double(self.unpack('>d'))
        if t == 7:
            n = self.unpack('>i')
            v = ByteArray(struct.unpack_from(f'>{n}b', self.b, self.p))
            self.p += n
            return v
        if t == 8: return self.string()
        if t == 9:
            it = self.unpack('>b')
            n = self.unpack('>i')
            return NbtList([self.payload(it) for _ in range(n)], it)
        if t == 10:
            d = {}
            while True:
                ct = self.unpack('>b')
                if ct == 0:
                    return d
                name = self.string()
                d[name] = self.payload(ct)
        if t == 11:
            n = self.unpack('>i')
            v = IntArray(struct.unpack_from(f'>{n}i', self.b, self.p))
            self.p += 4 * n
            return v
        if t == 12:
            n = self.unpack('>i')
            v = LongArray(struct.unpack_from(f'>{n}q', self.b, self.p))
            self.p += 8 * n
            return v
        raise ValueError(f'tag NBT desconhecida: {t}')


def loads(data):
    """Lê NBT (bytes, sem compressão). Devolve (nome_raiz, compound)."""
    r = _Reader(data)
    t = r.unpack('>b')
    if t != 10:
        raise ValueError('raiz NBT não é Compound')
    name = r.string()
    return name, r.payload(10)


def load_file(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    elif raw[:1] == b'\x78':
        raw = zlib.decompress(raw)
    return loads(raw)


# ---------------- escrita ----------------
def _tag_of(v):
    if hasattr(v, 'tag'):
        return v.tag
    if isinstance(v, bool): return 1
    if isinstance(v, str): return 8
    if isinstance(v, dict): return 10
    if isinstance(v, int): return 3
    if isinstance(v, float): return 6
    if isinstance(v, list): return 9
    raise TypeError(f'não sei gravar {type(v)} em NBT')


def _w_string(out, s):
    b = s.encode('utf-8')
    out.write(struct.pack('>H', len(b)))
    out.write(b)


def _w_payload(out, t, v):
    if t == 1: out.write(struct.pack('>b', int(v)))
    elif t == 2: out.write(struct.pack('>h', v))
    elif t == 3: out.write(struct.pack('>i', v))
    elif t == 4: out.write(struct.pack('>q', v))
    elif t == 5: out.write(struct.pack('>f', v))
    elif t == 6: out.write(struct.pack('>d', v))
    elif t == 7:
        out.write(struct.pack('>i', len(v)))
        out.write(struct.pack(f'>{len(v)}b', *v))
    elif t == 8: _w_string(out, v)
    elif t == 9:
        it = getattr(v, 'item_tag', 0) or (_tag_of(v[0]) if len(v) else 0)
        out.write(struct.pack('>bi', it, len(v)))
        for x in v:
            _w_payload(out, it, x)
    elif t == 10:
        for k, x in v.items():
            ct = _tag_of(x)
            out.write(struct.pack('>b', ct))
            _w_string(out, k)
            _w_payload(out, ct, x)
        out.write(b'\x00')
    elif t == 11:
        out.write(struct.pack('>i', len(v)))
        out.write(struct.pack(f'>{len(v)}i', *v))
    elif t == 12:
        out.write(struct.pack('>i', len(v)))
        out.write(struct.pack(f'>{len(v)}q', *v))
    else:
        raise ValueError(t)


def dumps(compound, name=''):
    out = io.BytesIO()
    out.write(b'\x0a')
    _w_string(out, name)
    _w_payload(out, 10, compound)
    return out.getvalue()


# ---------------- inspeção ----------------
def describe(v, indent=0, max_items=4, max_depth=12):
    """Texto legível da estrutura (tipos e amostras), para os relatórios."""
    pad = '  ' * indent
    lines = []
    t = _tag_of(v)
    if t == 10:
        for k, x in v.items():
            tx = _tag_of(x)
            head = f'{pad}{k}: {TAG_NAMES[tx]}'
            if tx in (10, 9) and indent < max_depth:
                if tx == 9:
                    head += f'<{TAG_NAMES[getattr(x, "item_tag", 0)]}>[{len(x)}]'
                lines.append(head)
                if tx == 10:
                    lines += describe(x, indent + 1, max_items, max_depth)
                elif len(x) and x.item_tag in (9, 10):
                    lines.append(f'{pad}  [0]:')
                    lines += describe(x[0], indent + 2, max_items, max_depth)
                elif len(x):
                    lines.append(f'{pad}  = {list(x[:max_items])}{" …" if len(x) > max_items else ""}')
            elif tx in (7, 11, 12):
                lines.append(f'{head}[{len(x)}]')
            else:
                lines.append(f'{head} = {x!r}')
    return lines
