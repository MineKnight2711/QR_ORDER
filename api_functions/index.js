"use strict";

const crypto = require("crypto");
const cors = require("cors");
const express = require("express");
const fs = require("fs");
const { applicationDefault, cert, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

initializeApp(firebaseAdminOptions());

const db = getFirestore();
const auth = getAuth();
const app = express();
const consoleSessionCookie = "fh_qr_console";
const consoleSessionHours = 12;
const maxTablesPerPublish = 300;
const configuredCorsOrigins = parseCorsOrigins(process.env.QR_ORDER_CORS_ORIGIN);

logStartupConfig();
app.set("trust proxy", true);
app.use(requestLogger);
app.use(
  cors({
    origin: resolveCorsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: "256kb" }));
app.use((req, _res, next) => {
  if (req.url === "/api" || req.url.startsWith("/api/")) {
    req.url = req.url.slice(4) || "/";
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "fizahub-qr-order-api",
    firestore: "firebase",
  });
});

app.get("/qr/session", asyncHandler(async (req, res) => {
  const token = readText(req.query.token);
  const context = await resolveTableToken(token);
  const menuSnapshot = await db
    .collection("qrStores")
    .doc(context.shopId)
    .collection("menuItems")
    .get();

  const menuItems = menuSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => item.visible !== false)
    .filter((item) => item.available !== false)
    .filter((item) => Number(item.price) > 0)
    .sort((left, right) => readText(left.name).localeCompare(readText(right.name)));

  res.json({
    ok: true,
    shop: publicStore(context.store),
    table: {
      id: context.tableId,
      code: readText(context.table.code, context.tableId),
      label: readText(context.table.label, context.tableId),
    },
    menuItems: menuItems.map(publicMenuItem),
  });
}));

app.post("/qr/request", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const token = readText(body.token);
  const type = normalizeRequestType(body.type);
  const note = readText(body.note).slice(0, 500);
  const clientRequestId = readText(body.clientRequestId).slice(0, 120);
  const context = await resolveTableToken(token);
  const items = await normalizeRequestItems(context.shopId, type, body.items);
  const total = items.reduce((sum, item) => sum + item.total, 0);
  const now = Timestamp.now();
  const requestRef = db
    .collection("qrStores")
    .doc(context.shopId)
    .collection("requests")
    .doc();
  const cooldownRef = db
    .collection("qrStores")
    .doc(context.shopId)
    .collection("requestCooldowns")
    .doc(`${context.tableId}_${type}`);

  await db.runTransaction(async (tx) => {
    const cooldownSnap = await tx.get(cooldownRef);
    if (cooldownSnap.exists) {
      const lastMillis = timestampMillis(cooldownSnap.get("lastRequestAt"));
      const cooldownMillis = type === "order" ? 15000 : 45000;
      if (lastMillis > 0 && now.toMillis() - lastMillis < cooldownMillis) {
        throw httpError(429, "Yeu cau vua duoc gui. Vui long doi trong giay lat.");
      }
    }

    tx.set(requestRef, {
      shopId: context.shopId,
      tableId: context.tableId,
      tableLabel: readText(context.table.label, context.tableId),
      type,
      status: "pending",
      items,
      total,
      note,
      tokenHash: sha256(token),
      source: "qr-web",
      clientRequestId,
      userAgent: readText(req.get("user-agent")).slice(0, 240),
      createdAt: now,
      updatedAt: now,
    });
    tx.set(cooldownRef, { lastRequestAt: now, type, updatedAt: now }, { merge: true });
  });

  res.json({ ok: true, requestId: requestRef.id });
}));

app.post("/staff/login", asyncHandler(async (req, res) => {
  const phone = readText(req.body && req.body.phone).replace(/\D/g, "");
  const password = readText(req.body && req.body.password);
  if (!phone || !password) {
    throw httpError(400, "Thieu so dien thoai hoac mat khau.");
  }

  const loginResponse = await fizaPost("login", null, { dt: phone, pass: password });
  const loginPayload = payloadOf(loginResponse);
  const idKey = firstText(
    [loginPayload, loginResponse],
    ["idkey", "idKey", "accessToken", "token"],
  );
  if (!idKey) {
    throw httpError(502, "FizaHUB khong tra ve ma phien dang nhap.");
  }

  const profileResponse = await fizaGet("users/profile", idKey).catch(() => ({}));
  const profilePayload = payloadOf(profileResponse);
  const profile = { ...loginPayload, ...profilePayload, idkey: idKey, phone };
  const businessResult = await resolveBusinessesForSession({
    idKey,
    loginPayload,
    profilePayload,
  });
  const businesses = businessResult.businesses;
  const role = normalizeRole(firstText([profile], ["role", "quyen", "phanquyen"], "shop"));
  const user = publicUser(profile, role);
  const sessionId = randomToken(32);
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(
    Date.now() + consoleSessionHours * 60 * 60 * 1000,
  );

  await db.collection("qrStaffSessions").doc(sessionId).set({
    idKey,
    user,
    role,
    businesses,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    userAgent: readText(req.get("user-agent")).slice(0, 240),
  });
  setSessionCookie(res, sessionId, req);

  res.json({ ok: true, user, businesses, businessLoadError: businessResult.error });
}));

