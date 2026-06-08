const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const IAM_BASE_URL = process.env.IAM_BASE_URL || "https://id.item.com";
const WMS_API_BASE_URL = process.env.WMS_API_BASE_URL || "https://unis.item.com/api";
const SERVICE_USERNAME = process.env.WISE_USERNAME || process.env.WMS_SERVICE_USERNAME || "";
const SERVICE_PASSWORD = process.env.WISE_PASSWORD || process.env.WMS_SERVICE_PASSWORD || "";
const CACHE_TTL_MS = 10 * 60 * 1000;
const ORDER_STATUSES = ["PLANNED"];
const DROPSHIP_ANY_STATUS = [
  "IMPORTED",
  "OPEN",
  "COMMITTED",
  "COMMIT_FAILED",
  "COMMIT_BLOCKED",
  "PLANNED",
  "PLANNING",
  "PICKING",
  "PICKED",
  "PACKING",
  "PACKED",
  "STAGED",
  "LOADING",
  "LOADED",
  "PARTIAL_SHIPPED",
  "SHIPPED",
  "SHORT_SHIPPED",
  "CANCELLED",
];

const orgNameCache = new Map();
let lastSession = null;

const liveCache = {
  dashboard: null,
  assignees: null,
  assignmentSuggestions: null,
  updatedAt: null,
  nextRefreshAt: null,
  error: null,
  refreshing: false,
};

function readSavedJson(filename) {
  try {
    const fullPath = path.join(__dirname, filename);
    if (!fs.existsSync(fullPath)) return null;
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (_) {
    return null;
  }
}

const seenTaskIds = new Set();
let autoAssignEnabled = true;
const ASSIGN_ENDPOINT_VERIFIED = true;

function taskKey(suggestion) {
  return suggestion.orderNumber || suggestion.rn || "";
}

async function refreshLiveCache() {
  if (!SERVICE_USERNAME || !SERVICE_PASSWORD) {
    liveCache.error = "Service credentials not configured.";
    return;
  }
  if (liveCache.refreshing) return;
  liveCache.refreshing = true;
  try {
    const session = await login(SERVICE_USERNAME, SERVICE_PASSWORD);
    const [dashboard, assignees, suggestionResult] = await Promise.all([
      fetchDashboard(session),
      fetchCottonAssignees(session),
      fetchAssignmentSuggestions(session),
    ]);
    liveCache.dashboard = dashboard;
    liveCache.assignees = assignees;

    const assignmentSuggestions = suggestionResult;
    const allSuggestions = assignmentSuggestions.suggestions || [];
    const newSuggestions = [];
    for (const s of allSuggestions) {
      const key = taskKey(s);
      if (key && !seenTaskIds.has(key)) {
        newSuggestions.push(s);
      }
    }
    for (const s of allSuggestions) {
      const key = taskKey(s);
      if (key) seenTaskIds.add(key);
    }

    liveCache.assignmentSuggestions = {
      ...assignmentSuggestions,
      suggestions: allSuggestions,
      newSuggestions,
      newCount: newSuggestions.length,
      totalCount: allSuggestions.length,
      lookbackMonths: assignmentSuggestions.lookbackMonths || 6,
      plannedOrders: assignmentSuggestions.plannedOrders || 0,
      inboundRns: assignmentSuggestions.inboundRns || 0,
      autoAssignEnabled,
      assignEndpointVerified: ASSIGN_ENDPOINT_VERIFIED,
    };

    liveCache.updatedAt = new Date().toISOString();
    liveCache.nextRefreshAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
    liveCache.error = null;
    console.log(`[${new Date().toISOString()}] Live cache refreshed. ${allSuggestions.length} suggestions (${newSuggestions.length} new).`);
  } catch (err) {
    liveCache.error = err instanceof Error ? err.message : "Failed to refresh live data.";
    console.error(`[${new Date().toISOString()}] Live cache refresh failed: ${liveCache.error}`);
  } finally {
    liveCache.refreshing = false;
  }
}

function ensureLiveCacheFresh() {
  if (!SERVICE_USERNAME || !SERVICE_PASSWORD) return;
  const age = liveCache.updatedAt ? Date.now() - new Date(liveCache.updatedAt).getTime() : Infinity;
  if (age >= CACHE_TTL_MS) {
    refreshLiveCache();
  }
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || "").split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeName(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function normalizeWiseCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isFullToOffloadContainer(row) {
  const type = normalizeWiseCode(row.equipmentType || row.type || "");
  const status = normalizeWiseCode(row.equipmentStatus || row.status || "");
  const detail = normalizeWiseCode(row.equipmentOperationStatus || row.details || row.operationStatus || "");
  return type === "CONTAINER" && status === "FULL" && detail === "FULL_TO_OFFLOAD";
}

function pickCottonFacility(facilities) {
  return facilities.find((f) => normalizeName(`${f.name} ${f.id}`).includes("COTTON")) || null;
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code != null && String(json.code) !== "0")) {
    throw new Error(json.msg || json.message || `API request failed: ${res.status}`);
  }
  return json.data ?? json;
}

async function login(username, password) {
  const iam = await apiFetch(`${IAM_BASE_URL}/auth/exchange-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "password", username, password }),
  });
  const accessToken = iam.access_token || iam.accessToken;
  const refreshToken = iam.refresh_token || iam.refreshToken;
  const expiresIn = iam.expires_in || iam.expiresIn || 3600;
  if (!accessToken) throw new Error("Sign in failed.");

  const payload = decodeJwtPayload(accessToken);
  const identity = payload?.data || iam.identity || {};
  const userId = String(identity.user_id || "");
  const tenantId = String(identity.tenant_id || identity.company_code || "");
  if (!userId || !tenantId) throw new Error("Warehouse access could not be loaded.");

  const profile = await apiFetch(`${WMS_API_BASE_URL}/wms-bam/user/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "x-tenant-id": tenantId },
  });
  const facilities = profile.profile?.facilities || [];
  const cottonFacility = pickCottonFacility(facilities);
  if (!cottonFacility) {
    throw new Error("No WISE facility with Cotton in the facility name or ID was found on this account.");
  }

  const session = {
    accessToken,
    refreshToken,
    expiresIn,
    identity: { user_id: userId, user_name: identity.user_name || username, tenant_id: tenantId },
    cottonFacility,
    cottonMatches: facilities.filter((f) => normalizeName(`${f.name} ${f.id}`).includes("COTTON")),
  };
  lastSession = session;
  return session;
}

