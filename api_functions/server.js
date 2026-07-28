"use strict";

const { app } = require("./index");

const port = Number(process.env.PORT) || 10000;
const host = process.env.HOST || "0.0.0.0";

const server = app.listen(port, host, () => {
  console.log(`[QR Order API] listening on ${host}:${port}`);
});

function shutdown(signal) {
  console.log(`[QR Order API] received ${signal}, shutting down`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