app.get("/staff/me", asyncHandler(async (req, res) => {
  const session = await readConsoleSession(req, { optional: true });
  if (!session) {
    res.json({ ok: true, authenticated: false });
    return;
  }
  let businesses = Array.isArray(session.data.businesses) ? session.data.businesses : [];
  let businessLoadError = "";
  if (businesses.length === 0) {
    const refreshed = await resolveBusinessesForSession({
      idKey: session.data.idKey,
      loginPayload: session.data.user || {},
      profilePayload: session.data.user || {},
    });
    businesses = refreshed.businesses;
    businessLoadError = refreshed.error;
    if (businesses.length > 0) {
      await session.ref.set(
        { businesses, updatedAt: Timestamp.now() },
        { merge: true },
      );
    }
  }

  let firebaseToken = "";
  let selectedShop = null;
  const selectedShopId = readText(session.data.selectedShopId);
  if (selectedShopId) {
    selectedShop = await resolveSessionBusiness(session, selectedShopId);
    firebaseToken = await createStaffFirebaseToken({
      idKey: session.data.idKey,
      shopId: selectedShopId,
      profile: session.data.user || {},
      role: session.data.role,
    });
  }

  res.json({
    ok: true,
    authenticated: true,
    user: session.data.user || {},
    businesses,
    businessLoadError,
    selectedShop,
    role: session.data.role,
    firebaseToken,
  });
}));

