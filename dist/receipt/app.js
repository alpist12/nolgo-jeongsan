import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const storageKey = "receipt-maker-state-v1";
const settlementStorageKey = "nolgo-jeongsan-state-v2";
const databaseUrl = "https://nolgo-jeongsan-default-rtdb.firebaseio.com";
const pageParams = new URLSearchParams(location.search);
const isReadonly = location.pathname.endsWith("/view.html");
const isEditingExistingReceipt = !isReadonly && pageParams.has("id");

// Database rules require a signed-in user now — sign in silently (no UI
// change) so these REST calls keep working, authenticating each request via
// the RTDB REST API's documented ?auth=<idToken> query param.
const firebaseApp = initializeApp({
  apiKey: "AIzaSyCTSyhsP9twRE7kn5IZ317QII98Eqdm6IY",
  authDomain: "nolgo-jeongsan.firebaseapp.com",
  databaseURL: databaseUrl,
  projectId: "nolgo-jeongsan",
  storageBucket: "nolgo-jeongsan.firebasestorage.app",
  messagingSenderId: "735820612157",
  appId: "1:735820612157:web:0759d5df0b8926c953e054",
});
const firebaseAuth = getAuth(firebaseApp);
const authReady = (isReadonly ? Promise.resolve() : (async () => {
  await firebaseAuth.authStateReady();
  if (!firebaseAuth.currentUser) await signInAnonymously(firebaseAuth);
})()).catch((error) => {
  console.error("Anonymous sign-in failed", error);
});
async function authQuery(forceRefresh = false) {
  if (isReadonly) return "";
  await authReady;
  const user = firebaseAuth.currentUser || (await signInAnonymously(firebaseAuth).catch(() => null))?.user;
  const token = await user?.getIdToken(forceRefresh).catch(() => null);
  return token ? `?auth=${token}` : "";
}
// Matches the app's own DEFAULT_ROOM_ID (src/state/RoomContext.tsx) and
// 놀고정산.js's setupRoomId() — this serves one shared friend group, so a
// receipt page opened without a ?room= link (e.g. bookmarked directly)
// should still land in the group's real room, not a blank one.
const DEFAULT_ROOM_ID = "room-78664b1a-5e50-4758-80b0-5645e1000e5d";
const roomId = String(pageParams.get("room") || DEFAULT_ROOM_ID).replace(/[.#$/[\]]/g, "-");
let firebaseSettlementSnapshot = null;

const formatWon = (value) => `${Math.round(Number(value) || 0).toLocaleString("ko-KR")}원`;
const onlyNumber = (value) => Number(String(value || "").replace(/[^\d.-]/g, ""));
let confirmStampImagePromise = null;
function loadConfirmStampImage() {
  if (!confirmStampImagePromise) {
    confirmStampImagePromise = new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = "assets/confirm-stamp.png";
    });
  }
  return confirmStampImagePromise;
}
const todayKey = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

let editingSettlementIndex = null;
const expandedReceiptItems = new Set();
const expandedTransferRows = new Set();
let successAudioContext = null;

function prepareSuccessSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return () => {};
  successAudioContext ||= new AudioContextClass();
  const context = successAudioContext;
  context.resume().catch(() => {});
  return () => {
    const start = context.currentTime + 0.025;
    [659.25, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + index * 0.13;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(index === 0 ? 0.1 : 0.14, noteStart + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.28);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.3);
    });
  };
}

let state = {
  mode: "budget",
  title: "",
  event: "",
  usedDate: "",
  plannedDate: "",
  writer: "",
  splitType: "1/N 정산",
  settlementMemo: "",
  completedTransfers: {},
  memo: "",
  budgetItems: [],
  settlementItems: [],
  receiptId: ""
};