function wmsHeaders(session, facility) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "x-tenant-id": session.identity.tenant_id,
    "x-facility-id": facility.id,
    "item-time-zone": facility.timeZone || "America/Los_Angeles",
    "content-type": "application/json",
  };
}

async function fetchOrderPage(headers, body) {
  const data = await apiFetch(`${WMS_API_BASE_URL}/wms/outbound/order/search-by-paging`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const orders = data.list || data.records || data || [];
  return {
    orders: Array.isArray(orders) ? orders : [],
    total: Number(data.total || 0),
  };
}

async function fetchAllOrderPages(headers, body, pageSize = 500) {
  const orders = [];
  const seen = new Set();
  let total = 0;
  for (let currentPage = 1; currentPage <= 50; currentPage += 1) {
    const page = await fetchOrderPage(headers, { ...body, currentPage, page: currentPage, pageSize });
    total = page.total || total;
    for (const order of page.orders) {
      const key = order.id || order.orderNumber || JSON.stringify(order);
      if (!seen.has(key)) {
        seen.add(key);
        orders.push(order);
      }
    }
    if (page.orders.length < pageSize) break;
    if (total && orders.length >= total) break;
  }
  return orders;
}

async function fetchOrdersAcrossStatuses(headers, baseBody, statuses) {
  const merged = [];
  const seen = new Set();
  for (const status of statuses) {
    try {
      const rows = await fetchAllOrderPages(headers, { ...baseBody, statuses: [status] });
      for (const row of rows) {
        const key = row.id || row.orderNumber || JSON.stringify(row);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(row);
        }
      }
    } catch {
      // Some WISE tenants reject certain status names. Skip invalid statuses so
      // the dashboard can still load and count the statuses WISE accepts.
    }
  }
  return merged;
}