app.post("/staff/select-shop", asyncHandler(async (req, res) => {
  const session = await readConsoleSession(req);
  const shopId = readText(req.body && req.body.shopId);
  if (!shopId) {
    throw httpError(400, "Thieu shopId.");
  }

  const selectedShop = await resolveSessionBusiness(session, shopId);
  await session.ref.set(
    {
      selectedShopId: shopId,
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
  const firebaseToken = await createStaffFirebaseToken({
    idKey: session.data.idKey,
    shopId,
    profile: session.data.user || {},
    role: session.data.role,
  });

  res.json({
    ok: true,
    firebaseToken,
    shop: selectedShop,
    role: session.data.role,
    user: session.data.user || {},
  });
}));

app.post("/staff/logout", asyncHandler(async (req, res) => {
  const sessionId = readCookie(req, consoleSessionCookie);
  if (sessionId) {
    await db.collection("qrStaffSessions").doc(sessionId).delete().catch(() => {});
  }
  clearSessionCookie(res, req);
  res.json({ ok: true });
}));

app.post("/staff/session", asyncHandler(async (req, res) => {
  const idKey = readText(req.body && req.body.idKey);
  const shopId = readText(req.body && req.body.shopId);
  if (!idKey || !shopId) {
    throw httpError(400, "Thieu idKey hoac shopId.");
  }

  const [profile, business] = await Promise.all([
    fizaGet("users/profile", idKey),
    fizaGet(`business/${encodeURIComponent(shopId)}`, idKey),
  ]);
  const businessPayload = payloadOf(business);
  const resolvedShopId = firstText([businessPayload, business], ["id", "id_shop"], shopId);
  if (resolvedShopId !== shopId) {
    throw httpError(403, "Tai khoan khong co quyen voi shop nay.");
  }

  const profilePayload = payloadOf(profile);
  const role = normalizeRole(
    firstText([profilePayload, profile], ["role", "quyen", "phanquyen"], "shop"),
  );
  const firebaseToken = await createStaffFirebaseToken({
    idKey,
    shopId,
    profile: profilePayload,
    role,
  });

  res.json({ ok: true, firebaseToken, uid: firebaseUid(idKey, profilePayload), shopId, role });
}));

app.post("/staff/tables-publish", asyncHandler(async (req, res) => {
  const session = await readConsoleSession(req);
  requireManageConfig(session);
  const shopId = readText(req.body && req.body.shopId, readText(session.data.selectedShopId));
  const rawRange = readText(req.body && (req.body.range || req.body.tableRange));
  const rawTables = Array.isArray(req.body && req.body.tables) ? req.body.tables : [];
  if (!shopId) {
    throw httpError(400, "Thieu shopId.");
  }
  const shop = await resolveSessionBusiness(session, shopId);
  const tableCodes = uniqueCodes([
    ...parseTableCodes(rawRange),
    ...rawTables.map((item) => readText(item && (item.code || item.label || item.id))),
  ]);
  if (tableCodes.length === 0) {
    throw httpError(400, "Nhap day ban hop le, vi du 1-30 hoac A01-A20.");
  }
  if (tableCodes.length > maxTablesPerPublish) {
    throw httpError(400, `Chi publish toi da ${maxTablesPerPublish} ban moi lan.`);
  }

  const published = await publishTables({ shopId, shop, tableCodes });
  res.json({ ok: true, tables: published });
}));

app.post("/staff/menu-publish", asyncHandler(async (req, res) => {
  const session = await readConsoleSession(req);
  requireManageConfig(session);
  const shopId = readText(req.body && req.body.shopId, readText(session.data.selectedShopId));
  if (!shopId) {
    throw httpError(400, "Thieu shopId.");
  }
  const shop = await resolveSessionBusiness(session, shopId);
  const items = await fetchMenuSnapshot(session.data.idKey, shopId, session.data.user || {});
  await publishMenu({ shopId, shop, items });
  res.json({ ok: true, menuItems: items });
}));

app.post("/staff/request-transition", asyncHandler(async (req, res) => {
  const staff = await verifyStaff(req);
  const body = req.body || {};
  const shopId = readText(body.shopId);
  const requestId = readText(body.requestId);
  const action = readText(body.action).toLowerCase();
  if (!shopId || !requestId) {
    throw httpError(400, "Thieu shopId hoac requestId.");
  }
  if (!staff.shopIds[shopId]) {
    throw httpError(403, "Tai khoan khong co quyen voi shop nay.");
  }
  if (!["claim", "complete", "cancel"].includes(action)) {
    throw httpError(400, "Trang thai cap nhat khong hop le.");
  }

  const requestRef = db
    .collection("qrStores")
    .doc(shopId)
    .collection("requests")
    .doc(requestId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(requestRef);
    if (!snap.exists) {
      throw httpError(404, "Khong tim thay yeu cau QR.");
    }
    const request = snap.data() || {};
    const currentStatus = readText(request.status, "pending");
    if (["completed", "cancelled"].includes(currentStatus)) {
      throw httpError(409, "Yeu cau nay da ket thuc.");
    }

    const update = {
      updatedAt: now,
      acceptedBy: staff.uid,
      acceptedByName: staff.name,
    };
    if (action === "claim") {
      if (currentStatus !== "pending") {
        throw httpError(409, "Yeu cau da duoc nhan.");
      }
      update.status = "claimed";
      update.claimedAt = now;
    }
    if (action === "complete") {
      update.status = "completed";
      update.completedAt = now;
      const linkedOrderId = readText(body.linkedOrderId);
      if (linkedOrderId) update.linkedOrderId = linkedOrderId;
    }
    if (action === "cancel") {
      update.status = "cancelled";
      update.cancelledAt = now;
      update.cancelReason = readText(body.reason, "Nhan vien huy yeu cau").slice(0, 240);
    }
    tx.update(requestRef, update);
  });

  res.json({ ok: true });
}));

app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

module.exports = { app };

async function resolveTableToken(token) {
  if (!token || token.length < 16 || token.length > 128) {
    throw httpError(400, "Ma QR khong hop le.");
  }
  const tokenSnap = await db.collection("qrTableTokens").doc(token).get();
  if (!tokenSnap.exists || tokenSnap.get("active") === false) {
    throw httpError(404, "Ma QR khong ton tai hoac da bi tat.");
  }
  const shopId = readText(tokenSnap.get("shopId"));
  const tableId = readText(tokenSnap.get("tableId"));
  if (!shopId || !tableId) {
    throw httpError(404, "Ma QR chua duoc cau hinh dung.");
  }

  const storeRef = db.collection("qrStores").doc(shopId);
  const tableRef = storeRef.collection("tables").doc(tableId);
  const [storeSnap, tableSnap] = await Promise.all([storeRef.get(), tableRef.get()]);
  if (!storeSnap.exists || storeSnap.get("active") === false) {
    throw httpError(404, "Cua hang QR Order dang tam tat.");
  }
  if (!tableSnap.exists || tableSnap.get("active") === false) {
    throw httpError(404, "Ban QR dang tam tat.");
  }
  if (readText(tableSnap.get("token")) !== token) {
    throw httpError(404, "Ma QR da het hieu luc.");
  }

  return {
    shopId,
    tableId,
    store: storeSnap.data() || {},
    table: tableSnap.data() || {},
  };
}

async function normalizeRequestItems(shopId, type, rawItems) {
  if (type !== "order") {
    return [];
  }
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw httpError(400, "Vui long chon it nhat mot mon.");
  }
  if (rawItems.length > 50) {
    throw httpError(400, "Gio hang qua nhieu mon.");
  }

  const menuSnapshot = await db
    .collection("qrStores")
    .doc(shopId)
    .collection("menuItems")
    .get();
  const menuById = new Map(
    menuSnapshot.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]),
  );
  const merged = new Map();
  for (const rawItem of rawItems) {
    const productId = readText(rawItem && (rawItem.productId || rawItem.id));
    const quantity = clampInt(rawItem && rawItem.quantity, 1, 99);
    if (!productId || quantity <= 0) continue;
    const menuItem = menuById.get(productId);
    if (!menuItem || menuItem.visible === false || menuItem.available === false) {
      throw httpError(400, "Mot mon trong gio hang hien khong kha dung.");
    }
    const price = Number(menuItem.price) || 0;
    if (price <= 0) {
      throw httpError(400, "Mot mon trong gio hang chua co gia hop le.");
    }
    const currentQuantity = merged.get(productId)?.quantity || 0;
    const nextQuantity = Math.min(99, currentQuantity + quantity);
    merged.set(productId, {
      productId,
      name: readText(menuItem.name),
      unitLabel: readText(menuItem.unitLabel, "SP"),
      quantity: nextQuantity,
      unitPrice: price,
      total: nextQuantity * price,
      note: readText(rawItem && rawItem.note).slice(0, 160),
    });
  }
  const items = Array.from(merged.values());
  if (items.length === 0) {
    throw httpError(400, "Gio hang khong hop le.");
  }
  return items;
}