const makeReceiptId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Date.now().toString(36));
const firebaseRequest = async (path, options) => {
  let response = await fetch(`${databaseUrl}/${path}.json${await authQuery()}`, options);
  if (response.status === 401 || response.status === 403) {
    response = await fetch(`${databaseUrl}/${path}.json${await authQuery(true)}`, options);
  }
  return response;
};
const firebaseGet = async (path) => {
  if (isReadonly && path.startsWith("receipts/")) {
    const receiptId = path.slice("receipts/".length);
    try {
      const response = await fetch(`/.netlify/functions/receipt-share?id=${encodeURIComponent(receiptId)}&data=1`);
      if (response.ok) return await response.json();
    } catch {
      /* fallback to direct firebase request */
    }
  }
  const response = await firebaseRequest(path);
  if (!response.ok) throw new Error("Firebase read failed");
  return response.json();
};
// meetings is stored in Firebase as a keyed object ({ [meetingId]: meeting })
// so Cloud Functions can trigger on an individual meeting being created —
// this page keeps working with a plain array internally, converting at the
// read/write boundary with the rest of the app/site.
const normalizeRoomMeetings = (room) => {
  if (room && room.meetings && !Array.isArray(room.meetings) && typeof room.meetings === "object") {
    room.meetings = Object.values(room.meetings);
  }
  return room;
};
const roomMeetingsToObject = (room) => {
  if (room && Array.isArray(room.meetings)) {
    return { ...room, meetings: Object.fromEntries(room.meetings.map((meeting) => [meeting.id, meeting])) };
  }
  return room;
};
const firebaseGetRoom = async (roomIdToFetch) => normalizeRoomMeetings(await firebaseGet(`rooms/${roomIdToFetch}`));
const firebasePut = async (path, value) => {
  const response = await firebaseRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error("Firebase write failed");
};
// PATCH is Firebase's multi-path update() over REST — unlike firebasePut
// (a full overwrite of `path`), only the given child keys are touched, so
// writing one crew's data here can't clobber a sibling crew that changed on
// another device between this page's read and this write.
const firebasePatch = async (path, value) => {
  const response = await firebaseRequest(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error("Firebase write failed");
};

// The app (놀고정산앱) stores receipt items as a single mode-agnostic
// `items` array (ReceiptItem[], with `subs`/`users`/`place`) instead of
// this site's separate budgetItems/settlementItems (with
// `subItems`/`members`/`name`) — without this conversion, a receipt
// created in the app shows up here as "항목없음 0원" even though it has
// real items, because currentItems() only ever reads budgetItems/
// settlementItems.
function convertAppItemsToSiteItems(items) {
  return (items || []).map((it) => ({
    name: it.place || it.name || "항목",
    amount: String(it.amount || 0),
    quantity: (it.subs && it.subs.length) || 1,
    subItems: (it.subs || []).map((s) => ({ name: s.name || "", amount: String(s.amount || 0), note: "", members: s.users, customMembers: s.users !== undefined })),
    note: it.note || "",
    payer: it.payer || "",
    members: it.users || [],
    proxyEnabled: false,
    proxyPayers: [],
    proxyFor: [],
    completed: !!it.completed,
    tentative: !!it.tentative
  }));
}

async function load() {
  try {
    const linkedState = readLinkedState();
    // A truly-unsaved in-progress draft (nothing tapped yet) lives only in
    // this local cache — recover it on refresh instead of falling through
    // to whatever's already persisted in Firebase, which by definition
    // can't be newer than an edit that was never saved.
    const localDraft = !isReadonly ? readLocalDraft() : null;
    const receiptIdToFetch = pageParams.get("id") || (!linkedState && !localDraft && !isReadonly ? localStorage.getItem(storageKey) : null);
    if (linkedState) {
      state = { ...state, ...linkedState };
    } else if (localDraft) {
      state = { ...state, ...localDraft };
    } else if (receiptIdToFetch) {
      const remoteReceipt = await firebaseGet(`receipts/${receiptIdToFetch}`);
      if (remoteReceipt) state = { ...state, ...remoteReceipt, receiptId: receiptIdToFetch };
    }
    if (state.date && !state.usedDate) state.usedDate = state.date;
    delete state.date;
    if (Array.isArray(state.items) && !state.budgetItems?.length && !state.settlementItems?.length) {
      const converted = convertAppItemsToSiteItems(state.items);
      if (state.mode === "budget") state.budgetItems = converted;
      else state.settlementItems = converted;
    }
    if (state.mode === "budget" && !state.budgetItems?.length && state.settlementItems?.length) state.mode = "settlement";
    if (!state.receiptId) state.receiptId = pageParams.get("id") || makeReceiptId();
    if (roomId && !isReadonly) firebaseSettlementSnapshot = await firebaseGetRoom(roomId);
  } catch (error) {
    console.error(error);
    if (!state.receiptId) state.receiptId = pageParams.get("id") || makeReceiptId();
  }
}

function encodeState(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeState(value) {
  const binary = atob(String(value).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function readLinkedState() {
  const value = new URLSearchParams(location.search).get("receipt") || location.hash.slice(1);
  if (!value) return null;
  try { return decodeState(value.replace(/^data=/, "")); } catch { return null; }
}

function buildShareUrl() {
  const params = new URLSearchParams({ id: state.receiptId });
  if (roomId) params.set("room", roomId);
  const basePath = location.pathname.replace(/\/receipt\/[^/]*$/, "/receipt/");
  return `${location.origin}${basePath}view.html?${params.toString()}`;
}

function buildKakaoShareText() {
  const items = currentItems() || [];
  const total = items.reduce((sum, it) => sum + (Number(it.amount) || (typeof itemTotal === "function" ? itemTotal(it) : 0) || 0), 0);
  const rawDate = state.mode === "budget" ? state.plannedDate : state.usedDate;

  const peopleSet = new Set();
  items.forEach((it) => {
    if (it.payer && it.payer !== "공금") peopleSet.add(it.payer);
    (it.users || []).forEach((u) => { if (u && u !== "공금") peopleSet.add(u); });
  });
  const peopleCount = peopleSet.size || 1;

  const itemLines = items.map((it, idx) => {
    const userCount = (it.users || []).length || peopleCount;
    const label = it.place || it.name || "";
    const prefix = `${idx + 1}차(${label ? label + ", " : ""}${userCount}명)`;
    const amt = Number(it.amount) || (typeof itemTotal === "function" ? itemTotal(it) : 0) || 0;
    return `- ${prefix} : ${amt.toLocaleString("ko-KR")}원`;
  });

  const baseDate = rawDate ? new Date(`${rawDate}T00:00:00`) : new Date();
  const dueDate = new Date(baseDate.getTime() + 4 * 24 * 60 * 60 * 1000);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const dueYear = dueDate.getFullYear();
  const dueMonth = String(dueDate.getMonth() + 1).padStart(2, "0");
  const dueDay = String(dueDate.getDate()).padStart(2, "0");
  const dueWeekday = weekdays[dueDate.getDay()];
  const dueStr = `${dueYear}. ${dueMonth}. ${dueDay}.(${dueWeekday})까지`;

  const avgAmount = Math.round(total / peopleCount);
  const sendGuide = avgAmount > 0
    ? `${avgAmount.toLocaleString("ko-KR")}원을 송금해주세요.`
    : "정산 내용을 확인하고 송금해주세요.";

  const url = buildShareUrl();
  return [
    "🟡 정산을 시작했어요",
    "",
    "정산 내용을 확인해주세요.",
    "",
    `- 정산금액 : ${total.toLocaleString("ko-KR")}원`,
    ...itemLines,
    `- 요청인원 : ${peopleCount}명`,
    `- 정산기한 : ${dueStr}`,
    "",
    sendGuide,
    "* 정산기한이 지나기 전에 정산을 완료해주세요.",
    "",
    "👉 정산현황 보기:",
    url
  ].join("\n");
}

async function copyReceiptLink(button, resetText) {
  const shareText = buildKakaoShareText();
  await navigator.clipboard.writeText(shareText);
  const oldText = button.textContent;
  button.textContent = "내용 복사 완료";
  setTimeout(() => { button.textContent = resetText ?? oldText; }, 1400);
}

const KAKAO_JAVASCRIPT_KEY = "ad3721fda3a3474488dded4cf8e26112";

function initKakaoSDK() {
  if (typeof window !== "undefined" && window.Kakao) {
    if (!window.Kakao.isInitialized()) {
      window.Kakao.init(KAKAO_JAVASCRIPT_KEY);
    }
    return window.Kakao.isInitialized();
  }
  return false;
}

function shareKakaoCard() {
  if (!initKakaoSDK()) return false;
  try {
    const items = currentItems() || [];
    const total = items.reduce((sum, it) => sum + (Number(it.amount) || (typeof itemTotal === "function" ? itemTotal(it) : 0) || 0), 0);
    const rawDate = state.mode === "budget" ? state.plannedDate : state.usedDate;

    const peopleSet = new Set();
    items.forEach((it) => {
      if (it.payer && it.payer !== "공금") peopleSet.add(it.payer);
      (it.users || []).forEach((u) => { if (u && u !== "공금") peopleSet.add(u); });
    });
    const peopleCount = peopleSet.size || 1;

    // Kakao itemContent items (max 5)
    const itemRows = items.slice(0, 3).map((it, idx) => {
      const userCount = (it.users || []).length || peopleCount;
      const label = it.place || it.name || "";
      const prefix = `${idx + 1}차(${label ? label + ", " : ""}${userCount}명)`;
      const amt = Number(it.amount) || (typeof itemTotal === "function" ? itemTotal(it) : 0) || 0;
      return { item: prefix, itemOp: `${amt.toLocaleString("ko-KR")}원` };
    });

    itemRows.push({ item: "요청인원", itemOp: `${peopleCount}명` });

    const baseDate = rawDate ? new Date(`${rawDate}T00:00:00`) : new Date();
    const dueDate = new Date(baseDate.getTime() + 4 * 24 * 60 * 60 * 1000);
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const dueStr = `${dueDate.getMonth() + 1}.${dueDate.getDate()}.(${weekdays[dueDate.getDay()]})까지`;
    itemRows.push({ item: "정산기한", itemOp: dueStr });

    const avgAmount = Math.round(total / peopleCount);
    const sendGuide = avgAmount > 0
      ? `${avgAmount.toLocaleString("ko-KR")}원을 송금해주세요.`
      : "정산 내용을 확인하고 송금해주세요.";

    const url = buildShareUrl();

    window.Kakao.Share.sendDefault({
      objectType: "feed",
      content: {
        title: "정산을 시작했어요",
        description: `정산 내용을 확인해주세요.\n\n${sendGuide}\n* 정산기한이 지나기 전에 정산을 완료해주세요.`,
        imageUrl: "https://nolgo.netlify.app/nolgo-settle-banner.png",
        imageWidth: 800,
        imageHeight: 400,
        link: {
          mobileWebUrl: url,
          webUrl: url,
        },
      },
      itemContent: {
        profileText: "놀고정산",
        profileImageUrl: "https://nolgo.netlify.app/favicon.svg",
        titleImageText: `정산금액 ${total.toLocaleString("ko-KR")}원`,
        items: itemRows,
        sum: "총 정산금액",
        sumOp: `${total.toLocaleString("ko-KR")}원`,
      },
      buttons: [
        {
          title: "정산현황 보기",
          link: {
            mobileWebUrl: url,
            webUrl: url,
          },
        },
      ],
    });
    return true;
  } catch (error) {
    console.warn("Kakao.Share failed:", error);
    return false;
  }
}

// Prefers the Kakao SDK card share, then the OS share sheet, then clipboard copy.
async function shareOrCopyReceiptLink(button, resetText) {
  if (shareKakaoCard()) {
    return;
  }
  const shareText = buildKakaoShareText();
  const title = "정산을 시작했어요";
  const url = buildShareUrl();
  if (navigator.share) {
    try {
      await navigator.share({ title, text: shareText, url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  await copyReceiptLink(button, resetText);
}

const localDraftKey = `${storageKey}-draft`;
function readLocalDraft() {
  try {
    const raw = localStorage.getItem(localDraftKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearLocalDraft() {
  try { localStorage.removeItem(localDraftKey); } catch { /* ignore */ }
}

// Cloud Functions triggers can't be deployed on this Firebase project (Blaze
// plan required, unavailable), so notification delivery goes through a
// Netlify function instead — called explicitly right after publish rather
// than relying on a database write trigger. Best-effort: a failed call here
// never blocks the publish flow itself.
async function notifyReceiptPublished() {
  await authReady;
  const token = await firebaseAuth.currentUser?.getIdToken().catch(() => null);
  if (!token) return;
  fetch("/.netlify/functions/notify-broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ title: "영수증이 발행됐어요", body: receiptShareTitle() })
  }).catch(() => {});
}

async function publishReceipt() {
  if (!currentItems().length) return;
  await persistReceipt();
  await firebasePut(`receipts/${state.receiptId}/published`, true).catch((error) => console.error(error));
  if (!isEditingExistingReceipt) notifyReceiptPublished();
  $("#publishSuccessTitle").textContent = isEditingExistingReceipt ? "수정 내용을 저장했습니다" : "영수증이 발행되었습니다";
  $("#publishSuccessSub").textContent = receiptShareTitle();
  $("#publishSuccess").classList.remove("hidden");
}

function receiptShareTitle() {
  const rawDate = state.mode === "budget" ? state.plannedDate : state.usedDate;
  const parts = String(rawDate || "").split("-").map(Number);
  const dateLabel = parts.length === 3 && parts.every(Number.isFinite)
    ? `${String(parts[0]).slice(-2)}.${parts[1]}.${parts[2]}`
    : "날짜 미정";
  return `${dateLabel} ${String(state.title || (state.mode === "budget" ? "예산 영수증" : "정산 영수증")).trim()}`;
}

function loadSettlementSnapshot() {
  try {
    const saved = firebaseSettlementSnapshot;
    if (!saved || !Array.isArray(saved.meetings)) return saved;

    let removed = 0;
    saved.meetings.forEach((meeting) => {
      const expenses = meeting?.state?.expenses;
      if (!Array.isArray(expenses)) return;
      meeting.state.expenses = expenses.filter((item) => {
        const hasParticipants = (item.members || []).length > 0 || (item.usedBy || []).length > 0;
        const isInvalidTaxi = /^택시 2 \d+$/.test(String(item.name || "").trim())
          && Number(item.amount) === 1
          && !hasParticipants;
        if (isInvalidTaxi) removed += 1;
        return !isInvalidTaxi;
      });
    });

    if (removed > 0) {
      saved.updatedAt = Date.now();
    }
    return saved;
  } catch {
    return null;
  }
}

function settlementMeetings() {
  const saved = loadSettlementSnapshot();
  if (Array.isArray(saved?.meetings)) return saved.meetings;
  return [];
}

function currentMeeting() {
  const saved = loadSettlementSnapshot();
  const meetings = Array.isArray(saved?.meetings) ? saved.meetings : [];
  return meetings.find((meeting) => meeting?.state?.title === state.event)
    || meetings.find((meeting) => meeting?.id === saved?.currentMeetingId)
    || meetings[0]
    || null;
}

function currentMembers() {
  const meeting = currentMeeting();
  return Array.isArray(meeting?.members) && meeting.members.length ? meeting.members : [];
}

function itemUsedBy(item) {
  return Array.isArray(item.members) ? item.members.filter(Boolean) : [];
}

function namesFrom(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function itemProxyPayers(item) {
  return namesFrom(item.proxyPayers);
}

function itemShareMembers(item) {
  const proxyPayers = itemProxyPayers(item);
  if (item.proxyEnabled && proxyPayers.length) return proxyPayers;
  return itemUsedBy(item);
}

function itemUsageSummary(item) {
  const usedBy = itemUsedBy(item);
  const proxyFor = itemProxyFor(item);
  if (!item.proxyEnabled) return usedBy.join(", ");
  return formatUsageWithProxy(usedBy, proxyFor);
}

function itemProxyFor(item) {
  return namesFrom(item.proxyFor);
}

function itemQuantity(item) {
  return Math.min(100, Math.max(1, Math.floor(onlyNumber(item.quantity) || 1)));
}

function itemSubItems(item) {
  return Array.isArray(item.subItems) ? item.subItems : [];
}

function normalizeSubItems(item) {
  const quantity = itemQuantity(item);
  const current = itemSubItems(item);
  const unitAmount = quantity > 1 ? Math.round((onlyNumber(item.amount) || 0) / quantity) : "";
  item.subItems = Array.from({ length: quantity }, (_, index) => ({
    name: current[index]?.name || (quantity > 1 ? `${item.name || "항목"} ${index + 1}` : ""),
    amount: current[index]?.amount || (unitAmount || ""),
    note: current[index]?.note || "",
    members: current[index]?.members === undefined ? itemUsedBy(item) : namesFrom(current[index]?.members),
    customMembers: current[index]?.customMembers === undefined ? current[index]?.members !== undefined : !!current[index]?.customMembers,
    proxyEnabled: current[index]?.proxyEnabled,
    proxyPayers: namesFrom(current[index]?.proxyPayers),
    proxyFor: namesFrom(current[index]?.proxyFor),
    completed: current[index]?.completed
  }));
  return item.subItems;
}

function subItemsTotal(item) {
  return itemSubItems(item).reduce((sum, subItem) => sum + onlyNumber(subItem.amount), 0);
}

function subItemsHaveAmount(item) {
  return itemSubItems(item).some((subItem) => onlyNumber(subItem.amount) > 0);
}

function unitUsedBy(unit, parent) {
  if (unit.customMembers === false) return itemUsedBy(parent);
  if (namesFrom(unit.usedBy).length) return namesFrom(unit.usedBy);
  const picked = namesFrom(unit.members);
  return picked.length ? picked : itemUsedBy(parent);
}

function unitProxyPayers(unit, parent) {
  const picked = namesFrom(unit.proxyPayers);
  return picked.length ? picked : itemProxyPayers(parent);
}

function unitProxyFor(unit, parent) {
  const picked = namesFrom(unit.proxyFor);
  return picked.length ? picked : itemProxyFor(parent);
}

function unitProxyEnabled(unit, parent) {
  return unit.proxyEnabled === undefined ? !!parent.proxyEnabled : !!unit.proxyEnabled;
}

function unitShareMembers(unit, parent) {
  const proxyPayers = unitProxyPayers(unit, parent);
  if (unitProxyEnabled(unit, parent) && proxyPayers.length) return proxyPayers;
  return unitUsedBy(unit, parent);
}

function unitUsageSummary(unit, parent) {
  const usedBy = unitUsedBy(unit, parent);
  const proxyFor = unitProxyFor(unit, parent);
  const proxyPayers = unitProxyPayers(unit, parent);
  if (!unitProxyEnabled(unit, parent)) return usedBy.join(", ");
  return `사용: ${formatUsageWithProxy(usedBy, proxyFor) || "미선택"} · ${summarizePeople(proxyPayers)}`;
}

function summarizePeople(value) {
  const names = namesFrom(value);
  if (!names.length) return "N: 미선택";
  return names.length === 1 ? `N: ${names[0]}` : `N: ${names[0]} 외 ${names.length - 1}명`;
}

function formatUsageWithProxy(usedBy, proxyFor) {
  const proxySet = new Set(namesFrom(proxyFor));
  return namesFrom(usedBy).map((name) => proxySet.has(name) ? `${name} (대신 결제)` : name).join(", ");
}

function settlementUnits() {
  return state.settlementItems.flatMap((item, itemIndex) => {
    const subItems = itemSubItems(item);
    if ((itemQuantity(item) > 1 || item.storeGroup) && subItems.length) {
      return subItems.map((subItem, subIndex) => ({
        parent: item,
        itemIndex,
        subIndex,
        name: subItem.name || `${item.name || "항목"} ${subIndex + 1}`,
        amount: onlyNumber(subItem.amount),
        fundUsed: onlyNumber(subItem.fundUsed === undefined ? item.fundUsed : subItem.fundUsed),
        note: subItem.note || "",
        completed: subItem.completed === undefined ? !!item.completed : !!subItem.completed,
        payer: String(subItem.payer || item.payer || "").trim(),
        usedBy: unitUsedBy(subItem, item),
        proxyEnabled: unitProxyEnabled(subItem, item),
        proxyPayers: unitProxyPayers(subItem, item),
        proxyFor: unitProxyFor(subItem, item)
      }));
    }
    return [{
      parent: item,
      itemIndex,
      subIndex: null,
      name: item.name || "정산 항목",
      amount: itemTotal(item),
      fundUsed: onlyNumber(item.fundUsed),
      note: item.note || "",
      completed: !!item.completed,
      payer: String(item.payer || "").trim(),
      usedBy: itemUsedBy(item),
      proxyEnabled: !!item.proxyEnabled,
      proxyPayers: itemProxyPayers(item),
      proxyFor: itemProxyFor(item)
    }];
  }).filter((unit) => unit.amount > 0);
}

function itemReceiptSummary(item) {
  const units = settlementUnits().filter((unit) => unit.parent === item);
  if (!units.length) return itemUsageSummary(item);
  const used = [...new Set(units.flatMap((unit) => namesFrom(unit.usedBy)))];
  const proxyFor = [...new Set(units.flatMap((unit) => unit.proxyEnabled ? namesFrom(unit.proxyFor) : []))];
  return formatUsageWithProxy(used, proxyFor);
}

function calculateTransfers() {
  const direct = new Map();
  const addDebt = (from, to, amount, detail) => {
    if (!from || !to || from === to || amount <= 0.5) return;
    const key = `${from}@@${to}`;
    const row = direct.get(key) || { from, to, amount: 0, details: [] };
    row.amount += amount;
    row.details.push(detail);
    direct.set(key, row);
  };

  settlementUnits().filter((unit) => !unit.completed).forEach((unit) => {
    const amount = Math.max(0, unit.amount - onlyNumber(unit.fundUsed));
    const payer = unit.payer;
    const usedBy = namesFrom(unit.usedBy);
    if (!amount || !payer || payer === "공금" || !usedBy.length) return;
    const proxyFor = unit.proxyEnabled ? namesFrom(unit.proxyFor) : [];
    const proxyForSet = new Set(proxyFor);
    const proxyPayers = namesFrom(unit.proxyPayers);
    const personShare = amount / usedBy.length;
    usedBy.forEach((usedName) => {
      const isProxyTarget = unit.proxyEnabled && proxyForSet.has(usedName) && proxyPayers.length;
      const debtMembers = isProxyTarget ? proxyPayers : [usedName];
      const debtShare = personShare / debtMembers.length;
      debtMembers.forEach((name) => {
        addDebt(name, payer, debtShare, {
          name: unit.name || "정산 항목",
          memo: unitUsageSummary(unit, unit.parent),
          amount: debtShare,
          total: amount,
          personShare,
          proxyCoveredAmount: isProxyTarget ? personShare : 0,
          completed: !!unit.completed,
          usedBy,
          proxyEnabled: isProxyTarget,
          proxyPayers,
          proxyFor: isProxyTarget ? [usedName] : [],
          itemIndex: unit.itemIndex,
          subIndex: unit.subIndex,
          offset: false
        });
      });
    });
  });

  const handled = new Set();
  const rows = [];
  [...direct.values()].forEach((row) => {
    const key = `${row.from}@@${row.to}`;
    if (handled.has(key)) return;
    const reverseKey = `${row.to}@@${row.from}`;
    const reverse = direct.get(reverseKey);
    handled.add(key);
    handled.add(reverseKey);

    const reverseAmount = reverse?.amount || 0;
    const diff = row.amount - reverseAmount;
    if (Math.abs(diff) <= 0.5) return;

    if (diff > 0) {
      rows.push({
        from: row.from,
        to: row.to,
        amount: diff,
        details: [
          ...row.details,
          ...(reverse?.details || []).map((detail) => ({ ...detail, offset: true }))
        ]
      });
    } else {
      rows.push({
        from: row.to,
        to: row.from,
        amount: -diff,
        details: [
          ...(reverse?.details || []),
          ...row.details.map((detail) => ({ ...detail, offset: true }))
        ]
      });
    }
  });

  return rows
    .map((row) => ({ ...row, transferKey: `${row.from}@@${row.to}`, completed: !!state.completedTransfers?.[`${row.from}@@${row.to}`] }))
    .sort((a, b) => Number(a.completed) - Number(b.completed) || a.from.localeCompare(b.from, "ko") || a.to.localeCompare(b.to, "ko"));
}

// Numbered duplicate units ("숙주 1".."숙주 4") each become their own
// settlementUnits() entry so per-unit assignment stays possible while
// editing. When every unit for a product ends up assigned/paid the same
// way, that split serves no purpose in 내역/최근 활동 — merge them into one
// expense row here. Units that differ (different payer/usedBy/proxy) are
// left separate since merging would blur who actually owes what.
function mergeDuplicateUnits(units) {
  const sameNames = (a, b) => {
    const na = [...a].sort();
    const nb = [...b].sort();
    return na.length === nb.length && na.every((v, i) => v === nb[i]);
  };
  const merged = [];
  units.forEach((unit) => {
    const base = String(unit.name || "").trim().replace(/\s+\d+$/, "") || unit.name;
    const last = merged[merged.length - 1];
    const lastBase = last ? String(last.name || "").trim().replace(/\s+\d+$/, "") : null;
    if (
      last && last.parent === unit.parent && lastBase === base &&
      last.payer === unit.payer && last.proxyEnabled === unit.proxyEnabled &&
      sameNames(last.usedBy, unit.usedBy) && sameNames(last.proxyFor, unit.proxyFor) && sameNames(last.proxyPayers, unit.proxyPayers)
    ) {
      merged[merged.length - 1] = { ...last, name: base, amount: last.amount + unit.amount, fundUsed: last.fundUsed + unit.fundUsed };
    } else {
      merged.push({ ...unit, name: base });
    }
  });
  return merged;
}

async function registerSettlementExpenses() {
  if (state.mode !== "settlement") return;
  const saved = roomId ? await firebaseGetRoom(roomId) : loadSettlementSnapshot();
  if (!Array.isArray(saved?.meetings)) return;
  const meeting = saved.meetings.find((item) => item?.state?.title === state.event)
    || saved.meetings.find((item) => item?.id === saved.currentMeetingId)
    || saved.meetings[0];
  if (!meeting?.state) return;
  const date = state.usedDate || todayKey();
  const items = mergeDuplicateUnits(settlementUnits())
    .flatMap((unit) => {
      const amount = unit.amount;
      const payer = unit.payer;
      const usedBy = namesFrom(unit.usedBy);
      if (!amount || !payer || (!usedBy.length && payer !== "공금")) return [];
      const fundUsed = Math.min(amount, onlyNumber(unit.fundUsed));
      const proxyTargets = unit.proxyEnabled ? namesFrom(unit.proxyFor).filter((name) => usedBy.includes(name)) : [];
      const normalUsers = usedBy.filter((name) => !proxyTargets.includes(name));
      const rows = [];
      if (!proxyTargets.length) {
        return [{
          name: unit.name || "정산 영수증 지출",
          date,
          amount,
          payer,
          category: "영수증",
          members: usedBy,
          usedBy,
          proxyFor: [],
          proxyPayers: [],
          proxyPayment: false,
          fund: payer === "공금",
          fundUsed: payer === "공금" ? amount : fundUsed,
          receiptId: state.receiptId
        }];
      }
      const personShare = (amount - fundUsed) / usedBy.length;
      if (normalUsers.length) {
        rows.push({
          name: unit.name || "정산 영수증 지출",
          date,
          amount: personShare * normalUsers.length,
          payer,
          category: "영수증",
          members: normalUsers,
          usedBy,
          proxyFor: [],
          proxyPayers: [],
          proxyPayment: false,
          fund: payer === "공금",
          fundUsed: payer === "공금" ? personShare * normalUsers.length : 0,
          receiptId: state.receiptId
        });
      }
      if (proxyTargets.length) {
        const proxyPayers = namesFrom(unit.proxyPayers);
        if (proxyPayers.length) {
          rows.push({
            name: `${unit.name || "정산 영수증 지출"} (대신 결제)`,
            date,
            amount: personShare * proxyTargets.length,
            payer,
            category: "영수증",
            members: proxyPayers,
            proxyFor: proxyTargets,
            usedBy,
            proxyPayers,
            proxyPayment: true,
            fund: payer === "공금",
            fundUsed: payer === "공금" ? personShare * proxyTargets.length : 0,
            receiptId: state.receiptId
          });
        }
      }
      return rows;
    })
    .filter(Boolean);
  meeting.state.expenses = [
    ...items,
    ...(meeting.state.expenses || []).filter((item) => item.receiptId !== state.receiptId)
  ];
  const roomCompletedTransfers = { ...(meeting.state.completedTransfers || {}) };
  const receiptTransferKeys = calculateTransfers().map((item) => item.transferKey);
  receiptTransferKeys.forEach((key) => {
    if (state.completedTransfers?.[key]) roomCompletedTransfers[key] = true;
    else delete roomCompletedTransfers[key];
  });
  meeting.state.completedTransfers = roomCompletedTransfers;
  saved.updatedAt = Date.now();
  saved.updatedBy = `receipt-${state.receiptId}`;
  firebaseSettlementSnapshot = saved;
  if (roomId) {
    await firebasePatch(`rooms/${roomId}`, {
      [`meetings/${meeting.id}`]: meeting,
      currentMeetingId: saved.currentMeetingId,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy
    });
  }
}

function parseExpenseLine(line) {
  const clean = String(line || "").trim();
  if (!clean) return null;
  const normalized = clean.replace(/원/g, "").trim();
  const withQuantity = normalized.match(/^(.*?)[\s,]+([0-9]+)[\s,]+([0-9][0-9,]*)$/);
  const simple = normalized.match(/^(.*?)[\s,]+([0-9][0-9,]*)$/);
  const match = withQuantity || simple;
  if (!match) return null;
  const name = match[1].trim();
  const quantity = withQuantity ? Math.min(100, Math.max(1, Math.floor(onlyNumber(match[2]) || 1))) : 1;
  const amount = onlyNumber(withQuantity ? match[3] : match[2]);
  if (!name || !amount) return null;
  const unitAmount = quantity > 1 ? Math.round(amount / quantity) : "";
  return {
    name,
    amount: String(amount),
    quantity,
    subItems: quantity > 1 ? Array.from({ length: quantity }, (_, index) => ({
      name: `${name} ${index + 1}`,
      amount: String(unitAmount),
      note: ""
    })) : [],
    note: "",
    payer: "",
    members: [],
    proxyEnabled: false,
    proxyPayers: [],
    proxyFor: [],
    completed: false,
    tentative: false
  };
}

function makeStoreGroup(storeName, details) {
  if (!storeName || !details.length) return null;
  const subItems = details.flatMap((detail) => {
    if (itemQuantity(detail) > 1 && itemSubItems(detail).length) {
      return itemSubItems(detail).map((subItem, index) => ({
        ...subItem,
        name: subItem.name || `${detail.name} ${index + 1}`
      }));
    }
    return [{ name: detail.name || "이용료", amount: String(onlyNumber(detail.amount)), note: detail.note || "" }];
  });
  const amount = subItems.reduce((sum, item) => sum + onlyNumber(item.amount), 0);
  return {
    name: storeName,
    amount: String(amount),
    quantity: subItems.length,
    subItems,
    storeGroup: true,
    note: "",
    payer: "",
    members: [],
    proxyEnabled: false,
    proxyPayers: [],
    proxyFor: [],
    completed: false,
    tentative: false
  };
}

function parseBulkExpenses(value) {
  const rows = [];
  let storeName = "";
  let storeDetails = [];
  const flushStore = () => {
    const group = makeStoreGroup(storeName, storeDetails);
    if (group) rows.push(group);
    storeName = "";
    storeDetails = [];
  };

  String(value || "").split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const storeMatch = line.match(/^[-－]\s*(.+)$/);
    if (storeMatch) {
      flushStore();
      const inlineExpense = parseExpenseLine(storeMatch[1]);
      if (inlineExpense) rows.push(inlineExpense);
      else storeName = storeMatch[1].trim();
      return;
    }

    const amountOnly = line.replace(/원/g, "").trim().match(/^[0-9][0-9,]*$/);
    const parsed = amountOnly ? parseExpenseLine(`이용료 ${amountOnly[0]}`) : parseExpenseLine(line);
    if (!parsed) return;
    if (storeName) storeDetails.push(parsed);
    else rows.push(parsed);
  });
  flushStore();
  return rows;
}

function addBulkExpenses() {
  const input = $("#bulkExpenseInput");
  if (!input) return;
  const parsed = parseBulkExpenses(input.value);
  if (!parsed.length) return;
  state.settlementItems = [...state.settlementItems, ...parsed];
  input.value = "";
  editingSettlementIndex = state.settlementItems.length - parsed.length;
  render();
}

function selectedSettlementItem() {
  return state.settlementItems[editingSettlementIndex] || null;
}

function openItemEdit(index) {
  editingSettlementIndex = index;
  renderItemEditDialog();
}

function closeItemEdit() {
  editingSettlementIndex = null;
  renderItemEditDialog();
}

function renderItemEditDialog() {
  const dialog = $("#itemEditDialog");
  if (!dialog) return;
  const item = selectedSettlementItem();
  dialog.classList.toggle("hidden", state.mode !== "settlement" || !item);
  if (!item) return;
  $("#editItemName").value = item.name || "";
  $("#editItemAmount").value = item.amount || "";
  $("#editItemQuantity").value = itemQuantity(item);
  normalizeSubItems(item);
  renderQuantityLines(item);
  $("#editItemPayer").value = item.payer || "";
  $("#editItemCompleted").checked = !!item.completed;
  $("#editItemNote").value = item.note || "";
  $("#editItemProxyEnabled").checked = !!item.proxyEnabled;
  const members = currentMembers();
  const payerOptions = ["공금", ...members];
  $("#editPayerChoices").innerHTML = payerOptions.map((name) => `<button class="receipt-member-choice ${(item.payer || "") === name ? "active" : ""}" data-edit-payer="${escapeHtml(name)}" type="button">${escapeHtml(name)}</button>`).join("");
  $("#editMemberChoices").innerHTML = members.map((name) => `<button class="receipt-member-choice ${(item.members || []).includes(name) ? "active" : ""}" data-edit-member="${escapeHtml(name)}" type="button">${escapeHtml(name)}</button>`).join("");
  $("#proxyPicker").classList.toggle("hidden", !item.proxyEnabled);
  $("#editProxyChoices").innerHTML = members.map((name) => `<button class="receipt-member-choice ${(item.proxyPayers || []).includes(name) ? "active" : ""}" data-edit-proxy="${escapeHtml(name)}" type="button">${escapeHtml(name)}</button>`).join("");
  $("#editProxyForChoices").innerHTML = members.map((name) => `<button class="receipt-member-choice ${(item.proxyFor || []).includes(name) ? "active" : ""}" data-edit-proxy-for="${escapeHtml(name)}" type="button">${escapeHtml(name)}</button>`).join("");
}

function renderQuantityLines(item) {
  const quantity = itemQuantity(item);
  const wrap = $("#quantityBreakdown");
  const list = $("#quantityLines");
  const members = currentMembers();
  if (!wrap || !list) return;
  if (quantity < 2 && !item.storeGroup) {
    wrap.classList.add("hidden");
    list.replaceChildren();
    return;
  }
  wrap.classList.remove("hidden");
  const subItems = normalizeSubItems(item);
  list.innerHTML = subItems.map((subItem, index) => `
    <div class="quantity-line" data-quantity-index="${index}">
      <div class="quantity-line-head">
        <span>${index + 1}</span>
        <input data-sub-field="name" value="${escapeHtml(subItem.name)}" placeholder="세부 항목">
        <input data-sub-field="amount" inputmode="numeric" value="${escapeHtml(subItem.amount)}" placeholder="금액">
        <button class="sub-remove" data-remove-sub="${index}" type="button" ${subItems.length <= 1 ? "disabled" : ""}>삭제</button>
      </div>
      <input data-sub-field="note" value="${escapeHtml(subItem.note)}" placeholder="세부 메모">
      <button class="sub-complete-button ${subItem.completed === undefined ? (item.completed ? "active" : "") : (subItem.completed ? "active" : "")}" data-sub-completed-toggle="${index}" type="button" aria-pressed="${subItem.completed === undefined ? !!item.completed : !!subItem.completed}">
        ${subItem.completed === undefined ? (item.completed ? "정산완료" : "정산완료 처리") : (subItem.completed ? "정산완료" : "정산완료 처리")}
      </button>
      <div class="sub-choice-block">
        <button class="complete-check ${subItem.customMembers ? "active" : ""}" data-sub-custom-members-toggle="${index}" type="button" aria-pressed="${!!subItem.customMembers}">
          ${subItem.customMembers ? "메뉴별 참여자 선택 중 ✓" : "이 메뉴만 참여자 따로 선택"}
        </button>
        <div class="receipt-member-choices ${subItem.customMembers ? "" : "hidden"}">
          ${members.map((name) => `<button class="receipt-member-choice ${unitUsedBy(subItem, item).includes(name) ? "active" : ""}" data-sub-member="${escapeHtml(name)}" data-sub-index="${index}" type="button">${escapeHtml(name)}</button>`).join("")}
        </div>
        ${subItem.customMembers ? "" : "<small>장소 기본 참여자가 적용돼요.</small>"}
      </div>
      <label class="complete-check sub-proxy-toggle">
        <input data-sub-proxy-toggle="${index}" type="checkbox" ${unitProxyEnabled(subItem, item) ? "checked" : ""}>
        이 세부항목 대신 결제
      </label>
      <div class="sub-proxy-panel ${unitProxyEnabled(subItem, item) ? "" : "hidden"}">
        <div class="sub-choice-block">
          <strong>N빵 부담할 사람</strong>
          <div class="receipt-member-choices">
            ${members.map((name) => `<button class="receipt-member-choice ${unitProxyPayers(subItem, item).includes(name) ? "active" : ""}" data-sub-proxy="${escapeHtml(name)}" data-sub-index="${index}" type="button">${escapeHtml(name)}</button>`).join("")}
          </div>
        </div>
        <div class="sub-choice-block">
          <strong>대신 결제 대상</strong>
          <div class="receipt-member-choices">
            ${members.map((name) => `<button class="receipt-member-choice ${unitProxyFor(subItem, item).includes(name) ? "active" : ""}" data-sub-proxy-for="${escapeHtml(name)}" data-sub-index="${index}" type="button">${escapeHtml(name)}</button>`).join("")}
          </div>
        </div>
      </div>
    </div>
  `).join("");
  list.insertAdjacentHTML("beforeend", `<button class="secondary sub-add" id="addSubItemBtn" type="button">+ 세부항목 추가</button>`);
}

function syncQuantityTotal(item) {
  if (!item) return;
  const total = subItemsTotal(item);
  if (total > 0) {
    item.amount = String(total);
    $("#editItemAmount").value = item.amount;
  }
}

function syncItemEditDialog() {
  const item = selectedSettlementItem();
  if (!item) return;
  item.name = $("#editItemName").value;
  item.amount = $("#editItemAmount").value;
  item.quantity = itemQuantity({ quantity: $("#editItemQuantity").value });
  normalizeSubItems(item);
  item.payer = $("#editItemPayer").value;
  item.completed = $("#editItemCompleted").checked;
  item.note = $("#editItemNote").value;
  renderQuantityLines(item);
  renderReceipt();
  save();
}

// Every edit used to hit Firebase within 250ms — including pushing
// half-finished items into the shared meeting's expense ledger via
// registerSettlementExpenses(), so everyone's balance could shift mid-edit
// before the writer ever meant to commit anything. Now save() only mirrors
// the in-progress draft into localStorage (so a refresh doesn't lose it) —
// nothing reaches Firebase until 임시 저장 or 발행하기 is tapped.
function save() {
  if (isReadonly) return;
  if (!state.receiptId) state.receiptId = makeReceiptId();
  try { localStorage.setItem(localDraftKey, JSON.stringify(state)); } catch { /* ignore */ }
}

async function saveDraft(button) {
  if (isReadonly) return;
  if (![...state.budgetItems, ...state.settlementItems].length) return;
  if (!state.receiptId) state.receiptId = makeReceiptId();
  const updatedAt = Date.now();
  state.updatedAt = updatedAt;
  await firebasePut(`receipts/${state.receiptId}`, { ...state, roomId, updatedAt, published: false });
  localStorage.setItem(storageKey, state.receiptId);
  clearLocalDraft();
  if (button) {
    const oldText = button.textContent;
    button.textContent = "임시 저장됨";
    setTimeout(() => { button.textContent = oldText; }, 1400);
  }
}

async function persistReceipt() {
  if (isReadonly) return;
  if (![...state.budgetItems, ...state.settlementItems].length) return;
  if (!state.receiptId) state.receiptId = makeReceiptId();
  const updatedAt = Date.now();
  state.updatedAt = updatedAt;
  await firebasePut(`receipts/${state.receiptId}`, { ...state, roomId, updatedAt });
  localStorage.setItem(storageKey, state.receiptId);
  clearLocalDraft();
  await registerSettlementExpenses();
}

function startReadonlyReceiptSync() {
  const receiptId = pageParams.get("id");
  if (!isReadonly || !receiptId) return;
  let checking = false;
  setInterval(async () => {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const remote = await firebaseGet(`receipts/${receiptId}`);
      if (remote && Number(remote.updatedAt || 0) > Number(state.updatedAt || 0)) {
        state = { ...state, ...remote };
        renderReceipt();
      }
    } catch (error) {
      console.error(error);
    } finally {
      checking = false;
    }
  }, 1000);
}

function currentItems() {
  return state.mode === "budget" ? state.budgetItems : state.settlementItems;
}

function setCurrentItems(items) {
  if (state.mode === "budget") state.budgetItems = items;
  else state.settlementItems = items;
}

function itemTotal(item) {
  const subTotal = subItemsTotal(item);
  return subTotal > 0 ? subTotal : onlyNumber(item.amount);
}

function syncFromInputs() {
  state.title = $("#titleInput").value;
  state.event = $("#eventInput").value;
  state.usedDate = $("#usedDateInput").value;
  state.plannedDate = $("#plannedDateInput").value;
  state.writer = $("#writerInput").value;
  state.splitType = $("#splitTypeInput").value;
  state.settlementMemo = "";
  state.memo = $("#memoInput").value;
}

function renderInputs() {
  const meetingNames = settlementMeetings().map((meeting) => meeting?.state?.title).filter(Boolean);
  const eventOptions = ["", ...new Set(meetingNames)];
  $("#eventInput").innerHTML = eventOptions.map((name) => `<option value="${escapeHtml(name)}">${name ? escapeHtml(name) : "모임 선택"}</option>`).join("");
  if (eventOptions.includes(state.event)) $("#eventInput").value = state.event;
  else if (state.event) {
    $("#eventInput").insertAdjacentHTML("beforeend", `<option value="${escapeHtml(state.event)}">${escapeHtml(state.event)}</option>`);
    $("#eventInput").value = state.event;
  }
  $("#titleInput").value = state.title;
  $("#usedDateInput").value = state.usedDate;
  $("#plannedDateInput").value = state.plannedDate;
  $("#writerInput").value = state.writer;
  $("#splitTypeInput").value = state.splitType;
  $("#memoInput").value = state.memo;
  $$(".mode-switch button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
  $(".settlement-only").classList.toggle("hidden", state.mode !== "settlement");
  $(".budget-date-field").classList.toggle("hidden", state.mode !== "budget");
  $(".settlement-date-field").classList.toggle("hidden", state.mode !== "settlement");
  $("#itemsTitle").textContent = state.mode === "budget" ? "예산 항목" : "정산 항목";
  $("#workspaceTitle").textContent = state.mode === "budget" ? "예산 영수증" : "정산 영수증";
}

function renderEditorItems() {
  const bulkBox = $("#settlementBulkBox");
  if (bulkBox) bulkBox.classList.toggle("hidden", state.mode !== "settlement");
  const editor = $("#itemsEditor");
  if (!editor) return;
  if (state.mode === "settlement") {
    editor.innerHTML = "";
    renderItemEditDialog();
    return;
  }
  editor.innerHTML = currentItems().map((item, index) => `
    <div class="item-card" data-index="${index}">
      <div class="item-grid">
        <label>내용
          <input data-field="name" value="${escapeHtml(item.name || "")}" placeholder="예: 식비">
        </label>
        <label>금액
          <input data-field="amount" inputmode="numeric" value="${escapeHtml(item.amount || "")}">
        </label>
        <button data-remove="${index}" type="button">×</button>
      </div>
      <label>설명
        <input data-field="note" value="${escapeHtml(item.note || "")}" placeholder="영수증에 작게 표시될 메모">
      </label>
    </div>
  `).join("");
}

// Duplicate units of the same product (e.g. "숙주 1".."숙주 4") get a numbered
// suffix at input time so each unit can carry its own usage assignment. The
// settlement receipt no longer shows per-unit usage, so those numbered
// duplicates are collapsed back into a single "숙주 ×4" line with the
// combined price — otherwise the receipt reads like 4 unrelated items.
function groupedSubItemsForDisplay(subItems, item) {
  if (state.mode !== "settlement") return subItems.map((s) => ({ ...s, count: 1 }));
  // A sub-item with no completed flag of its own inherits the parent item's
  // status (same fallback the row renderer uses) — resolve that here before
  // merging duplicates, so the group's status isn't just "undefined defaults
  // to done".
  const resolvedCompleted = (s) => (s.completed === undefined ? !!item.completed : !!s.completed);
  const groups = [];
  const indexByBase = new Map();
  subItems.forEach((s) => {
    const base = String(s.name || "").trim().replace(/\s+\d+$/, "") || s.name;
    const doneHere = resolvedCompleted(s);
    if (indexByBase.has(base)) {
      const group = groups[indexByBase.get(base)];
      group.amount = String(onlyNumber(group.amount) + onlyNumber(s.amount));
      group.count += 1;
      group.completed = group.completed && doneHere;
    } else {
      indexByBase.set(base, groups.length);
      groups.push({ ...s, name: base, count: 1, completed: doneHere });
    }
  });
  return groups;
}

function renderReceipt() {
  const items = currentItems();
  const grandTotal = items.reduce((sum, item) => sum + itemTotal(item), 0);
  const receiptTypeLabel = state.mode === "budget" ? "예산 영수증" : "정산 영수증";
  document.title = receiptShareTitle();

  $("#receipt").classList.toggle("settlement-receipt", state.mode === "settlement");
  $("#receiptTableHead").classList.remove("settlement-columns");
  $("#receiptTableHead").innerHTML = "<span>항목</span><span>금액</span>";

  $("#receiptLogo").textContent = receiptTypeLabel;
  $("#receiptTitle").textContent = state.title || (state.mode === "budget" ? "예산 영수증" : "정산 영수증");
  $("#receiptSubtitle").textContent = state.event || "모임 이름";
  $("#receiptUsedDate").parentElement.classList.toggle("hidden", state.mode !== "settlement");
  $("#receiptPlannedDate").parentElement.classList.toggle("hidden", state.mode !== "budget");
  $("#receiptUsedDate").textContent = state.usedDate || "-";
  $("#receiptPlannedDate").textContent = state.plannedDate || "-";
  $("#receiptWriter").textContent = state.writer || "-";
  $("#receiptMemo").textContent = state.memo || "";

  $("#receiptItems").innerHTML = items.length ? items.map((item, index) => {
    const quantity = itemQuantity(item);
    const hasSubRows = (quantity > 1 || item.storeGroup) && itemSubItems(item).length;
    const isExpanded = expandedReceiptItems.has(index);
    const subRows = hasSubRows ? `
      <div class="receipt-subrows ${isExpanded ? "is-open" : ""}">
        ${groupedSubItemsForDisplay(itemSubItems(item), item).map((subItem, subIndex) => `
          <div class="receipt-subrow ${subItem.completed === undefined ? (item.completed ? "completed" : "") : (subItem.completed ? "completed" : "")}">
            <span><strong class="receipt-sub-store">${escapeHtml(subItem.name || `세부항목 ${subIndex + 1}`)}</strong>${subItem.completed === undefined ? (item.completed ? '<em class="complete-mark">정산완료</em>' : "") : (subItem.completed ? '<em class="complete-mark">정산완료</em>' : "")}<small>${escapeHtml([state.mode === "settlement" ? "" : unitUsageSummary(subItem, item), subItem.note].filter(Boolean).join(" · "))}</small></span>
            <span class="receipt-subrow-qty">${subItem.count > 1 ? `${subItem.count}개` : ""}</span>
            <b>${formatWon(onlyNumber(subItem.amount))}</b>
          </div>
        `).join("")}
      </div>
    ` : "";
    return `
    <div class="receipt-item-block">
      <div class="receipt-row ${state.mode === "settlement" && item.completed ? "completed" : ""} ${item.tentative ? "tentative" : ""} ${state.mode === "settlement" && !isReadonly ? "clickable" : ""}" ${state.mode === "settlement" && !isReadonly ? `data-edit-receipt-item="${index}"` : ""}>
        <span class="item-name"><strong>${escapeHtml(item.name || "항목")}</strong><span class="receipt-badges">${`<em class="qty-mark">${quantity}개</em>`}${item.tentative ? `<em class="tentative-mark">메뉴 미정</em>` : ""}${state.mode === "settlement" && item.completed ? `<em class="complete-mark">정산완료</em>` : ""}</span><small class="item-note">${state.mode === "settlement" ? escapeHtml((state.usedDate || "-").slice(5).replace("-", ".")) : escapeHtml(item.note || "")}</small></span>
        <span class="receipt-row-actions">${!isReadonly ? `<button class="tentative-toggle ${item.tentative ? "active" : ""}" data-toggle-tentative="${index}" type="button" aria-pressed="${!!item.tentative}">임시</button>` : ""}<b>${formatWon(itemTotal(item))}</b>${hasSubRows ? `<button class="detail-toggle ${isExpanded ? "is-open" : ""}" data-toggle-receipt-details="${index}" type="button" aria-label="세부항목 ${isExpanded ? "접기" : "펼치기"}" aria-expanded="${isExpanded}"><span></span></button>` : ""}</span>
      </div>
      ${subRows}
    </div>
  `;
  }).join("") : `<div class="receipt-row"><span class="item-name">항목 없음</span><span>0원</span></div>`;

  $("#grandTotalText").textContent = formatWon(grandTotal);
  if ($("#editorItemCount")) $("#editorItemCount").textContent = `${items.length}개`;
  if ($("#editorTotalText")) $("#editorTotalText").textContent = formatWon(grandTotal);

  const transferRows = calculateTransfers();
  const transferTotal = transferRows.filter((item) => !item.completed).reduce((sum, item) => sum + item.amount, 0);
  const transferGroups = [...transferRows.reduce((groups, item) => {
    const group = groups.get(item.from) || { from: item.from, items: [], total: 0 };
    group.items.push(item);
    group.total += item.amount;
    groups.set(item.from, group);
    return groups;
  }, new Map()).values()];
  $("#transferReceiptWrap").classList.toggle("hidden", state.mode !== "settlement");
  $("#transferSubtitle").textContent = state.event || "모임 이름";
  $("#transferDate").textContent = state.usedDate || "-";
  $("#transferItems").innerHTML = transferGroups.length ? transferGroups.map((group) => `
    <section class="transfer-sender-group">
      <header class="transfer-sender-head">
        <div><span>보낼 사람</span><strong>${escapeHtml(group.from)}</strong></div>
        <div><span>총 보낼 금액</span><strong>${formatWon(group.total)}</strong></div>
      </header>
      <div class="transfer-recipient-list">
        ${group.items.map((item) => {
          const transferKey = item.transferKey;
          const hasDetails = (item.details || []).length > 0;
          const isExpanded = expandedTransferRows.has(transferKey);
          const detailHtml = (item.details || []).map((detail) => `
            <div class="transfer-detail-item ${detail.offset ? "offset" : ""} ${detail.completed ? "completed" : ""}">
              <div class="transfer-detail-head">
                <span class="transfer-detail-name">${detail.offset ? "차감 " : ""}${escapeHtml(detail.name)}</span>
                <b>${formatWon(detail.amount)}</b>
              </div>
              ${detail.completed ? '<div class="transfer-status">상태: 정산완료</div>' : ""}
              <div class="transfer-meta"><span>${escapeHtml(compactDetailMemo(detail))}</span></div>
            </div>
          `).join("");
          return `
            <div class="transfer-line ${item.completed ? "completed" : ""}">
              <span>
                <span class="route"><b>${escapeHtml(item.to)}</b>에게${item.completed ? '<em class="transfer-complete-mark">정산완료</em>' : ""}</span>
                <span class="detail ${isExpanded ? "is-open" : ""}">${detailHtml || "정산 영수증 기준 자동 계산"}</span>
              </span>
              <span class="transfer-row-actions"><strong>${formatWon(item.amount)}</strong>${!isReadonly ? `<button class="transfer-person-complete ${item.completed ? "active" : ""}" data-complete-transfer="${escapeHtml(item.transferKey)}" type="button">${item.completed ? "완료 취소" : "정산완료"}</button>` : ""}${hasDetails ? `<button class="detail-toggle ${isExpanded ? "is-open" : ""}" data-toggle-transfer-details="${escapeHtml(transferKey)}" type="button" aria-label="${escapeHtml(item.to)}에게 보내는 세부내역 ${isExpanded ? "접기" : "펼치기"}" aria-expanded="${isExpanded}"><span></span></button>` : ""}</span>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `).join("") : `<div class="transfer-line"><span class="route">보낼 금액 없음</span><strong>0원</strong></div>`;
  $("#transferTotalText").textContent = formatWon(transferTotal);
}

function compactDetailMemo(detail) {
  const used = formatUsageWithProxy(namesFrom(detail.usedBy), namesFrom(detail.proxyFor)) || "사용자 미선택";
  if (!detail.proxyEnabled) return `사용: ${used}`;
  return `사용: ${used} · ${summarizePeople(detail.proxyPayers)}`;
}

function render() {
  renderInputs();
  renderEditorItems();
  renderReceipt();
  if (isEditingExistingReceipt && $("#editingBanner")) {
    $("#editingBanner").classList.remove("hidden");
    $("#editingReceiptTitle").textContent = state.title || (state.mode === "budget" ? "예산 영수증" : "정산 영수증");
    $("#expenseActionBtn").textContent = "수정 내용 저장";
  }
  save();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function wrapCanvasText(context, text, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (context.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function drawText(context, text, x, y, options = {}) {
  const { maxWidth = 560, lineHeight = 24, align = "left" } = options;
  context.textAlign = align;
  const lines = wrapCanvasText(context, text, maxWidth);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

async function downloadReceiptImage() {
  syncFromInputs();
  renderReceipt();
  const items = currentItems();
  const total = items.reduce((sum, item) => sum + itemTotal(item), 0);
  const width = 860;
  const padding = 72;
  const line = (y) => {
    context.strokeStyle = "#b9bdb9";
    context.setLineDash([8, 7]);
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();
    context.setLineDash([]);
  };

  const canvas = document.createElement("canvas");
  const subLineCount = items.reduce((sum, item) => sum + (itemQuantity(item) > 1 || item.storeGroup ? itemSubItems(item).length : 0), 0);
  const estimatedHeight = 700 + items.length * 92 + subLineCount * 58 + (state.mode === "settlement" ? 190 : 0);
  canvas.width = width;
  canvas.height = Math.max(900, estimatedHeight);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f3f6f4";
  context.fillRect(0, 0, width, canvas.height);
  context.fillStyle = "#fffdf8";
  context.fillRect(30, 24, width - 60, canvas.height - 48);
  context.fillStyle = "#f3f6f4";
  for (let x = 34; x < width - 24; x += 18) {
    context.beginPath();
    context.arc(x, 24, 7, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.arc(x, canvas.height - 24, 7, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#1c1c1b";

  let y = 72;
  context.textAlign = "center";
  context.font = "700 23px Malgun Gothic, sans-serif";
  context.fillStyle = "#0f8f70";
  context.fillText(state.mode === "budget" ? "예산 영수증" : "정산 영수증", width / 2, y);
  y += 48;
  context.fillStyle = "#1c1c1b";
  context.font = "900 40px Malgun Gothic, sans-serif";
  y = drawText(context, state.title || (state.mode === "budget" ? "예산 영수증" : "정산 영수증"), width / 2, y, { maxWidth: 680, lineHeight: 46, align: "center" }) + 10;
  context.font = "700 22px Malgun Gothic, sans-serif";
  context.fillStyle = "#5f6561";
  context.fillText(state.event || "모임 이름", width / 2, y);
  y += 44;
  line(y);
  y += 36;

  context.textAlign = "left";
  context.fillStyle = "#1c1c1b";
  context.font = "800 21px Malgun Gothic, sans-serif";
  const dateLabel = state.mode === "settlement" ? "사용일" : "사용예정일";
  const dateValue = state.mode === "settlement" ? state.usedDate : state.plannedDate;
  [[dateLabel, dateValue || "-"], ["작성자", state.writer || "-"]].forEach(([label, value]) => {
    context.fillStyle = "#6c716e";
    context.fillText(label, padding, y);
    context.fillStyle = "#1c1c1b";
    context.textAlign = "right";
    context.fillText(value, width - padding, y);
    context.textAlign = "left";
    y += 34;
  });
  y += 8;
  line(y);
  y += 36;

  context.font = "900 18px Malgun Gothic, sans-serif";
  context.fillStyle = "#6c716e";
  context.fillText("내용", padding, y);
  context.textAlign = "right";
  context.fillText("금액", width - padding, y);
  context.textAlign = "left";
  y += 20;
  context.strokeStyle = "#aeb3af";
  context.beginPath();
  context.moveTo(padding, y);
  context.lineTo(width - padding, y);
  context.stroke();
  y += 34;

  context.font = "900 22px Malgun Gothic, sans-serif";
  if (!items.length) {
    context.fillText("항목 없음", padding, y);
    context.textAlign = "right";
    context.fillText("0원", width - padding, y);
    context.textAlign = "left";
    y += 42;
  }
  items.forEach((item) => {
    context.fillStyle = "#1c1c1b";
    context.font = "900 22px Malgun Gothic, sans-serif";
    const nameY = y;
  y = drawText(context, item.name || "항목", padding, y, { maxWidth: 520, lineHeight: 28 });
    const badgeLabels = [
      { label: `${itemQuantity(item)}개`, tone: "mint" },
      item.tentative ? { label: "메뉴 미정", tone: "amber" } : null,
      state.mode === "settlement" && item.completed ? { label: "정산완료", tone: "mint" } : null
    ].filter(Boolean);
    if (badgeLabels.length) {
      context.font = "900 16px Malgun Gothic, sans-serif";
      let badgeX = padding;
      badgeLabels.forEach(({ label, tone }) => {
        const badgeWidth = context.measureText(label).width + 24;
        context.strokeStyle = tone === "amber" ? "rgba(224,144,10,.55)" : "rgba(15,143,112,.55)";
        context.fillStyle = tone === "amber" ? "rgba(224,144,10,.1)" : "rgba(32,201,151,.08)";
        context.beginPath();
        context.roundRect(badgeX, y + 2, badgeWidth, 25, 12);
        context.fill();
        context.stroke();
        context.fillStyle = tone === "amber" ? "#a85e00" : "#0f8f70";
        context.fillText(label, badgeX + 12, y + 21);
        badgeX += badgeWidth + 8;
      });
      y += 34;
    }
    if (item.note) {
      context.font = "700 17px Malgun Gothic, sans-serif";
      context.fillStyle = "#777";
      y = drawText(context, item.note, padding, y, { maxWidth: 520, lineHeight: 23 });
    }
    if ((itemQuantity(item) > 1 || item.storeGroup) && itemSubItems(item).length) {
      itemSubItems(item).forEach((subItem, subIndex) => {
        context.font = "800 16px Malgun Gothic, sans-serif";
        context.fillStyle = "#646b67";
        const subName = `${subIndex + 1}. ${subItem.name || ((item.name || "항목") + " " + (subIndex + 1))}`;
        y = drawText(context, subName, padding + 12, y, { maxWidth: 460, lineHeight: 21 });
        context.textAlign = "right";
        context.fillText(formatWon(onlyNumber(subItem.amount)), width - padding, y - 21);
        context.textAlign = "left";
        if (subItem.note) {
          context.font = "700 14px Malgun Gothic, sans-serif";
          context.fillStyle = "#858b87";
          y = drawText(context, subItem.note, padding + 26, y, { maxWidth: 440, lineHeight: 18 });
        }
        const subSummary = unitUsageSummary(subItem, item);
        if (subSummary) {
          context.font = "700 14px Malgun Gothic, sans-serif";
          context.fillStyle = "#858b87";
          y = drawText(context, subSummary, padding + 26, y, { maxWidth: 520, lineHeight: 18 });
        }
        y += 5;
      });
    }
    context.textAlign = "right";
    context.font = "900 22px Malgun Gothic, sans-serif";
    context.fillStyle = "#1c1c1b";
    context.fillText(formatWon(itemTotal(item)), width - padding, nameY);
    context.textAlign = "left";
    y += 20;
    context.strokeStyle = "#d8dad7";
    context.setLineDash([2, 5]);
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();
    context.setLineDash([]);
    y += 30;
  });

  line(y);
  y += 36;
  if (state.mode === "settlement") {
    context.font = "900 18px Malgun Gothic, sans-serif";
    context.fillStyle = "#1c1c1b";
    context.fillText("정산 요약", padding, y);
    y += 32;
    context.font = "800 19px Malgun Gothic, sans-serif";
    context.fillStyle = "#6c716e";
    context.fillText("정산 기준", padding, y);
    context.textAlign = "right";
    context.fillStyle = "#1c1c1b";
    context.fillText(state.splitType || "-", width - padding, y);
    context.textAlign = "left";
    y += 36;
    const transfers = calculateTransfers();
    y += 10;
    context.font = "900 18px Malgun Gothic, sans-serif";
    context.fillStyle = "#1c1c1b";
    context.fillText("송금 내역", padding, y);
    y += 32;
    if (transfers.length) {
      transfers.forEach((item) => {
        context.font = "900 20px Malgun Gothic, sans-serif";
        context.fillStyle = "#1c1c1b";
        context.fillText(`${item.from} → ${item.to}`, padding, y);
        context.textAlign = "right";
        context.fillText(formatWon(item.amount), width - padding, y);
        context.textAlign = "left";
        y += 32;
      });
    } else {
      context.font = "800 18px Malgun Gothic, sans-serif";
      context.fillText("보낼 금액 없음", padding, y);
      y += 28;
    }
  }
  context.strokeStyle = "#1d211f";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(padding, y);
  context.lineTo(width - padding, y);
  context.stroke();
  context.lineWidth = 1;
  y += 46;
  context.font = "900 28px Malgun Gothic, sans-serif";
  context.fillStyle = "#1c1c1b";
  context.fillText("총 합계", padding, y);
  context.textAlign = "right";
  context.fillText(formatWon(total), width - padding, y);
  context.textAlign = "left";
  y += 54;

  if (state.memo) {
    context.font = "900 16px Malgun Gothic, sans-serif";
    context.fillStyle = "#606662";
    context.fillText("확인 메모", padding, y);
    y += 26;
    context.font = "800 18px Malgun Gothic, sans-serif";
    context.fillStyle = "#1c1c1b";
    y = drawText(context, state.memo, padding, y, { maxWidth: 580, lineHeight: 25 });
  }
  if (state.mode !== "settlement") {
    const stampImage = await loadConfirmStampImage();
    if (stampImage) {
      const stampSize = 92;
      context.save();
      context.translate(width - 112, y - 10);
      context.rotate(-10 * Math.PI / 180);
      context.drawImage(stampImage, -stampSize / 2, -stampSize / 2, stampSize, stampSize);
      context.restore();
    }
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("이미지 파일을 만들지 못했어요.");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const fileDate = state.usedDate || state.plannedDate || todayKey();
  link.download = `${state.mode === "budget" ? "예산" : "정산"}_영수증_${fileDate}.png`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}

async function downloadTransferReceiptImage() {
  syncFromInputs();
  renderReceipt();
  const transfers = calculateTransfers();
  const transferTotal = transfers.reduce((sum, item) => sum + item.amount, 0);
  const width = 860;
  const padding = 72;
  const rowHeight = transfers.reduce((sum, row) => sum + 110 + (row.details || []).length * 86, 0);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(720, 390 + rowHeight);
  const context = canvas.getContext("2d");
  const line = (y) => {
    context.strokeStyle = "#b9bdb9";
    context.setLineDash([8, 7]);
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();
    context.setLineDash([]);
  };

  context.fillStyle = "#f3f6f4";
  context.fillRect(0, 0, width, canvas.height);
  context.fillStyle = "#fffdf8";
  context.fillRect(30, 24, width - 60, canvas.height - 48);
  context.fillStyle = "#f3f6f4";
  for (let x = 34; x < width - 24; x += 18) {
    context.beginPath();
    context.arc(x, 24, 7, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.arc(x, canvas.height - 24, 7, 0, Math.PI * 2);
    context.fill();
  }

  let y = 74;
  context.textAlign = "center";
  context.font = "700 23px Malgun Gothic, sans-serif";
  context.fillStyle = "#0f8f70";
  context.fillText("송금용 정산 영수증", width / 2, y);
  y += 48;
  context.fillStyle = "#1c1c1b";
  context.font = "900 40px Malgun Gothic, sans-serif";
  context.fillText("송금 내역", width / 2, y);
  y += 36;
  context.font = "700 22px Malgun Gothic, sans-serif";
  context.fillStyle = "#5f6561";
  context.fillText(state.event || "모임 이름", width / 2, y);
  y += 44;
  line(y);
  y += 38;

  context.textAlign = "left";
  context.font = "800 19px Malgun Gothic, sans-serif";
  context.fillStyle = "#6c716e";
  context.fillText("사용일", padding, y);
  context.fillStyle = "#1c1c1b";
  context.textAlign = "right";
  context.fillText(state.usedDate || "-", width - padding, y);
  context.textAlign = "left";
  y += 36;
  context.fillStyle = "#6c716e";
  context.fillText("기준", padding, y);
  context.fillStyle = "#1c1c1b";
  context.textAlign = "right";
  context.fillText("상호 차감 후", width - padding, y);
  context.textAlign = "left";
  y += 30;
  line(y);
  y += 36;

  if (!transfers.length) {
    context.font = "900 22px Malgun Gothic, sans-serif";
    context.fillStyle = "#1c1c1b";
    context.fillText("보낼 금액 없음", padding, y);
    context.textAlign = "right";
    context.fillText("0원", width - padding, y);
    context.textAlign = "left";
    y += 54;
  }

  transfers.forEach((row) => {
    context.font = "900 24px Malgun Gothic, sans-serif";
    context.fillStyle = "#1c1c1b";
    context.fillText(`${row.from} → ${row.to}`, padding, y);
    context.textAlign = "right";
    context.fillText(formatWon(row.amount), width - padding, y);
    context.textAlign = "left";
    y += 38;

    (row.details || []).forEach((detail) => {
      const detailName = `${detail.offset ? "차감 " : ""}${detail.name || "정산 항목"}`;
      context.font = "800 17px Malgun Gothic, sans-serif";
      context.fillStyle = detail.offset ? "#9a706a" : "#5f6561";
      context.fillText(detailName, padding + 16, y);
      context.textAlign = "right";
      context.font = "900 17px Malgun Gothic, sans-serif";
      context.fillStyle = "#4f5753";
      context.fillText(formatWon(detail.amount), width - padding, y);
      context.textAlign = "left";
      y += 26;
      if (detail.completed) {
        context.font = "900 15px Malgun Gothic, sans-serif";
        context.fillStyle = "#0f8f70";
        context.fillText("상태: 정산완료", padding + 16, y);
        y += 24;
      }
      context.font = "800 15px Malgun Gothic, sans-serif";
      context.fillStyle = "#858b87";
      y = drawText(context, compactDetailMemo(detail), padding + 16, y, { maxWidth: 560, lineHeight: 22 });
      y += 16;
    });
    context.strokeStyle = "#d8dad7";
    context.setLineDash([2, 5]);
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();
    context.setLineDash([]);
    y += 28;
  });

  context.strokeStyle = "#1d211f";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(padding, y);
  context.lineTo(width - padding, y);
  context.stroke();
  context.lineWidth = 1;
  y += 48;
  context.font = "900 28px Malgun Gothic, sans-serif";
  context.fillStyle = "#1c1c1b";
  context.fillText("송금 합계", padding, y);
  context.textAlign = "right";
  context.fillText(formatWon(transferTotal), width - padding, y);
  context.textAlign = "left";

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("송금용 이미지 파일을 만들지 못했어요.");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const fileDate = state.usedDate || todayKey();
  link.download = `송금용_정산영수증_${fileDate}.png`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}

async function saveReceiptImageFromButton(button) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "이미지 만드는 중...";
  try {
    await downloadReceiptImage();
    if (state.mode === "settlement") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await downloadTransferReceiptImage();
      button.textContent = "2장 저장 완료";
    } else {
      button.textContent = "저장 완료";
    }
    setTimeout(() => {
      button.textContent = oldText;
      button.disabled = false;
    }, 1400);
  } catch (error) {
    console.error(error);
    button.textContent = "저장 실패";
    alert("이미지 저장에 실패했어요. 브라우저 다운로드 권한이나 파일 열기 방식 때문에 막혔을 수 있어요.");
    setTimeout(() => {
      button.textContent = oldText;
      button.disabled = false;
    }, 1400);
  }
}

document.addEventListener("input", (event) => {
  if (event.target.closest("#itemEditDialog")) {
    const item = selectedSettlementItem();
    if (event.target.dataset.subField && item) {
      const row = event.target.closest("[data-quantity-index]");
      const index = Number(row?.dataset.quantityIndex);
      normalizeSubItems(item);
      if (item.subItems[index]) item.subItems[index][event.target.dataset.subField] = event.target.value;
      syncQuantityTotal(item);
      renderReceipt();
      save();
      return;
    }
    syncItemEditDialog();
    return;
  }
  if (event.target.closest(".item-card")) {
    const card = event.target.closest(".item-card");
    const items = currentItems();
    const item = items[Number(card.dataset.index)];
    if (event.target.dataset.field === "completed") item.completed = event.target.checked;
    else item[event.target.dataset.field] = event.target.value;
    setCurrentItems(items);
  } else {
    syncFromInputs();
  }
  renderReceipt();
  save();
});

document.addEventListener("change", (event) => {
  if (event.target.closest("#itemEditDialog")) {
    syncItemEditDialog();
    return;
  }
  if (event.target.matches("select,input[type='date']")) {
    syncFromInputs();
    if (event.target.id === "eventInput") render();
    else {
      renderReceipt();
      save();
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target.id !== "bulkExpenseInput" || event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  addBulkExpenses();
});

document.addEventListener("click", (event) => {
  if (event.target.id === "expenseActionBtn") {
    const playSuccessSound = prepareSuccessSound();
    publishReceipt().then(playSuccessSound).catch(() => alert("영수증을 발행하지 못했습니다."));
    return;
  }
  if (event.target.id === "draftSaveBtn") {
    saveDraft(event.target).catch(() => {
      event.target.textContent = "임시 저장 실패";
      setTimeout(() => { event.target.textContent = "임시 저장"; }, 1400);
    });
    return;
  }
  if (event.target.id === "publishShareBtn" || event.target.id === "viewShareBtn") {
    shareOrCopyReceiptLink(event.target, "영수증 링크 공유").catch(() => {
      event.target.textContent = "링크 복사 실패";
      setTimeout(() => { event.target.textContent = "영수증 링크 공유"; }, 1400);
    });
    return;
  }
  if (event.target.id === "publishConfirmBtn") {
    $("#publishSuccess").classList.add("hidden");
    return;
  }
  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) {
    syncFromInputs();
    state.mode = modeButton.dataset.mode;
    if (state.mode === "budget") {
      state.title = "";
    } else {
      state.title = "";
    }
    render();
  }

  if (event.target.id === "addItemBtn") {
    if (state.mode === "settlement") {
      addBulkExpenses();
      return;
    }
    const items = currentItems();
    items.push({ name: "", note: "", amount: "" });
    setCurrentItems(items);
    render();
  }

  const receiptDetailToggle = event.target.closest("[data-toggle-receipt-details]");
  if (receiptDetailToggle) {
    const index = Number(receiptDetailToggle.dataset.toggleReceiptDetails);
    if (expandedReceiptItems.has(index)) expandedReceiptItems.delete(index);
    else expandedReceiptItems.add(index);
    renderReceipt();
    return;
  }

  const tentativeToggle = event.target.closest("[data-toggle-tentative]");
  if (tentativeToggle) {
    const items = currentItems();
    const item = items[Number(tentativeToggle.dataset.toggleTentative)];
    if (item) {
      item.tentative = !item.tentative;
      setCurrentItems(items);
      renderReceipt();
      save();
    }
    return;
  }

  const transferDetailToggle = event.target.closest("[data-toggle-transfer-details]");
  if (transferDetailToggle) {
    const key = transferDetailToggle.dataset.toggleTransferDetails;
    if (expandedTransferRows.has(key)) expandedTransferRows.delete(key);
    else expandedTransferRows.add(key);
    renderReceipt();
    return;
  }

  const transferCompleteButton = event.target.closest("[data-complete-transfer]");
  if (transferCompleteButton) {
    const key = transferCompleteButton.dataset.completeTransfer;
    state.completedTransfers = state.completedTransfers || {};
    state.completedTransfers[key] = !state.completedTransfers[key];
    if (!state.completedTransfers[key]) delete state.completedTransfers[key];
    renderReceipt();
    save();
    return;
  }

  const receiptItem = event.target.closest("[data-edit-receipt-item]");
  if (receiptItem) {
    openItemEdit(Number(receiptItem.dataset.editReceiptItem));
  }

  const item = selectedSettlementItem();
  const toggleSubName = (index, field, name) => {
    if (!item) return;
    normalizeSubItems(item);
    const subItem = item.subItems[index];
    if (!subItem) return;
    const inherited = field === "members"
      ? unitUsedBy(subItem, item)
      : field === "proxyPayers"
        ? unitProxyPayers(subItem, item)
        : unitProxyFor(subItem, item);
    subItem[field] = namesFrom(subItem[field]).length ? namesFrom(subItem[field]) : [...inherited];
    if (subItem[field].includes(name)) subItem[field] = subItem[field].filter((member) => member !== name);
    else subItem[field].push(name);
    renderItemEditDialog();
    renderReceipt();
    save();
  };

  const subMember = event.target.closest("[data-sub-member]");
  if (subMember) {
    toggleSubName(Number(subMember.dataset.subIndex), "members", subMember.dataset.subMember);
  }

  const subCustomMembersToggle = event.target.closest("[data-sub-custom-members-toggle]");
  if (subCustomMembersToggle) {
    if (!item) return;
    const index = Number(subCustomMembersToggle.dataset.subCustomMembersToggle);
    normalizeSubItems(item);
    const subItem = item.subItems[index];
    if (!subItem) return;
    subItem.customMembers = !subItem.customMembers;
    if (subItem.customMembers) subItem.members = [...itemUsedBy(item)];
    else delete subItem.members;
    renderItemEditDialog();
    renderReceipt();
    save();
    return;
  }

  const subProxy = event.target.closest("[data-sub-proxy]");
  if (subProxy) {
    toggleSubName(Number(subProxy.dataset.subIndex), "proxyPayers", subProxy.dataset.subProxy);
  }

  const subProxyFor = event.target.closest("[data-sub-proxy-for]");
  if (subProxyFor) {
    toggleSubName(Number(subProxyFor.dataset.subIndex), "proxyFor", subProxyFor.dataset.subProxyFor);
  }

  const subCompletedToggle = event.target.closest("[data-sub-completed-toggle]");
  if (subCompletedToggle) {
    if (!item) return;
    const index = Number(subCompletedToggle.dataset.subCompletedToggle);
    normalizeSubItems(item);
    const subItem = item.subItems[index];
    if (!subItem) return;
    const currentValue = subItem.completed === undefined ? !!item.completed : !!subItem.completed;
    subItem.completed = !currentValue;
    renderItemEditDialog();
    renderReceipt();
    save();
    return;
  }

  if (event.target.dataset.subProxyToggle !== undefined) {
    if (!item) return;
    const index = Number(event.target.dataset.subProxyToggle);
    normalizeSubItems(item);
    if (item.subItems[index]) item.subItems[index].proxyEnabled = event.target.checked;
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  if (event.target.id === "addSubItemBtn") {
    if (!item) return;
    normalizeSubItems(item);
    const totalBefore = itemTotal(item);
    item.subItems.push({ name: `${item.name || "항목"} ${item.subItems.length + 1}`, amount: "", note: "", customMembers: false, proxyEnabled: false, proxyPayers: [], proxyFor: [] });
    item.quantity = item.subItems.length;
    if (totalBefore && !subItemsHaveAmount(item)) item.amount = String(totalBefore);
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  if (event.target.dataset.removeSub !== undefined) {
    if (!item) return;
    normalizeSubItems(item);
    if (item.subItems.length <= 1) return;
    item.subItems.splice(Number(event.target.dataset.removeSub), 1);
    item.quantity = item.subItems.length;
    syncQuantityTotal(item);
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  const editMember = event.target.closest("[data-edit-member]");
  const editPayer = event.target.closest("[data-edit-payer]");
  if (editPayer) {
    const item = selectedSettlementItem();
    if (!item) return;
    item.payer = editPayer.dataset.editPayer;
    $("#editItemPayer").value = item.payer;
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  if (event.target.id === "editItemProxyEnabled") {
    const item = selectedSettlementItem();
    if (!item) return;
    item.proxyEnabled = event.target.checked;
    item.proxyPayers = Array.isArray(item.proxyPayers) ? item.proxyPayers : [];
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  if (editMember) {
    const item = selectedSettlementItem();
    if (!item) return;
    const name = editMember.dataset.editMember;
    item.members = Array.isArray(item.members) ? item.members : [];
    if (item.members.includes(name)) item.members = item.members.filter((member) => member !== name);
    else item.members.push(name);
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  const editProxy = event.target.closest("[data-edit-proxy]");
  if (editProxy) {
    const item = selectedSettlementItem();
    if (!item) return;
    const name = editProxy.dataset.editProxy;
    item.proxyPayers = Array.isArray(item.proxyPayers) ? item.proxyPayers : [];
    if (item.proxyPayers.includes(name)) item.proxyPayers = item.proxyPayers.filter((member) => member !== name);
    else item.proxyPayers.push(name);
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  const editProxyFor = event.target.closest("[data-edit-proxy-for]");
  if (editProxyFor) {
    const item = selectedSettlementItem();
    if (!item) return;
    const name = editProxyFor.dataset.editProxyFor;
    item.proxyFor = Array.isArray(item.proxyFor) ? item.proxyFor : [];
    if (item.proxyFor.includes(name)) item.proxyFor = item.proxyFor.filter((member) => member !== name);
    else item.proxyFor.push(name);
    renderItemEditDialog();
    renderReceipt();
    save();
  }

  if (event.target.id === "closeItemEditBtn" || event.target.id === "itemEditDialog") {
    closeItemEdit();
  }

  if (event.target.id === "deleteEditingItemBtn") {
    if (editingSettlementIndex === null) return;
    state.settlementItems.splice(editingSettlementIndex, 1);
    closeItemEdit();
    render();
  }

  const memberChoice = event.target.closest("[data-member-choice]");
  if (memberChoice) {
    const card = memberChoice.closest(".item-card");
    const items = currentItems();
    const item = items[Number(card.dataset.index)];
    const name = memberChoice.dataset.memberChoice;
    item.members = Array.isArray(item.members) ? item.members : [];
    if (item.members.includes(name)) item.members = item.members.filter((member) => member !== name);
    else item.members.push(name);
    setCurrentItems(items);
    render();
  }

  if (event.target.dataset.remove !== undefined) {
    const items = currentItems();
    items.splice(Number(event.target.dataset.remove), 1);
    setCurrentItems(items);
    render();
  }

  if (event.target.id === "resetBtn") {
    if (!confirm("입력한 내용을 초기화할까요?")) return;
    localStorage.removeItem(storageKey);
    clearLocalDraft();
    state = { mode: "budget", title: "", event: "", usedDate: "", plannedDate: "", writer: "", splitType: "1/N 정산", settlementMemo: "", completedTransfers: {}, memo: "", budgetItems: [], settlementItems: [], receiptId: makeReceiptId() };
    location.reload();
  }
});

if ($("#receiptHistoryLink") && roomId) $("#receiptHistoryLink").href = `history.html?room=${encodeURIComponent(roomId)}`;
// The static "크루로 돌아가기" link has no way to know the current room at
// author time — without ?room= carried over, 놀고정산.js's
// shouldStartOnLanding treats the bare landing page as "no room in the
// URL" and shows the intro/landing screen instead of jumping straight to
// the dashboard.
document.querySelectorAll(".back-link").forEach((link) => {
  if (roomId) link.href = `../index.html?room=${encodeURIComponent(roomId)}`;
});
await load();
render();
startReadonlyReceiptSync();