async function fetchYardEquipmentPage(headers, body) {
  const data = await apiFetch(`${WMS_API_BASE_URL}/wms-bam/yard/equipment/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const rows = data.list || data.records || data || [];
  return {
    rows: Array.isArray(rows) ? rows : [],
    total: Number(data.total || 0),
  };
}

async function fetchAllYardEquipment(headers, pageSize = 500) {
  const rows = [];
  for (let currentPage = 1; currentPage <= 30; currentPage += 1) {
    const page = await fetchYardEquipmentPage(headers, {
      currentPage,
      page: currentPage,
      pageSize,
      statuses: ["FULL"],
    });
    rows.push(...page.rows);
    if (page.rows.length < pageSize) break;
    if (page.total && rows.length >= page.total) break;
  }
  return rows;
}

async function resolveOrgName(orgId, session) {
  if (!orgId || !String(orgId).startsWith("ORG-")) return orgId || "";
  if (orgNameCache.has(orgId)) return orgNameCache.get(orgId);
  try {
    const data = await apiFetch(`${WMS_API_BASE_URL}/mdm/organization/${encodeURIComponent(orgId)}`, {
      headers: { Authorization: `Bearer ${session.accessToken}`, "x-tenant-id": session.identity.tenant_id },
    });
    const name = data.name || data.orgName || orgId;
    orgNameCache.set(orgId, name);
    return name;
  } catch {
    orgNameCache.set(orgId, orgId);
    return orgId;
  }
}

async function resolveOrgNames(orgIds, session) {
  const pairs = await Promise.all([...new Set(orgIds.filter(Boolean))].map(async (id) => [id, await resolveOrgName(id, session)]));
  return Object.fromEntries(pairs);
}

function numericValue(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNumericField(row, fields) {
  for (const field of fields) {
    const value = numericValue(row?.[field]);
    if (value) return value;
  }
  return 0;
}

function lineQuantity(line) {
  return firstNumericField(line, [
    "baseQty",
    "baseQuantity",
    "base_qty",
    "orderQty",
    "orderedQty",
    "plannedQty",
    "totalQty",
    "itemLineTotalQty",
    "estPiecePickQty",
    "expectedQty",
    "qty",
    "quantity",
    "unitQty",
    "eaQty",
    "pieceQty",
  ]);
}

function orderBaseQty(order) {
  const direct = firstNumericField(order, [
    "baseQty",
    "baseQuantity",
    "base_qty",
    "orderQty",
    "orderedQty",
    "plannedQty",
    "totalQty",
    "itemLineTotalQty",
    "estPiecePickQty",
    "expectedQty",
    "qty",
    "quantity",
    "unitQty",
    "eaQty",
    "pieceQty",
  ]);
  if (direct) return direct;

  const lineCollections = [
    order.itemLines,
    order.orderLines,
    order.details,
    order.skuLines,
    order.productLines,
    order.simpleItemLines,
    order.items,
  ].filter(Array.isArray);
  for (const lines of lineCollections) {
    const sum = lines.reduce((total, line) => total + lineQuantity(line), 0);
    if (sum) return sum;
  }

  return 0;
}

function mapEquipment(row) {
  return {
    equipmentNumber: row.equipmentNo || row.equipmentNumber || row.barcode || row.id || "",
    entryTicket: row.checkInEntry || row.entryTicket || row.entryId || row.lastEntryId || row.receiptNo || row.receiptNumber || row.rn || row.receivingNo || "",
    checkIn: row.gateCheckInTime || row.checkIn || row.checkInTime || row.createdTime || "",
    timeInYard: row.inYardTime || row.timeInYard || "",
    customer: row.customerName || row.customer?.name || row.customerId || row.customer?.id || "Unknown",
    location: row.locationName || row.location || "",
    status: row.equipmentStatus || row.status || "",
    details: row.equipmentOperationStatus || row.details || "",
    equipmentType: row.equipmentType || row.type || "",
  };
}

function mapOrder(order, orgNames) {
  const customerId = order.customerId || order.customer?.id || order.customer?.organizationId || "";
  const carrierId = order.carrierId || "";
  const retailerId = order.retailerId || "";
  return {
    orderNumber: order.id || order.orderNumber || "",
    customer: orgNames[customerId] || order.customerName || order.customer?.name || customerId || "Unknown",
    customerId,
    status: order.status || "",
    reference: order.referenceNo || order.poNo || "",
    created: order.createdTime || "",
    shipMethod: order.shipMethod || "",
    carrier: orgNames[carrierId] || carrierId || "",
    carrierId,
    scheduleDate: order.scheduleDate || "",
    mabd: order.mabd || order.shipNoLater || "",
    appointmentTime: order.appointmentTime || order.scheduleDate || "",
    retailerName: orgNames[retailerId] || retailerId || "",
    orderType: order.orderType || "",
    source: order.source || "",
    baseQty: orderBaseQty(order),
    palletQty: Number(order.palletQty ?? order.estPalletPickQty ?? 0) || 0,
    po: order.poNo || order.referenceNo || "",
    so: Array.isArray(order.soNos) ? order.soNos.join(", ") : (order.soNos || order.soNo || ""),
    loadNo: order.loadNo || "",
    shipToName: order.shipToAddress?.name || order.shipToName || "",
  };
}

function buildPivot(rows) {
  const byCustomer = new Map();
  for (const row of rows) {
    const name = row.customer || "Unknown";
    if (!byCustomer.has(name)) byCustomer.set(name, { customer: name, orderCount: 0, baseQty: 0 });
    const item = byCustomer.get(name);
    item.orderCount += 1;
    item.baseQty += row.baseQty || 0;
  }
  return [...byCustomer.values()].sort((a, b) => b.orderCount - a.orderCount || a.customer.localeCompare(b.customer));
}

function buildWatchList(rows) {
  const watchStatuses = new Set(["COMMIT_BLOCKED", "COMMIT_FAILED", "PICKING", "PARTIAL_SHIPPED"]);
  return rows
    .filter((r) => watchStatuses.has(String(r.status || "").toUpperCase()))
    .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")))
    .slice(0, 25);
}

function isDropshipOrder(row) {
  const type = normalizeName(row.orderType || row.order_type || row.orderTypeName || "");
  return type === "DS" || type === "DROPSHIP" || type.includes("DROP SHIP");
}

function orderAgeHours(row, now = Date.now()) {
  const created = new Date(row.created || row.createdTime || row.orderCreateDate || 0).getTime();
  if (Number.isNaN(created) || !created) return null;
  return Math.floor((now - created) / 36e5);
}

function collectQuantityHints(orders) {
  const hints = new Set();
  const names = /qty|quantity|piece|unit|base/i;
  for (const order of orders.slice(0, 30)) {
    for (const key of Object.keys(order || {})) {
      if (names.test(key)) hints.add(key);
    }
    for (const collectionName of ["itemLines", "orderLines", "details", "skuLines", "productLines", "simpleItemLines", "items"]) {
      const lines = order?.[collectionName];
      if (!Array.isArray(lines) || !lines[0]) continue;
      for (const key of Object.keys(lines[0])) {
        if (names.test(key)) hints.add(`${collectionName}.${key}`);
      }
    }
  }
  return [...hints].sort().slice(0, 25);
}

async function fetchDashboard(session) {
  lastSession = session;
  const facility = session.cottonFacility;
  const headers = wmsHeaders(session, facility);
  const base = {
    currentPage: 1,
    pageSize: 500,
    statuses: ORDER_STATUSES,
    sortingFields: [{ field: "createdTime", orderBy: "DESC" }],
  };
  const dropshipBase = {
    currentPage: 1,
    pageSize: 500,
    sortingFields: [{ field: "createdTime", orderBy: "DESC" }],
  };
  const [orders, equipment, dropshipOrders] = await Promise.all([
    fetchAllOrderPages(headers, base),
    fetchAllYardEquipment(headers),
    fetchOrdersAcrossStatuses(headers, dropshipBase, DROPSHIP_ANY_STATUS),
  ]);

  const orgIds = new Set();
  for (const order of [...orders, ...dropshipOrders]) {
    if (order.customerId) orgIds.add(order.customerId);
    if (order.customer?.id) orgIds.add(order.customer.id);
    if (order.customer?.organizationId) orgIds.add(order.customer.organizationId);
    if (order.carrierId) orgIds.add(order.carrierId);
    if (order.retailerId) orgIds.add(order.retailerId);
  }
  const orgNames = await resolveOrgNames([...orgIds], session);
  const rows = orders.map((order) => mapOrder(order, orgNames));
  const inYardRows = equipment.filter(isFullToOffloadContainer).map(mapEquipment);
  const pivotRows = buildPivot(rows);
  const watchList = buildWatchList(rows);
  const baseQty = rows.reduce((sum, row) => sum + (row.baseQty || 0), 0);
  const plannedDropshipOrders = new Set(
    rows
      .filter(isDropshipOrder)
      .map((row) => row.orderNumber)
      .filter(Boolean)
  );
  const nowMs = Date.now();
  const olderThan48Rows = rows.filter((row) => !isDropshipOrder(row) && (orderAgeHours(row, nowMs) ?? 0) >= 48);
  const dropshipRows = dropshipOrders.map((order) => mapOrder(order, orgNames)).filter(isDropshipOrder);
  const customerMap = new Map();
  for (const row of [...rows, ...dropshipRows]) {
    const name = row.customer || "Unknown";
    const current = customerMap.get(name) || { customer: name, orderCount: 0 };
    current.orderCount += 1;
    customerMap.set(name, current);
  }
  const customerRows = [...customerMap.values()].sort((a, b) => b.orderCount - a.orderCount || a.customer.localeCompare(b.customer));
  const dropshipOlderThan24Rows = rows.filter((row) => isDropshipOrder(row) && (orderAgeHours(row, nowMs) ?? 0) >= 24);
  const dropshipUniqueOrders = new Set(
    dropshipRows.map((row) => row.orderNumber).filter(Boolean)
  );
  const dropshipOlderThan24Orders = new Set(
    dropshipOlderThan24Rows.map((row) => row.orderNumber).filter(Boolean)
  );
  const plannedDropshipCount = plannedDropshipOrders.size || rows.filter(isDropshipOrder).length;
  const allStatusDropshipCount = dropshipUniqueOrders.size || dropshipRows.length;
  const dropshipOlderThan24Count = dropshipOlderThan24Orders.size || dropshipOlderThan24Rows.length;
  const quantityHints = collectQuantityHints(orders);
  const result = {
    title: "Cotton",
    siteLabel: `${facility.name} (${facility.id})`,
    source: "WISE",
    refreshedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    facility,
    metrics: [
      { label: "In-Yard FULL Equipment", value: inYardRows.length, sub: "not yet devanned" },
      { label: "Customers", value: customerRows.length, sub: "Cotton facility" },
      { label: "Planned FTL/LTL Orders", value: rows.length, sub: "All customers" },
      { label: "Older than 48 hours", value: olderThan48Rows.length, sub: "Pending non-Dropship" },
      { label: "E-Comm Orders", value: plannedDropshipCount, sub: "Planned Orders" },
      { label: "E-Comm Past SLA", value: dropshipOlderThan24Count, sub: "Planned Orders" },
    ],
    inYardFullEquipment: { supported: true, rows: inYardRows, candidateCount: inYardRows.length },
    pivot: { supported: true, rows: pivotRows },
    watchList: { supported: true, rows: watchList },
    detailRows: rows,
    dropshipOlderThan24Rows,
    customerRows,
    diagnostics: [
      { label: "Facility filter", value: "Cotton" },
      { label: "WISE endpoint", value: "/wms/outbound/order/search-by-paging" },
      { label: "Statuses", value: ORDER_STATUSES.join(", ") },
      { label: "Customer filter", value: "All Cotton customers" },
      { label: "Equipment logic", value: "CONTAINER + FULL + FULL_TO_OFFLOAD" },
      { label: "E-Comm planned order count", value: `${plannedDropshipCount} unique PLANNED DS orders` },
      { label: "Older than 48 hours", value: `${olderThan48Rows.length} pending non-Dropship orders` },
      { label: "DS older than 24 hours", value: `${dropshipOlderThan24Count} unique PLANNED DS orders` },
      { label: "All-status DS order count", value: `${allStatusDropshipCount} unique DS orders` },
      { label: "All-status DS row count", value: String(dropshipRows.length) },
      { label: "Raw dropship query rows", value: String(dropshipOrders.length) },
      { label: "Quantity fields found", value: quantityHints.length ? quantityHints.join(", ") : "None in first 30 orders" },
      { label: "Raw order rows", value: String(orders.length) },
    ],
  };
  try {
    fs.writeFileSync(path.join(__dirname, "last-dashboard.json"), JSON.stringify(result, null, 2));
  } catch {}
  return result;
}

function pickAssigneeName(task) {
  return (
    task.assigneeUserName ||
    task.assigneeName ||
    task.assignee ||
    task.assignedUserName ||
    task.userName ||
    task.operatorName ||
    ""
  );
}

function pickTaskCustomer(task) {
  const names = task.customerNames || task.customerName || task.customer || task.customerNameList || task.ownerName || task.owner || task.organizationName || "";
  if (Array.isArray(names)) return String(names[0] || "").trim();
  if (typeof names === "object" && names) return String(names.name || names.customerName || "").trim();
  return String(names || "").trim();
}

function pickOffloaderName(task) {
  return (
    task.offloaderUserName ||
    task.offloaderName ||
    task.devannedByUserName ||
    task.devannedBy ||
    task.unloadedByUserName ||
    task.unloadedBy ||
    task.receiverUserName ||
    task.receiverName ||
    task.assigneeUserName ||
    task.assigneeName ||
    task.operatorName ||
    ""
  );
}


function pickAssigneeUserId(task) {
  return String(
    task.assigneeUserId ||
    task.assigneeId ||
    task.assignedUserId ||
    task.userId ||
    task.operatorId ||
    task.receiverUserId ||
    task.offloaderUserId ||
    ""
  ).trim();
}

function rememberAssigneeUser(userMap, name, userId) {
  const key = normalizeName(name);
  if (key && userId && !userMap.has(key)) userMap.set(key, String(userId));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function taskOrderCount(task) {
  if (Array.isArray(task.orderIds) && task.orderIds.length) return task.orderIds.length;
  if (Array.isArray(task.receiptIds) && task.receiptIds.length) return task.receiptIds.length;
  if (Array.isArray(task.receiptNos) && task.receiptNos.length) return task.receiptNos.length;
  if (task.orderId || task.orderNumber || task.outboundOrderId || task.receiptId || task.receiptNo || task.receiptNumber || task.rn || task.inboundOrderId) return 1;
  return 1;
}

function taskStatusBucket(task) {
  const status = normalizeName(task.status || task.taskStatus || task.pickStatus || "");
  if (
    status.includes("COMPLETE") ||
    status.includes("COMPLETED") ||
    status.includes("DONE") ||
    status.includes("PICKED") ||
    status.includes("CLOSED") ||
    status.includes("FINISHED")
  ) {
    return "completed";
  }
  if (status.includes("CANCEL")) return "ignored";
  return "working";
}

function isPackedTask(task) {
  const status = normalizeName(task.status || task.taskStatus || task.pickStatus || task.packStatus || "");
  return (
    status.includes("PACKED") ||
    status.includes("COMPLETE") ||
    status.includes("COMPLETED") ||
    status.includes("DONE") ||
    status.includes("CLOSED") ||
    status.includes("FINISHED")
  );
}

async function fetchPickTasks(headers, lookbackStart, now, pageSize = 1000) {
  const tasks = [];
  for (let currentPage = 1; currentPage <= 25; currentPage += 1) {
    const data = await apiFetch(`${WMS_API_BASE_URL}/wms-bam/outbound/pick-task/search-by-paging`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        page: currentPage,
        currentPage,
        pageSize,
        createdTimeStart: lookbackStart.toISOString(),
        createdTimeEnd: now.toISOString(),
      }),
    });
    const pageRows = data.list || data.records || data || [];
    if (!Array.isArray(pageRows) || !pageRows.length) break;
    tasks.push(...pageRows);
    if (pageRows.length < pageSize) break;
    if (Number(data.total || 0) && tasks.length >= Number(data.total || 0)) break;
  }
  return tasks;
}

async function fetchPagedTaskEndpoint(headers, endpoint, lookbackStart, now, pageSize = 1000) {
  const tasks = [];
  for (let currentPage = 1; currentPage <= 25; currentPage += 1) {
    const data = await apiFetch(`${WMS_API_BASE_URL}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        page: currentPage,
        currentPage,
        pageSize,
        createdTimeStart: lookbackStart.toISOString(),
        createdTimeEnd: now.toISOString(),
      }),
    });
    const pageRows = data.list || data.records || data || [];
    if (!Array.isArray(pageRows) || !pageRows.length) break;
    tasks.push(...pageRows);
    if (pageRows.length < pageSize) break;
    if (Number(data.total || 0) && tasks.length >= Number(data.total || 0)) break;
  }
  return tasks;
}