async function publishTables({ shopId, shop, tableCodes }) {
  const storeRef = db.collection("qrStores").doc(shopId);
  const tableRefs = tableCodes.map((code) => ({
    code,
    id: normalizeTableId(code),
  }));
  const existingSnaps = await Promise.all(
    tableRefs.map((table) => storeRef.collection("tables").doc(table.id).get()),
  );
  const now = Timestamp.now();
  const published = [];
  const writer = batchedWriter();
  await writer.set(storeRef, {
    active: true,
    name: shop.name || "FizaHUB",
    address: shop.address || "",
    phone: shop.phone || "",
    logoUrl: shop.logoUrl || "",
    updatedAt: now,
  }, { merge: true });

  for (let index = 0; index < tableRefs.length; index += 1) {
    const table = tableRefs[index];
    if (!table.id) continue;
    const existing = existingSnaps[index].exists ? existingSnaps[index].data() || {} : {};
    const token = readText(existing.token) || randomToken(24);
    const qrUrl = `${trimTrailingSlash(process.env.QR_ORDER_WEB_BASE_URL || "https://order.fizahub.vn")}/t/${encodeURIComponent(token)}`;
    const tablePayload = {
      shopId,
      code: table.code,
      label: `Bàn ${table.code}`,
      token,
      qrUrl,
      active: true,
      updatedAt: now,
      createdAt: existing.createdAt || now,
    };
    await writer.set(storeRef.collection("tables").doc(table.id), tablePayload, { merge: true });
    await writer.set(db.collection("qrTableTokens").doc(token), {
      shopId,
      tableId: table.id,
      active: true,
      updatedAt: now,
      createdAt: existing.createdAt || now,
    }, { merge: true });
    published.push({ id: table.id, ...tablePayload });
  }

  await writer.commit();
  return published.sort((left, right) => naturalCompare(left.code, right.code));
}

async function publishMenu({ shopId, shop, items }) {
  const storeRef = db.collection("qrStores").doc(shopId);
  const menuRef = storeRef.collection("menuItems");
  const existing = await menuRef.get();
  const now = Timestamp.now();
  const menuVersion = Date.now();
  const writer = batchedWriter();
  await writer.set(storeRef, {
    active: true,
    name: shop.name || "FizaHUB",
    address: shop.address || "",
    phone: shop.phone || "",
    logoUrl: shop.logoUrl || "",
    menuVersion,
    updatedAt: now,
  }, { merge: true });

  const incomingIds = new Set(items.map((item) => item.id));
  for (const item of items) {
    await writer.set(menuRef.doc(item.id), {
      ...item,
      shopId,
      updatedAt: now,
    }, { merge: true });
  }
  for (const doc of existing.docs) {
    if (!incomingIds.has(doc.id)) {
      await writer.set(doc.ref, { visible: false, available: false, updatedAt: now }, { merge: true });
    }
  }
  await writer.commit();
}

async function resolveBusinessesForSession({ idKey, loginPayload = {}, profilePayload = {} }) {
  const candidates = [];
  let error = "";
  try {
    const businessesResponse = await fizaGet("business", idKey, { page: 1, limit: 10 });
    candidates.push(...businessesFromResponse(businessesResponse));
  } catch (businessError) {
    error = businessError.message || "Khong the tai danh sach cua hang.";
  }

  candidates.push(...businessesFromSource(loginPayload));
  candidates.push(...businessesFromSource(profilePayload));

  const directShopId = firstText(
    [loginPayload, profilePayload],
    ["idshop", "id_shop", "shopId", "shop_id", "idDoanhNghiep", "businessId", "business_id"],
  );
  if (directShopId && candidates.every((item) => item.id !== directShopId)) {
    try {
      const detail = await fizaGet(`business/${encodeURIComponent(directShopId)}`, idKey);
      candidates.push(publicBusiness(payloadOf(detail)));
    } catch (_) {
      candidates.push(businessFromDirectShopFields(loginPayload, profilePayload, directShopId));
    }
  }

  return {
    businesses: uniqueBusinesses(candidates),
    error,
  };
}

function businessesFromResponse(response) {
  const items = listOf(response).map(publicBusiness);
  if (items.length > 0) return items;

  const payload = payloadOf(response);
  const single = publicBusiness(payload);
  return single.id ? [single] : [];
}

function businessesFromSource(source) {
  if (!source || typeof source !== "object") return [];
  const nestedItems = [];
  for (const key of [
    "businesses",
    "business",
    "shops",
    "shop",
    "stores",
    "store",
    "cuahang",
    "cuaHang",
    "doanhNghiep",
    "doanhnghiep",
    "businessInfo",
    "shopInfo",
  ]) {
    const value = source[key];
    if (Array.isArray(value)) {
      nestedItems.push(...value.map(publicBusiness));
    } else if (value && typeof value === "object") {
      nestedItems.push(publicBusiness(value));
    }
  }

  const directShopId = firstText(
    [source],
    ["idshop", "id_shop", "shopId", "shop_id", "idDoanhNghiep", "businessId", "business_id"],
  );
  if (directShopId) {
    nestedItems.push(businessFromDirectShopFields(source, {}, directShopId));
  }

  return nestedItems;
}

