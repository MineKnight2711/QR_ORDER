# QR Order API

Node/Express API for FizaHUB QR Order. This service is designed for Render Web Service deployment and uses Firebase Firestore as the database.

## Structure

- `api_functions/`: Express API source.
- `render.yaml`: Render Blueprint. The service root is `api_functions`.

## Render Environment

Set these variables on Render:

```env
NODE_VERSION=20
FIZA_API_BASE_URL=https://fizahub.vn/api-v2
FIZA_API_KEY=...
QR_ORDER_FIREBASE_SERVICE_ACCOUNT_BASE64=...
QR_ORDER_WEB_BASE_URL=https://order.fizahub.vn
QR_ORDER_CORS_ORIGIN=https://order.fizahub.vn
QR_ORDER_COOKIE_SAMESITE=None
QR_ORDER_DEBUG_API=0
```

Create `QR_ORDER_FIREBASE_SERVICE_ACCOUNT_BASE64` from a Firebase service account JSON key:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\fizahub-qr-order-service-account.json")) | Set-Clipboard
```

## Local Run

```bash
cd api_functions
npm ci
npm run lint
npm start
```

Health check:

```bash
curl http://localhost:10000/healthz
```

## Deploy

Use Render Blueprint from `render.yaml`, or create a Render Web Service manually:

```text
Root Directory: api_functions
Build Command: npm ci
Start Command: npm start
Health Check Path: /healthz
```

For production traffic, use a paid Render instance to avoid free-plan sleep.