async function fetchOffloadTasks(headers, lookbackStart, now) {
  const endpoints = [
    "/wms-bam/inbound/offload-task/search-by-paging",
    "/wms-bam/inbound/receive-task/search-by-paging",
    "/wms-bam/inbound/receiving-task/search-by-paging",
    "/wms-bam/inbound/unload-task/search-by-paging",
    "/wms-bam/yard/equipment/search",
  ];
  const merged = [];
  const seen = new Set();
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const rows = await fetchPagedTaskEndpoint(headers, endpoint, lookbackStart, now);
      for (const row of rows) {
        const key = row.id || row.taskId || row.receiptId || row.receiptNo || row.equipmentNo || JSON.stringify(row);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push({ ...row, _sourceEndpoint: endpoint });
        }
      }
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  return { tasks: merged, errors };
}

function isOffloadedTask(task) {
  const status = normalizeName(task.status || task.taskStatus || task.receiveStatus || task.equipmentOperationStatus || task.details || "");
  if (!status) return Boolean(pickOffloaderName(task));
  return (
    status.includes("OFFLOAD") ||
    status.includes("OFFLOADED") ||
    status.includes("DEVANNED") ||
    status.includes("UNLOADED") ||
    status.includes("RECEIVED") ||
    status.includes("COMPLETE") ||
    status.includes("COMPLETED") ||
    status.includes("DONE") ||
    status.includes("CLOSED") ||
    status.includes("EMPTY")
  );
}