function businessFromDirectShopFields(primary, secondary, fallbackId) {
  return {
    id: fallbackId,
    name:
      firstText([primary, secondary], [
        "tenShop",
        "shopName",
        "shop_name",
        "businessName",
        "business_name",
        "tenDoanhNghiep",
        "ten_doanh_nghiep",
        "dn_ten",
        "dnTen",
      ]) || `Cua hang ${fallbackId}`,
    address: firstText([primary, secondary], ["shopAddress", "businessAddress", "diaChiShop", "dn_dc", "dc"]),
    phone: firstText([primary, secondary], ["shopPhone", "businessPhone", "dn_dt", "dt"]),
    logoUrl: firstText([primary, secondary], ["shopLogo", "businessLogo", "logo", "hinh"]),
  };
}

function uniqueBusinesses(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const business = publicBusiness(item);
    if (!business.id || seen.has(business.id)) continue;
    seen.add(business.id);
    result.push(business);
  }
  return result.sort((left, right) => naturalCompare(left.name, right.name));
}

function firebaseAdminOptions() {
  const serviceAccount = localServiceAccount();
  if (serviceAccount) {
    const options = { credential: cert(serviceAccount) };
    const projectId = readText(process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id);
    if (projectId) options.projectId = projectId;
    return options;
  }

  if (readText(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return { credential: applicationDefault() };
  }

  return {};
}

function localServiceAccount() {
  const inlineJson = readText(process.env.QR_ORDER_FIREBASE_SERVICE_ACCOUNT_JSON);
  if (inlineJson) {
    return parseServiceAccountJson(inlineJson, "QR_ORDER_FIREBASE_SERVICE_ACCOUNT_JSON");
  }

  const base64Json = readText(process.env.QR_ORDER_FIREBASE_SERVICE_ACCOUNT_BASE64);
  if (base64Json) {
    return parseServiceAccountJson(
      Buffer.from(base64Json, "base64").toString("utf8"),
      "QR_ORDER_FIREBASE_SERVICE_ACCOUNT_BASE64",
    );
  }

  const keyPath = readText(process.env.QR_ORDER_FIREBASE_SERVICE_ACCOUNT_PATH);
  if (keyPath) {
    return parseServiceAccountJson(
      fs.readFileSync(keyPath, "utf8"),
      "QR_ORDER_FIREBASE_SERVICE_ACCOUNT_PATH",
    );
  }

  return null;
}

function parseServiceAccountJson(rawValue, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (_) {
    throw new Error(`${sourceName} khong phai JSON service account hop le.`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(`${sourceName} thieu client_email hoac private_key.`);
  }
  return parsed;
}

async function fetchMenuSnapshot(idKey, shopId, user) {
  const response = await fizaGet("warehouse", idKey, {
    search: "",
    limit: 300,
    page: 1,
    idshop: shopId,
  });
  const canSellWithoutStock = parseNoKho(firstValue([user], ["noKho", "nokho"]));
  const merged = new Map();
  for (const raw of listOf(response)) {
    if (!raw || typeof raw !== "object") continue;
    const productId = firstText([raw], ["idsp", "productId", "idSanPham"], firstText([raw], ["id"]));
    const name = firstText([raw], ["tenSanPham", "tensanpham", "ten", "name"]);
    if (!productId || !name) continue;
    const salePrice = firstInt([raw], ["giaBan", "giaban", "salePrice", "sale_price", "gia"]);
    const purchasePrice = firstInt([raw], ["giaNhap", "gianhap", "purchasePrice", "purchase_price"]);
    const price = salePrice > 0 ? salePrice : purchasePrice;
    if (price <= 0) continue;
    const previous = merged.get(productId) || {};
    const quantity = previous.quantity || 0;
    const nextQuantity = quantity + firstInt([raw], ["soLuong", "tonKho", "tonkho", "stock", "quantity", "soluong"]);
    merged.set(productId, {
      id: productId,
      name,
      price,
      imageUrl: firstText([raw], ["hinh", "image", "imageUrl", "thumbnail"], previous.imageUrl || ""),
      unitLabel: firstText([raw], ["donvi", "donVi", "unit", "unitLabel"], previous.unitLabel || "SP"),
      visible: true,
      available: canSellWithoutStock || nextQuantity > 0,
      quantity: nextQuantity,
    });
  }

  return Array.from(merged.values())
    .map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      imageUrl: item.imageUrl || "",
      unitLabel: item.unitLabel || "SP",
      visible: true,
      available: item.available === true,
    }))
    .sort((left, right) => readText(left.name).localeCompare(readText(right.name)));
}

async function verifyStaff(req) {
  const authorization = readText(req.get("authorization"));
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw httpError(401, "Thieu Firebase token.");
  }
  const decoded = await auth.verifyIdToken(match[1]);
  return {
    uid: decoded.uid,
    name: readText(decoded.fizaUserName, "Nhan vien"),
    role: readText(decoded.fizaRole, "staff"),
    shopIds: decoded.fizaShopIds || {},
  };
}

