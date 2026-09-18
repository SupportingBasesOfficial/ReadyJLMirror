import socket
import ssl
ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
ctx.load_verify_locations('/run/secrets/tls/ca.pem')
ctx.load_cert_chain('/run/secrets/tls/api-cert.pem',
                    '/run/secrets/tls/api-key.pem')
ctx.check_hostname = False
try:
    s = ctx.wrap_socket(
        socket.create_connection(('localhost', 8000), 5),
        server_hostname='api')
    print('TLS ok:', s.version())
except Exception as e:
    print('TLS fail:', repr(e))