function mapInboundRn(row) {
  return {
    rn: row.entryTicket || row.receiptNo || row.receiptNumber || row.rn || row.equipmentNumber || "",
    customer: row.customer || "Unknown",
    status: row.details || row.status || "FULL_TO_OFFLOAD",
    type: "Inbound RN",
    equipmentNumber: row.equipmentNumber || "",
  };
}

async function fetchCottonAssignees(session = lastSession) {
  if (!session?.accessToken || !session?.cottonFacility?.id) {
    throw new Error("Sign in and load Cotton first.");
  }
  const headers = wmsHeaders(session, session.cottonFacility);
  const now = new Date();
  const lookbackStart = new Date(now);
  lookbackStart.setDate(lookbackStart.getDate() - 60);
  const tasks = await fetchPickTasks(headers, lookbackStart, now);
  const names = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const name = String(pickAssigneeName(task) || "").trim();
    if (!name) continue;
    const current = names.get(name) || { name, taskCount: 0, working: 0, completed: 0 };
    const orders = taskOrderCount(task);
    const bucket = taskStatusBucket(task);
    current.taskCount += 1;
    if (bucket === "completed") current.completed += orders;
    if (bucket === "working") current.working += orders;
    names.set(name, current);
  }
  const assignees = [...names.values()]
    .sort((a, b) => (b.working + b.completed) - (a.working + a.completed) || a.name.localeCompare(b.name));
  const result = {
    facility: session.cottonFacility,
    lookbackDays: 60,
    taskRows: tasks.length,
    assignees,
  };
  try {
    fs.writeFileSync(path.join(__dirname, "last-assignees.json"), JSON.stringify(result, null, 2));
  } catch {}
  return result;
}

function rankedAssignees(map) {
  return [...map.values()].sort((a, b) => b.packedOrders - a.packedOrders || a.assignee.localeCompare(b.assignee));
}

function rankedWorkers(map, valueKey) {
  return [...map.values()].sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0) || a.assignee.localeCompare(b.assignee));
}

function listFromPage(data) {
  if (Array.isArray(data)) return data;
  return data?.list || data?.records || data?.rows || data?.data || [];
}

async function fetchOrderPlanMap(headers, orderIds) {
  const map = new Map();
  const errors = [];
  const chunks = [];
  for (let i = 0; i < orderIds.length; i += 50) chunks.push(orderIds.slice(i, i + 50));
  for (const ids of chunks) {
    try {
      const data = await apiFetch(`${WMS_API_BASE_URL}/wms-bam/outbound/order-plan/search-by-paging`, {
        method: "POST",
        headers,
        body: JSON.stringify({ orderIds: ids, currentPage: 1, page: 1, pageSize: 50 }),
      });
      for (const row of listFromPage(data)) {
        const rowOrderIds = row.orderIds || row.orders?.map((o) => o.orderId || o.orderNumber || o.id).filter(Boolean) || [];
        for (const oid of rowOrderIds.length ? rowOrderIds : ids) {
          if (ids.includes(String(oid))) map.set(String(oid), row);
        }
      }
    } catch (error) {
      errors.push(`/wms-bam/outbound/order-plan/search-by-paging: ${error.message || error}`);
    }
  }
  return { map, errors };
}

async function fetchLoadTaskMap(headers, orderIds) {
  const map = new Map();
  const errors = [];
  const chunks = [];
  for (let i = 0; i < orderIds.length; i += 50) chunks.push(orderIds.slice(i, i + 50));
  for (const ids of chunks) {
    try {
      const data = await apiFetch(`${WMS_API_BASE_URL}/wms-bam/outbound/load-task/search-by-paging`, {
        method: "POST",
        headers,
        body: JSON.stringify({ orderIds: ids, statuses: ["NEW", "IN_PROGRESS"], currentPage: 1, page: 1, pageSize: 50 }),
      });
      for (const row of listFromPage(data)) {
        const rowOrderIds = row.orderIds || row.orders?.map((o) => o.orderId || o.orderNumber || o.id).filter(Boolean) || [];
        for (const oid of rowOrderIds.length ? rowOrderIds : ids) {
          if (ids.includes(String(oid))) map.set(String(oid), row);
        }
      }
    } catch (error) {
      errors.push(`/wms-bam/outbound/load-task/search-by-paging: ${error.message || error}`);
    }
  }
  return { map, errors };
}