async function readConsoleSession(req, { optional = false } = {}) {
  const sessionId = readCookie(req, consoleSessionCookie);
  if (!sessionId) {
    if (optional) return null;
    throw httpError(401, "Chua dang nhap QR console.");
  }
  const ref = db.collection("qrStaffSessions").doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) {
    if (optional) return null;
    throw httpError(401, "Phien QR console da het han.");
  }
  const data = snap.data() || {};
  const expiresAt = timestampMillis(data.expiresAt);
  if (expiresAt > 0 && Date.now() > expiresAt) {
    await ref.delete().catch(() => {});
    if (optional) return null;
    throw httpError(401, "Phien QR console da het han.");
  }
  return { id: sessionId, ref, data };
}

async function resolveSessionBusiness(session, shopId) {
  const businesses = Array.isArray(session.data.businesses) ? session.data.businesses : [];
  const fromSession = businesses.find((item) => readText(item.id) === shopId);
  if (fromSession) return fromSession;

  const detail = await fizaGet(`business/${encodeURIComponent(shopId)}`, session.data.idKey);
  const business = publicBusiness(payloadOf(detail));
  if (!business.id || business.id !== shopId) {
    throw httpError(403, "Tai khoan khong co quyen voi shop nay.");
  }
  return business;
}

function requireManageConfig(session) {
  const role = readText(session.data.role, "staff");
  if (!["shop", "owner", "manager", "admin", "web_admin"].includes(role)) {
    throw httpError(403, "Tai khoan nay khong co quyen cau hinh QR.");
  }
}

async function createStaffFirebaseToken({ idKey, shopId, profile, role }) {
  return auth.createCustomToken(firebaseUid(idKey, profile), {
    fizaShopIds: { [shopId]: true },
    fizaRole: normalizeRole(role || firstText([profile], ["role", "quyen", "phanquyen"], "shop")),
    fizaUserName: firstText([profile], ["ten", "name", "fullname", "phone"], "Nhan vien").slice(0, 80),
  });
}

function firebaseUid(idKey, profile) {
  const userIdentity =
    firstText([profile], ["id", "user_id", "uid", "dt", "phone"]) || sha256(idKey).slice(0, 32);
  return `fiza_${sha256(userIdentity).slice(0, 40)}`;
}

async function fizaGet(path, idKey, query = {}) {
  return fizaRequest("GET", path, { idKey, query });
}

async function fizaPost(path, idKey, body = {}) {
  return fizaRequest("POST", path, { idKey, body });
}

async function fizaRequest(method, path, { idKey = "", query = {}, body = {} } = {}) {
  const baseUrl = trimTrailingSlash(process.env.FIZA_API_BASE_URL || process.env.SMTRADE_API_BASE_URL || "");
  const apiKey = process.env.FIZA_API_KEY || process.env.SMTRADE_API_KEY || "";
  if (!baseUrl || !apiKey) {
    throw httpError(500, "Chua cau hinh FIZA_API_BASE_URL/FIZA_API_KEY cho Functions.");
  }

  const url = new URL(path.replace(/^\/+/, ""), `${baseUrl}/`);
  for (const [key, value] of Object.entries(query || {})) {
    const normalized = readText(value);
    if (normalized) url.searchParams.set(key, normalized);
  }
  const headers = {
    Accept: "application/json",
    "X-API-KEY": apiKey,
  };
  if (readText(idKey)) headers["X-ID-Key"] = readText(idKey);
  const options = { method, headers };
  if (method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(stringFields(body));
  }

  debugFizaRequest({ method, url, headers });
  const response = await fetch(url, options);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    throw httpError(502, "FizaHUB API tra ve du lieu khong hop le.");
  }
  debugFizaResponse({ method, url, response, json });
  if (!response.ok || isFailureResponse(json)) {
    throw httpError(
      response.status || 502,
      firstText([json], ["message", "msg", "error"], "FizaHUB API tu choi yeu cau."),
    );
  }
  return json;
}

function publicStore(store) {
  return {
    name: readText(store.name, "FizaHUB"),
    address: readText(store.address),
    phone: readText(store.phone),
    logoUrl: readText(store.logoUrl),
    menuVersion: store.menuVersion || 0,
  };
}

function publicMenuItem(item) {
  return {
    id: item.id,
    name: readText(item.name),
    price: Number(item.price) || 0,
    imageUrl: readText(item.imageUrl),
    unitLabel: readText(item.unitLabel, "SP"),
    available: item.available !== false,
    visible: item.visible !== false,
  };
}

function publicBusiness(source) {
  return {
    id: firstText([source], [
      "id",
      "id_shop",
      "idshop",
      "shopId",
      "shop_id",
      "idDoanhNghiep",
      "businessId",
      "business_id",
    ]),
    name: firstText([source], [
      "ten",
      "name",
      "tenShop",
      "shopName",
      "shop_name",
      "businessName",
      "business_name",
      "tenDoanhNghiep",
      "dn_ten",
    ], "FizaHUB"),
    address: firstText([source], ["diaChi", "dc", "address", "dn_dc", "shopAddress", "businessAddress"]),
    phone: firstText([source], ["dienThoai", "dienthoai", "dt", "phone", "sdt"]),
    logoUrl: firstText([source], ["hinh", "image", "logo", "imageUrl"]),
  };
}

