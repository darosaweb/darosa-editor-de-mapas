"""Cliente RCON mínimo (manda comandos ao servidor de teste local)."""
import socket
import struct
import time


class Rcon:
    def __init__(self, host='127.0.0.1', port=25576, password='teste-local-minicraft', timeout=30):
        self.s = socket.create_connection((host, port), timeout=timeout)
        self.id = 0
        self._send(3, password)
        rid, _ = self._recv()
        if rid == -1:
            raise RuntimeError('senha RCON recusada')

    def _send(self, kind, text):
        self.id += 1
        body = struct.pack('<ii', self.id, kind) + text.encode('utf-8') + b'\x00\x00'
        self.s.sendall(struct.pack('<i', len(body)) + body)

    def _recv_exact(self, n):
        buf = b''
        while len(buf) < n:
            part = self.s.recv(n - len(buf))
            if not part:
                raise ConnectionError('RCON desconectou')
            buf += part
        return buf

    def _recv(self):
        n = struct.unpack('<i', self._recv_exact(4))[0]
        data = self._recv_exact(n)
        rid, _kind = struct.unpack('<ii', data[:8])
        return rid, data[8:-2].decode('utf-8', 'replace')

    def cmd(self, text):
        self._send(2, text)
        return self._recv()[1]

    def close(self):
        self.s.close()


def wait_rcon(timeout=240, **kw):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            return Rcon(**kw)
        except OSError:
            time.sleep(2)
    raise TimeoutError('servidor não respondeu no RCON')


if __name__ == '__main__':
    import sys
    r = wait_rcon(30)
    print(r.cmd(' '.join(sys.argv[1:]) or 'list'))