async function fetchReceiveTaskMap(headers, receiptIds) {
  const map = new Map();
  const errors = [];
  const chunks = [];
  for (let i = 0; i < receiptIds.length; i += 50) chunks.push(receiptIds.slice(i, i + 50));
  for (const ids of chunks) {
    try {
      const data = await apiFetch(`${WMS_API_BASE_URL}/wms-bam/inbound/receive-task/search-by-paging`, {
        method: "POST",
        headers,
        body: JSON.stringify({ receiptIds: ids, statuses: ["NEW", "IN_PROGRESS"], currentPage: 1, page: 1, pageSize: 50 }),
      });
      for (const row of listFromPage(data)) {
        const rowReceiptIds = row.receiptIds || row.receipts?.map((r) => r.receiptId || r.receiptNo || r.id).filter(Boolean) || [];
        for (const rid of rowReceiptIds.length ? rowReceiptIds : ids) {
          if (ids.includes(String(rid))) map.set(String(rid), row);
        }
      }
    } catch (error) {
      errors.push(`/wms-bam/inbound/receive-task/search-by-paging: ${error.message || error}`);
    }
  }
  return { map, errors };
}

function buildOutboundAssignmentTarget(order, suggestion, userId, orderPlan, loadTask) {
  const loadTaskId = loadTask?.id || loadTask?.taskId || "";
  const orderPlanId = orderPlan?.id || orderPlan?.orderPlanId || "";
  const loadIds = loadTask?.loadIds || loadTask?.loads?.map((l) => l.loadId || l.id).filter(Boolean) || (order.loadNo ? [order.loadNo] : []);
  const orderIds = [order.orderNumber].filter(Boolean);
  const targetType = loadTaskId ? "loadTask" : (orderPlanId ? "orderPlan" : "unresolvedOutboundTask");
  return {
    targetType,
    orderIds,
    loadIds,
    customerId: order.customerId || orderPlan?.customerId || loadTask?.customerId || "",
    orderPlanId,
    pickTaskIds: orderPlan?.pickTaskIds || [],
    loadTaskId,
    suggestedAssigneeUserId: userId || "",
    mutation: loadTaskId ? {
      method: "POST",
      endpoint: `/wms/outbound/load-task/${loadTaskId}`,
      body: compactObject({ id: loadTaskId, assigneeUserId: userId }),
    } : orderPlanId ? {
      method: "PUT",
      endpoint: "/wms/outbound/order-plan/update",
      body: compactObject({ id: orderPlanId, defaultAssigneeUserId: userId }),
    } : null,
    mutationReady: Boolean(userId && (loadTaskId || orderPlanId)),
  };
}

function buildInboundAssignmentTarget(rn, suggestion, userId, receiveTask) {
  const receiveTaskId = receiveTask?.id || receiveTask?.taskId || "";
  const receiptIds = receiveTask?.receiptIds || (rn.rn ? [rn.rn] : []);
  return {
    targetType: receiveTaskId ? "receiveTask" : "unresolvedReceiveTask",
    receiptId: receiptIds[0] || rn.rn || "",
    receiveTaskId,
    customerId: rn.customerId || receiveTask?.customerId || "",
    entryId: receiveTask?.entryId || "",
    dockId: receiveTask?.dockId || "",
    taskStepIds: (receiveTask?.taskSteps || []).map((step) => step.id).filter(Boolean),
    suggestedAssigneeUserId: userId || "",
    mutation: receiveTaskId ? {
      method: "PUT",
      endpoint: "/wms/inbound/receive-task",
      body: compactObject({ id: receiveTaskId, receiptIds, customerId: receiveTask?.customerId, assigneeUserId: userId, applyAssigneeToAllTaskSteps: true }),
    } : null,
    mutationReady: Boolean(userId && receiveTaskId),
  };
}