function publicUser(profile, role) {
  return {
    id: firstText([profile], ["id", "user_id", "uid"]),
    name: firstText([profile], ["ten", "name", "fullname", "hoten"]),
    phone: firstText([profile], ["dt", "phone", "mobile", "sdt", "dienThoai"]),
    role,
    noKho: parseNoKho(firstValue([profile], ["noKho", "nokho"])),
  };
}

function debugFizaRequest({ method, url, headers }) {
  if (process.env.QR_ORDER_DEBUG_API !== "1") return;
  console.info("[QR Order] Fiza request", {
    method,
    path: `${url.pathname}${url.search}`,
    hasApiKey: Boolean(headers["X-API-KEY"]),
    hasIdKey: Boolean(headers["X-ID-Key"]),
    headerNames: Object.keys(headers),
  });
}

function debugFizaResponse({ method, url, response, json }) {
  if (process.env.QR_ORDER_DEBUG_API !== "1") return;
  console.info("[QR Order] Fiza response", {
    method,
    path: `${url.pathname}${url.search}`,
    status: response.status,
    topLevelKeys: json && typeof json === "object" ? Object.keys(json).slice(0, 12) : [],
    payloadShape: payloadShape(json),
    listCount: listOf(json).length,
  });
}

function payloadShape(value) {
  if (Array.isArray(value)) return `array:${value.length}`;
  if (!value || typeof value !== "object") return typeof value;
  const payload = payloadOf(value);
  if (Array.isArray(payload)) return `payload-array:${payload.length}`;
  if (payload && typeof payload === "object") {
    return `payload-object:${Object.keys(payload).slice(0, 12).join(",")}`;
  }
  return typeof payload;
}

