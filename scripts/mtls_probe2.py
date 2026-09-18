import httpx

# WITH client cert — should succeed
r = httpx.get('https://api:8000/health',
              cert=('/run/secrets/tls/bff-cert.pem',
                    '/run/secrets/tls/bff-key.pem'),
              verify='/run/secrets/tls/ca.pem', timeout=5)
print('with cert:', r.status_code, r.json())

# WITHOUT client cert — handshake must fail
try:
    httpx.get('https://api:8000/health',
              verify='/run/secrets/tls/ca.pem', timeout=5)
    print('without cert: CONNECTED (unexpected!)')
except Exception as e:
    print('without cert: refused ->', type(e).__name__)