async function fetchAssignmentSuggestions(session = lastSession) {
  if (!session?.accessToken || !session?.cottonFacility?.id) {
    throw new Error("Sign in and load Cotton first.");
  }
  const dashboard = await fetchDashboard(session);
  const plannedRows = dashboard.detailRows || [];
  const inboundRows = (dashboard.inYardFullEquipment?.rows || []).map(mapInboundRn).filter((row) => row.rn);
  const headers = wmsHeaders(session, session.cottonFacility);
  const now = new Date();
  const lookbackStart = new Date(now);
  lookbackStart.setMonth(lookbackStart.getMonth() - 6);
  const [tasks, offloadResult] = await Promise.all([
    fetchPickTasks(headers, lookbackStart, now),
    fetchOffloadTasks(headers, lookbackStart, now),
  ]);
  const byCustomer = new Map();
  const overall = new Map();
  const offloadByCustomer = new Map();
  const offloadOverall = new Map();
  const assigneeUserIds = new Map();

  for (const task of tasks) {
    if (!isPackedTask(task)) continue;
    const assignee = String(pickAssigneeName(task) || "").trim();
    rememberAssigneeUser(assigneeUserIds, assignee, pickAssigneeUserId(task));
    const customer = pickTaskCustomer(task);
    if (!assignee || !customer) continue;
    const packedOrders = taskOrderCount(task);
    const customerKey = normalizeName(customer);
    if (!byCustomer.has(customerKey)) byCustomer.set(customerKey, new Map());
    const customerAssignees = byCustomer.get(customerKey);
    const currentCustomer = customerAssignees.get(assignee) || { assignee, packedOrders: 0 };
    currentCustomer.packedOrders += packedOrders;
    customerAssignees.set(assignee, currentCustomer);
    const currentOverall = overall.get(assignee) || { assignee, packedOrders: 0 };
    currentOverall.packedOrders += packedOrders;
    overall.set(assignee, currentOverall);
  }

  for (const task of offloadResult.tasks) {
    if (!isOffloadedTask(task)) continue;
    const assignee = String(pickOffloaderName(task) || "").trim();
    rememberAssigneeUser(assigneeUserIds, assignee, pickAssigneeUserId(task));
    const customer = pickTaskCustomer(task);
    if (!assignee || !customer) continue;
    const offloadedRns = taskOrderCount(task);
    const customerKey = normalizeName(customer);
    if (!offloadByCustomer.has(customerKey)) offloadByCustomer.set(customerKey, new Map());
    const customerWorkers = offloadByCustomer.get(customerKey);
    const currentCustomer = customerWorkers.get(assignee) || { assignee, offloadedRns: 0 };
    currentCustomer.offloadedRns += offloadedRns;
    customerWorkers.set(assignee, currentCustomer);
    const currentOverall = offloadOverall.get(assignee) || { assignee, offloadedRns: 0 };
    currentOverall.offloadedRns += offloadedRns;
    offloadOverall.set(assignee, currentOverall);
  }

  const overallRank = rankedAssignees(overall);
  const counters = new Map();
  const outboundSuggestions = plannedRows.map((order) => {
    const customerKey = normalizeName(order.customer);
    const rank = rankedAssignees(byCustomer.get(customerKey) || new Map());
    const sourceRank = rank.length ? rank : overallRank;
    const index = counters.get(customerKey) || 0;
    counters.set(customerKey, index + 1);
    const pick = sourceRank.length ? sourceRank[index % sourceRank.length] : null;
    return {
      workType: "Outbound Order",
      orderNumber: order.orderNumber,
      rn: "",
      customer: order.customer,
      status: order.status,
      orderType: order.orderType,
      suggestedAssignee: pick?.assignee || "Unassigned",
      packedOrdersForCustomer: pick && rank.length ? pick.packedOrders : 0,
      offloadedRnsForCustomer: 0,
      rank: sourceRank.length ? (index % sourceRank.length) + 1 : 0,
      source: rank.length ? "Customer 6-month packed history" : (overallRank.length ? "Overall Cotton 6-month packed history" : "No packed history found"),
    };
  });
  const offloadOverallRank = rankedWorkers(offloadOverall, "offloadedRns");
  const inboundCounters = new Map();
  const inboundSuggestions = inboundRows.map((rn) => {
    const customerKey = normalizeName(rn.customer);
    const rank = rankedWorkers(offloadByCustomer.get(customerKey) || new Map(), "offloadedRns");
    const sourceRank = rank.length ? rank : offloadOverallRank;
    const index = inboundCounters.get(customerKey) || 0;
    inboundCounters.set(customerKey, index + 1);
    const pick = sourceRank.length ? sourceRank[index % sourceRank.length] : null;
    return {
      workType: "Inbound RN",
      orderNumber: "",
      rn: rn.rn,
      customer: rn.customer,
      status: rn.status,
      orderType: "Inbound",
      suggestedAssignee: pick?.assignee || "Unassigned",
      packedOrdersForCustomer: 0,
      offloadedRnsForCustomer: pick && rank.length ? pick.offloadedRns : 0,
      rank: sourceRank.length ? (index % sourceRank.length) + 1 : 0,
      source: rank.length ? "Customer 6-month offload history" : (offloadOverallRank.length ? "Overall Cotton 6-month offload history" : "No offload history found"),
    };
  });
  const orderIds = plannedRows.map((order) => order.orderNumber).filter(Boolean);
  const receiptIds = inboundRows.map((rn) => rn.rn).filter(Boolean);
  const [orderPlanLookup, loadTaskLookup, receiveTaskLookup] = await Promise.all([
    fetchOrderPlanMap(headers, orderIds),
    fetchLoadTaskMap(headers, orderIds),
    fetchReceiveTaskMap(headers, receiptIds),
  ]);

  const enrichedOutboundSuggestions = outboundSuggestions.map((suggestion, index) => {
    const order = plannedRows[index] || {};
    const userId = assigneeUserIds.get(normalizeName(suggestion.suggestedAssignee)) || "";
    const assignmentTarget = buildOutboundAssignmentTarget(order, suggestion, userId, orderPlanLookup.map.get(order.orderNumber), loadTaskLookup.map.get(order.orderNumber));
    return { ...suggestion, suggestedAssigneeUserId: userId, assignmentTarget };
  });
  const enrichedInboundSuggestions = inboundSuggestions.map((suggestion, index) => {
    const rn = inboundRows[index] || {};
    const userId = assigneeUserIds.get(normalizeName(suggestion.suggestedAssignee)) || "";
    const assignmentTarget = buildInboundAssignmentTarget(rn, suggestion, userId, receiveTaskLookup.map.get(rn.rn));
    return { ...suggestion, suggestedAssigneeUserId: userId, assignmentTarget };
  });
  const suggestions = [...enrichedOutboundSuggestions, ...enrichedInboundSuggestions];
  const assignmentReadyCount = suggestions.filter((s) => s.assignmentTarget?.mutationReady).length;

  const result = {
    facility: session.cottonFacility,
    lookbackMonths: 6,
    plannedOrders: plannedRows.length,
    inboundRns: inboundRows.length,
    packedTaskRows: tasks.filter(isPackedTask).length,
    offloadTaskRows: offloadResult.tasks.filter(isOffloadedTask).length,
    offloadTaskErrors: offloadResult.errors,
    idLookupErrors: [...orderPlanLookup.errors, ...loadTaskLookup.errors, ...receiveTaskLookup.errors],
    assignmentEndpointWiring: {
      receiveTask: { method: "PUT", endpoint: "/wms/inbound/receive-task" },
      orderPlan: { method: "PUT", endpoint: "/wms/outbound/order-plan/update" },
      loadTask: { method: "POST", endpointTemplate: "/wms/outbound/load-task/{id}" },
      loadTaskBatch: { method: "PUT", endpoint: "/wms/outbound/load-task/batch-update" },
    },
    assignmentReadyCount,
    suggestions,
  };
  try {
    fs.writeFileSync(path.join(__dirname, "last-assignment-suggestions.json"), JSON.stringify(result, null, 2));
  } catch {}
  return result;
}

async function executeLiveAutoAssign() {
  if (!SERVICE_USERNAME || !SERVICE_PASSWORD) {
    throw new Error("Service credentials not configured. Cannot perform assignments.");
  }
  const suggestions = liveCache.assignmentSuggestions?.suggestions || [];
  if (!suggestions.length) {
    return { assigned: [], skipped: [], errors: [], message: "No suggestions available to assign." };
  }

  const session = await login(SERVICE_USERNAME, SERVICE_PASSWORD);
  const headers = wmsHeaders(session, session.cottonFacility);
  const assigned = [];
  const skipped = [];
  const errors = [];

  for (const sug of suggestions) {
    const id = sug.orderNumber || sug.rn || "unknown";
    const target = sug.assignmentTarget;

    if (!target) {
      skipped.push({ id, assignee: sug.suggestedAssignee, reason: "No assignment target resolved." });
      continue;
    }
    if (!target.mutationReady) {
      const missing = [];
      if (!target.suggestedAssigneeUserId) missing.push("assignee user ID");
      if (target.targetType === "unresolvedOutboundTask") missing.push("order-plan or load-task ID");
      if (target.targetType === "unresolvedReceiveTask") missing.push("receive-task ID");
      skipped.push({ id, assignee: sug.suggestedAssignee, reason: `Not fully resolved: missing ${missing.join(", ") || "target IDs"}.` });
      continue;
    }
    if (!target.mutation) {
      skipped.push({ id, assignee: sug.suggestedAssignee, reason: "Mutation spec not available." });
      continue;
    }

    try {
      const mutUrl = `${WMS_API_BASE_URL}${target.mutation.endpoint}`;
      await apiFetch(mutUrl, {
        method: target.mutation.method,
        headers,
        body: JSON.stringify(target.mutation.body),
      });
      assigned.push({
        id,
        assignee: sug.suggestedAssignee,
        assigneeUserId: target.suggestedAssigneeUserId,
        type: target.targetType,
        endpoint: target.mutation.endpoint,
      });
    } catch (err) {
      errors.push({ id, assignee: sug.suggestedAssignee, type: target.targetType, error: err.message || "Mutation failed." });
    }
  }

  return {
    assigned,
    skipped,
    errors,
    message: `Assigned ${assigned.length}, skipped ${skipped.length}, errors ${errors.length}.`,
  };
}