function logStartupConfig() {
  console.info(
    "[QR Order API] config",
    JSON.stringify({
      nodeEnv: readText(process.env.NODE_ENV, "production"),
      hasFizaApiBaseUrl: Boolean(readText(process.env.FIZA_API_BASE_URL || process.env.SMTRADE_API_BASE_URL)),
      hasFizaApiKey: Boolean(readText(process.env.FIZA_API_KEY || process.env.SMTRADE_API_KEY)),
      hasFirebaseServiceAccount: Boolean(
        readText(process.env.QR_ORDER_FIREBASE_SERVICE_ACCOUNT_JSON) ||
          readText(process.env.QR_ORDER_FIREBASE_SERVICE_ACCOUNT_BASE64) ||
          readText(process.env.QR_ORDER_FIREBASE_SERVICE_ACCOUNT_PATH) ||
          readText(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      ),
      webBaseUrl: readText(process.env.QR_ORDER_WEB_BASE_URL, "https://order.fizahub.vn"),
      corsOrigins: configuredCorsOrigins.length > 0 ? configuredCorsOrigins : ["*"],
      cookieSameSite: readText(process.env.QR_ORDER_COOKIE_SAMESITE) || "auto",
    }),
  );
}

function requestLogger(req, res, next) {
  if (req.path === "/healthz" && !readText(req.get("origin"))) {
    next();
    return;
  }

  const startedAt = Date.now();
  const requestId = readText(req.get("x-request-id")) || crypto.randomUUID();
  res.setHeader("x-qr-request-id", requestId);

  console.info(
    "[QR Order API] request",
    JSON.stringify({
      requestId,
      method: req.method,
      path: req.originalUrl,
      origin: readText(req.get("origin")),
      contentType: readText(req.get("content-type")),
    }),
  );

  res.on("finish", () => {
    console.info(
      "[QR Order API] response",
      JSON.stringify({
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });

  next();
}

function resolveCorsOrigin(origin, callback) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    callback(null, true);
    return;
  }
  if (isCorsAllowedOrigin(normalized)) {
    callback(null, true);
    return;
  }

  console.warn(
    "[QR Order API] cors_denied",
    JSON.stringify({
      origin: normalized,
      allowedOrigins: configuredCorsOrigins,
    }),
  );
  callback(null, false);
}

function isCorsAllowedOrigin(origin) {
  if (configuredCorsOrigins.length === 0) return true;
  if (configuredCorsOrigins.includes("*")) return true;
  return configuredCorsOrigins.includes(normalizeOrigin(origin));
}

function parseCorsOrigins(value) {
  return readText(value)
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function normalizeOrigin(value) {
  return readText(value).replace(/\/+$/, "");
}

function asyncHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.statusCode || error.status || 500;
      if (status === 401) clearSessionCookie(res, req);
      console.error(
        "[QR Order API] error",
        JSON.stringify({
          method: req.method,
          path: req.originalUrl,
          status,
          origin: readText(req.get("origin")),
          message: error.message || "Yeu cau QR Order that bai.",
        }),
      );
      res.status(status).json({
        ok: false,
        message: error.message || "Yeu cau QR Order that bai.",
      });
    }
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function payloadOf(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  for (const key of ["data", "payload", "result", "item"]) {
    const value = json[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return json;
}

function listOf(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of [
    "data",
    "item",
    "items",
    "records",
    "rows",
    "list",
    "result",
    "payload",
    "businesses",
    "business",
    "shops",
    "shop",
    "stores",
    "store",
    "doanhNghiep",
    "doanhnghiep",
  ]) {
    const value = json[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = listOf(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function firstText(sources, keys, fallback = "") {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      const normalized = readText(source[key]);
      if (normalized) return normalized;
    }
  }
  return fallback;
}

function firstValue(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}

function firstInt(sources, keys, fallback = 0) {
  const value = firstValue(sources, keys);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.replace(/[^\d-]/g, ""), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized && normalized !== "null" ? normalized : fallback;
}

function normalizeRequestType(value) {
  const normalized = readText(value).toLowerCase();
  if (["order", "payment", "service"].includes(normalized)) return normalized;
  throw httpError(400, "Loai yeu cau khong hop le.");
}

function normalizeRole(value) {
  const normalized = readText(value, "shop")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
  if (["shop", "owner", "manager", "partner_admin"].includes(normalized)) return "shop";
  if (["staff", "cashier", "sales", "service"].includes(normalized)) return "staff";
  if (normalized === "admin" || normalized === "web_admin") return "admin";
  return normalized || "shop";
}

function normalizeTableId(code) {
  const normalized = readText(code)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || sha256(code).slice(0, 12);
}

function parseTableCodes(value) {
  const result = [];
  const seen = new Set();
  const parts = readText(value)
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const part of parts) {
    const match = part.match(/^([A-Za-z]*)(\d+)\s*-\s*([A-Za-z]*)(\d+)$/);
    if (!match) {
      addUniqueCode(part, result, seen);
      continue;
    }
    const startPrefix = match[1] || "";
    const endPrefix = match[3] || "";
    if (endPrefix && endPrefix.toLowerCase() !== startPrefix.toLowerCase()) {
      addUniqueCode(part, result, seen);
      continue;
    }
    const startRaw = match[2] || "";
    const endRaw = match[4] || "";
    const start = Number.parseInt(startRaw, 10);
    const end = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > maxTablesPerPublish) {
      addUniqueCode(part, result, seen);
      continue;
    }
    const width = Math.max(startRaw.length, endRaw.length);
    for (let number = start; number <= end; number += 1) {
      addUniqueCode(`${startPrefix}${String(number).padStart(width, "0")}`, result, seen);
    }
  }
  return result;
}

function addUniqueCode(code, result, seen) {
  const normalized = normalizeTableId(code);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  result.push(readText(code));
}

function uniqueCodes(codes) {
  const result = [];
  const seen = new Set();
  for (const code of codes) addUniqueCode(code, result, seen);
  return result;
}

function isFailureResponse(json) {
  const errorValue = json && json.error;
  if (errorValue === true) return true;
  if (typeof errorValue === "number") return errorValue !== 0;
  if (typeof errorValue === "string") {
    const normalized = errorValue.trim().toLowerCase();
    return normalized && normalized !== "0" && normalized !== "false";
  }
  return false;
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(min, Math.min(max, parsed));
}

function parseNoKho(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 2;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "2";
  }
  return false;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function trimTrailingSlash(value) {
  return readText(value).replace(/\/+$/, "");
}

function naturalCompare(left, right) {
  return readText(left).localeCompare(readText(right), undefined, { numeric: true, sensitivity: "base" });
}

function stringFields(values) {
  const fields = {};
  for (const [key, value] of Object.entries(values || {})) {
    const normalized = readText(value);
    if (normalized) fields[key] = normalized;
  }
  return fields;
}

function readCookie(req, name) {
  const header = readText(req.get("cookie"));
  if (!header) return "";
  const parts = header.split(";");
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function setSessionCookie(res, sessionId, req) {
  res.setHeader(
    "Set-Cookie",
    `${consoleSessionCookie}=${encodeURIComponent(sessionId)}; HttpOnly; ${sessionCookieAttributes(req)}; Max-Age=${consoleSessionHours * 60 * 60}`,
  );
}

function clearSessionCookie(res, req) {
  res.setHeader(
    "Set-Cookie",
    `${consoleSessionCookie}=; HttpOnly; ${sessionCookieAttributes(req)}; Max-Age=0`,
  );
}

function sessionCookieAttributes(req) {
  const secureRequest = isSecureRequest(req);
  const configuredSameSite = readText(process.env.QR_ORDER_COOKIE_SAMESITE);
  const sameSite = configuredSameSite || (secureRequest ? "None" : "Lax");
  return `SameSite=${sameSite}; Path=/${secureRequest ? "; Secure" : ""}`;
}

function isSecureRequest(req) {
  const forwardedProto = readText(req.get("x-forwarded-proto")).toLowerCase();
  return forwardedProto === "https" || req.secure === true;
}

function batchedWriter() {
  let batch = db.batch();
  let writes = 0;
  const limit = 450;
  return {
    async set(ref, data, options) {
      batch.set(ref, data, options);
      writes += 1;
      if (writes >= limit) {
        await batch.commit();
        batch = db.batch();
        writes = 0;
      }
    },
    async commit() {
      if (writes > 0) {
        await batch.commit();
      }
    },
  };
}