async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && pathname.startsWith("/assets/")) {
      const assetPath = path.normalize(path.join(__dirname, pathname));
      const assetRoot = path.join(__dirname, "assets");
      if (!assetPath.startsWith(assetRoot) || !fs.existsSync(assetPath)) return send(res, 404, { message: "Not found." });
      const ext = path.extname(assetPath).toLowerCase();
      const type = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
      return send(res, 200, fs.readFileSync(assetPath), type);
    }
    if (req.method === "GET" && ["/last-dashboard.json", "/last-assignees.json", "/last-assignment-suggestions.json"].includes(pathname)) {
      const filePath = path.join(__dirname, pathname.slice(1));
      if (!fs.existsSync(filePath)) return send(res, 404, { message: "Not found." });
      return send(res, 200, fs.readFileSync(filePath, "utf8"), "application/json; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/api/live-dashboard") {
      ensureLiveCacheFresh();
      if (!SERVICE_USERNAME || !SERVICE_PASSWORD) {
        const dashboard = readSavedJson("last-dashboard.json");
        const assignees = readSavedJson("last-assignees.json");
        const suggestions = readSavedJson("last-assignment-suggestions.json");
        if (dashboard) {
          return send(res, 200, {
            status: "ok",
            mode: "saved",
            updatedAt: dashboard.refreshedAt || dashboard.generatedAt || null,
            nextRefreshAt: null,
            dashboard,
            assignees,
            suggestions,
          });
        }
        return send(res, 503, {
          status: "unavailable",
          message: "Dashboard service credentials are not configured and saved data is unavailable.",
          updatedAt: null,
          nextRefreshAt: null,
        });
      }
      if (!liveCache.dashboard) {
        if (liveCache.error) {
          return send(res, 503, {
            status: "error",
            message: liveCache.error,
            updatedAt: liveCache.updatedAt,
            nextRefreshAt: liveCache.nextRefreshAt,
          });
        }
        return send(res, 503, {
          status: "loading",
          message: "Dashboard data is loading. Please refresh in a moment.",
          updatedAt: null,
          nextRefreshAt: null,
        });
      }
      return send(res, 200, {
        status: "ok",
        updatedAt: liveCache.updatedAt,
        nextRefreshAt: liveCache.nextRefreshAt,
        dashboard: liveCache.dashboard,
        assignees: liveCache.assignees,
        suggestions: liveCache.assignmentSuggestions,
      });
    }
    if (req.method === "GET" && pathname === "/api/live-assignment-suggestions") {
      ensureLiveCacheFresh();

      if (!SERVICE_USERNAME || !SERVICE_PASSWORD) {
        const suggestions = readSavedJson("last-assignment-suggestions.json");
        if (suggestions) {
          return send(res, 200, {
            ...suggestions,
            status: "ok",
            mode: "saved",
            updatedAt: suggestions.generatedAt || null,
            nextRefreshAt: null,
          });
        }
        return send(res, 503, {
          status: "unavailable",
          message: "Dashboard service credentials are not configured and saved assignment suggestions are unavailable.",
        });
      }

      if (liveCache.assignmentSuggestions) {
        return send(res, 200, {
          ...liveCache.assignmentSuggestions,
          status: "ok",
          updatedAt: liveCache.updatedAt,
          nextRefreshAt: liveCache.nextRefreshAt,
        });
      }

      if (liveCache.error) {
        return send(res, 503, {
          status: "error",
          message: liveCache.error,
          updatedAt: liveCache.updatedAt,
          nextRefreshAt: liveCache.nextRefreshAt,
        });
      }

      return send(res, 503, {
        status: "loading",
        message: "Assignment suggestions are loading. Please refresh in a moment.",
      });
    }
    if (req.method === "POST" && pathname === "/api/login") {
      const body = await readJson(req);
      return send(res, 200, await login(String(body.username || "").trim(), String(body.password || "")));
    }
    if (req.method === "POST" && pathname === "/api/dashboard") {
      const session = await readJson(req);
      return send(res, 200, await fetchDashboard(session));
    }
    if (req.method === "GET" && pathname === "/api/assignees") {
      return send(res, 200, await fetchCottonAssignees());
    }
    if (req.method === "POST" && pathname === "/api/assignees") {
      const session = await readJson(req);
      return send(res, 200, await fetchCottonAssignees(session));
    }
    if (req.method === "POST" && pathname === "/api/assignment-suggestions") {
      const session = await readJson(req);
      return send(res, 200, await fetchAssignmentSuggestions(session));
    }
    if (req.method === "POST" && pathname === "/api/live-auto-assign") {
      return send(res, 200, await executeLiveAutoAssign());
    }
    return send(res, 404, { message: "Not found." });
  } catch (error) {
    return send(res, 500, { message: error instanceof Error ? error.message : "Request failed." });
  }
}

http.createServer(handler).listen(PORT, "0.0.0.0", () => {
  console.log(`Cotton dashboard running at http://0.0.0.0:${PORT}`);
  if (SERVICE_USERNAME && SERVICE_PASSWORD) {
    console.log("Service credentials detected. Starting initial live data fetch...");
    refreshLiveCache();
    setInterval(ensureLiveCacheFresh, CACHE_TTL_MS);
  } else {
    console.log("No WISE_USERNAME/WISE_PASSWORD set. Live data mode disabled (public endpoint will return 503).");
  }
});
