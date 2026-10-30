import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getDatabase, ref, get, set, update, onValue } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

const storageKey = "nolgo-jeongsan-state-v2";
const roomStorageKey = "nolgo-jeongsan-room-id";
const siteUrl = typeof window !== "undefined" && window.location.origin
  ? (window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "/"))
  : "https://alpist12.github.io/nolgo/";
const initialQuery = new URLSearchParams(location.search);
const shouldStartOnLanding = initialQuery.has("landing") || !initialQuery.has("room");
// Matches the app's own DEFAULT_ROOM_ID (src/state/RoomContext.tsx) — this
// serves one shared friend group, not many independent groups, so a browser
// with no ?room= link and no cached room yet should land in the group's
// real room instead of silently spinning up its own empty one.
const DEFAULT_ROOM_ID = "room-78664b1a-5e50-4758-80b0-5645e1000e5d";
const DEFAULT_MEETING_TITLE = "홍대 놀자! 🎮🍻";
const firebaseConfig = {
  apiKey: "AIzaSyCTSyhsP9twRE7kn5IZ317QII98Eqdm6IY",
  authDomain: "nolgo-jeongsan.firebaseapp.com",
  databaseURL: "https://nolgo-jeongsan-default-rtdb.firebaseio.com",
  projectId: "nolgo-jeongsan",
  storageBucket: "nolgo-jeongsan.firebasestorage.app",
  messagingSenderId: "735820612157",
  appId: "1:735820612157:web:0759d5df0b8926c953e054",
  measurementId: "G-3LQHKWN878"
};
const defaultMembers = ["서창민"];
const defaultAvatars = ["🙂"];
const colors = ["av1", "av2", "av3", "av4", "av5"];
const $ = (selector) => document.querySelector(selector);
const won = (value) => `${Math.round(value || 0).toLocaleString("ko-KR")}원`;
const numberFrom = (value) => Number(String(value || "").replace(/[^\d]/g, ""));
const toDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const fromDateKey = (dateKey) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
};
const shortDate = (dateKey) => {
  const date = fromDateKey(dateKey);
  return `${date.getMonth() + 1}.${date.getDate()}`;
};
const normalizeDate = (dateKey) => {
  if (!dateKey || dateKey === "2024-05-18") return toDateKey(new Date());
  return dateKey;
};

let members = [...defaultMembers];
let avatars = [...defaultAvatars];
let meetings = [];
let currentMeetingId = "default";
let recordView = "expense";
let mobileRecordView = "expense";
let mobileInputMode = "expense";
let editingExpenseIndex = null;
let editingIncomeIndex = null;
let activeRecordDetail = null;
let openMemberSettings = null;
let editingScheduleId = null;
const collapsedSettleGroups = new Set();
const firebaseApp = initializeApp(firebaseConfig);
const firebaseDb = getDatabase(firebaseApp);
const firebaseAuth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
// Matches the app's hardcoded admin (src/lib/firebase.ts) — same bypass
// rule: an admin manages every crew and was never meant to be added as a
// named member of their own room.
const ADMIN_EMAIL = "alpist2615@gmail.com";

// The site used to sign in anonymously so anyone with the link could use it
// with no real identity behind their edits. It's now real accounts (Google
// or email/password) — authReady resolves once Firebase reports the current
// auth state (signed in or not), same as before, just no longer forcing a
// session into existence.
let currentUser = null;
let resolveAuthReady;
const authReady = new Promise((resolve) => {
  resolveAuthReady = resolve;
});
onAuthStateChanged(firebaseAuth, (user) => {
  currentUser = user;
  if (resolveAuthReady) {
    resolveAuthReady();
    resolveAuthReady = null;
  }
  renderAuthGate();
});
import("https://www.gstatic.com/firebasejs/12.15.0/firebase-analytics.js")
  .then(({ getAnalytics }) => getAnalytics(firebaseApp))
  .catch((error) => console.warn("Analytics blocked or unavailable", error));
const clientId = localStorage.getItem("nolgo-client-id") || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
localStorage.setItem("nolgo-client-id", clientId);
let roomId = "";
let roomRef = null;
let isApplyingRemote = false;
let lastRemoteUpdatedAt = 0;
// The last meetings/{id} content this tab knows Firebase actually has —
// save() diffs against this and only patches meetings that changed here,
// instead of set()-ing the whole room. This tab's `meetings` array can lag
// behind Firebase (this tab backgrounded, a slow reconnect, etc.); a plain
// set() of the whole room from a lagging tab used to silently roll back —
// or wipe entirely — every other crew's members that arrived in the
// meantime, since the write had no way to know it should leave them alone.
let lastKnownRoomMeetings = {};

function toKeyedMeetings(raw) {
  if (raw && !Array.isArray(raw) && typeof raw === "object") return raw;
  return meetingsToObject(meetingsFromSaved(raw));
}

function diffMeetingsPatch(nextMeetingsObj) {
  const patch = {};
  const ids = new Set([...Object.keys(lastKnownRoomMeetings), ...Object.keys(nextMeetingsObj)]);
  for (const id of ids) {
    const before = lastKnownRoomMeetings[id];
    const after = nextMeetingsObj[id];
    if (after === undefined) {
      if (before !== undefined) patch[`meetings/${id}`] = null;
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      patch[`meetings/${id}`] = after;
    }
  }
  return patch;
}

function createDefaultState(title = DEFAULT_MEETING_TITLE, withSamples = false) {
  return {
    title,
    meetDate: toDateKey(new Date()),
    meetTime: "",
    meetMemo: withSamples ? "카페 · 치킨집 · 노래방" : "",
    schedules: [],
    accounts: {},
    // Maps a member's display name to the Firebase uid of the account
    // signed in as that member — lets leave-crew and future re-logins
    // resolve "who am I in this meeting" by account instead of by display
    // name, so two accounts sharing a name (or a renamed account) can't
    // clobber each other.
    memberLinks: {},
    expenses: withSamples ? [
      { name: "카페 아아 5잔", amount: 25000, payer: "민준", category: "카페", members: [...defaultMembers], fund: false, fundUsed: 0 },
      { name: "치킨 + 콜라", amount: 32000, payer: "지훈", category: "음식", members: [...defaultMembers], fund: false, fundUsed: 0 },
      { name: "노래방 2시간", amount: 28000, payer: "서연", category: "놀거리", members: [...defaultMembers], fund: false, fundUsed: 0 },
      { name: "지하철", amount: 4600, payer: "예린", category: "교통", members: [...defaultMembers], fund: false, fundUsed: 0 },
      { name: "간식 주문", amount: 9400, payer: "서창민", category: "음식", members: [], fund: true, fundUsed: 4000 }
    ] : [],
    incomes: withSamples ? [
      { name: "공금 충전", amount: 10000, payer: "서창민", category: "공금 충전" },
      { name: "공금 충전", amount: 10000, payer: "민준", category: "공금 충전" }
    ] : []
  };
}

let state = createDefaultState(DEFAULT_MEETING_TITLE, false);

function makeMeeting(title = "새 모임", withSamples = false) {
  const id = `meeting-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    members: [...defaultMembers],
    avatars: [...defaultAvatars],
    state: createDefaultState(title, withSamples)
  };
}

function syncCurrentMeeting() {
  const current = meetings.find((meeting) => meeting.id === currentMeetingId);
  if (!current) return;
  current.members = [...members];
  current.avatars = [...avatars];
  current.state = JSON.parse(JSON.stringify(state));
}

function normalizeMeetingDates() {
  meetings.forEach((meeting) => {
    meeting.state = meeting.state || createDefaultState(meeting.id === "default" ? DEFAULT_MEETING_TITLE : "새 모임", false);
    const savedTitle = String(meeting.name || meeting.state.title || meeting.title || "").trim();
    meeting.state.title = meeting.id === "default" && (!savedTitle || savedTitle === "새 모임")
      ? DEFAULT_MEETING_TITLE
      : (savedTitle || "새 모임");
    meeting.state.meetDate = normalizeDate(meeting.state.meetDate);
    meeting.state.accounts = meeting.state.accounts || {};
    meeting.state.memberLinks = meeting.state.memberLinks || {};
    normalizeRecordDates(meeting.state);
  });
}

function normalizeRecordDates(targetState = state) {
  targetState.completedTransfers = targetState.completedTransfers || {};
  targetState.expenses = (targetState.expenses || []).map((item) => ({ ...item, date: normalizeDate(item.date || targetState.meetDate) }));
  targetState.incomes = (targetState.incomes || []).map((item) => ({ ...item, date: normalizeDate(item.date || targetState.meetDate) }));
  targetState.schedules = (targetState.schedules || [])
    .filter((item) => item && String(item.title || item.name || "").trim())
    .map((item, index) => ({
      id: item.id || `schedule-${Date.now()}-${index}`,
      title: String(item.title || item.name || "").trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || "")) ? item.date : targetState.meetDate,
      time: String(item.time || ""),
      location: String(item.location || item.place || ""),
      memo: String(item.memo || ""),
      reminderMinutes: Array.isArray(item.reminderMinutes) ? item.reminderMinutes : [],
      remindersConfigured: Boolean(item.remindersConfigured),
      remindersSent: item.remindersSent || {}
    }));
}

function totalsByDate() {
  return state.expenses.reduce((map, item) => {
    const key = normalizeDate(item.date || state.meetDate);
    map[key] = (map[key] || 0) + item.amount;
    return map;
  }, {});
}

function sanitizeRoomId(value) {
  return String(value || "").replace(/[.#$/[\]]/g, "-").slice(0, 80);
}

function setupRoomId() {
  const params = new URLSearchParams(location.search);
  const fromUrl = sanitizeRoomId(params.get("room"));
  // One shared crew uses one canonical room. Old per-device room IDs must
  // never hide the app's current crew, schedules, or receipts.
  roomId = fromUrl || DEFAULT_ROOM_ID;
  localStorage.setItem(roomStorageKey, roomId);
  if (params.get("room") !== roomId) {
    params.set("room", roomId);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}${location.hash}`);
  }
  roomRef = ref(firebaseDb, `rooms/${roomId}`);
  document.querySelectorAll('a[href^="receipt/"]').forEach((link) => {
    const target = link.getAttribute("href").split("?")[0];
    link.href = `${target}?room=${encodeURIComponent(roomId)}`;
  });
}

function shareUrl() {
  return `${siteUrl}?room=${encodeURIComponent(roomId)}`;
}

function uniqueNames(names) {
  return [...new Set((names || []).filter(Boolean))];
}

function renameLegacyMemberData() {
  const oldName = "나";
  const newName = "서창민";
  meetings = meetings.map((meeting) => {
    const oldMembers = Array.isArray(meeting.members) ? meeting.members : [...defaultMembers];
    const renamedMembers = uniqueNames(oldMembers.map((name) => name === oldName ? newName : name));
    const stateData = meeting.state || createDefaultState("새 모임", false);
    const accounts = { ...(stateData.accounts || {}) };
    if (accounts[oldName] && !accounts[newName]) accounts[newName] = accounts[oldName];
    delete accounts[oldName];

    const renameRecord = (item) => ({
      ...item,
      payer: item.payer === oldName ? newName : item.payer,
      members: uniqueNames((item.members || []).map((name) => name === oldName ? newName : name))
    });

    return {
      ...meeting,
      members: renamedMembers.length ? renamedMembers : [...defaultMembers],
      state: {
        ...stateData,
        accounts,
        expenses: (stateData.expenses || []).map(renameRecord),
        incomes: (stateData.incomes || []).map(renameRecord)
      }
    };
  });
}

// meetings is stored in Firebase as a keyed object ({ [meetingId]: meeting })
// so the Cloud Functions backing push notifications can trigger on an
// individual meeting being created — this app keeps working with a plain
// array internally (least disruptive), converting at the read/write boundary.
function meetingsFromSaved(rawMeetings) {
  if (Array.isArray(rawMeetings)) return rawMeetings;
  if (rawMeetings && typeof rawMeetings === "object") return Object.values(rawMeetings);
  return [];
}
function meetingsToObject(list) {
  return Object.fromEntries(list.map((meeting) => [meeting.id, {
    ...meeting,
    name: meeting.name || meeting.state?.title || "새 크루",
    state: {
      ...meeting.state,
      title: meeting.state?.title || meeting.name || "새 크루",
      schedules: (meeting.state?.schedules || []).map((item) => ({
        ...item,
        name: item.name || item.title || "",
        place: item.place || item.location || "",
        title: item.title || item.name || "",
        location: item.location || item.place || ""
      }))
    }
  }]));
}

function applySavedSnapshot(saved) {
  const savedMeetings = saved ? meetingsFromSaved(saved.meetings) : [];
  if (!saved) {
    meetings = [{ id: "default", members: [...defaultMembers], avatars: [...defaultAvatars], state: createDefaultState(DEFAULT_MEETING_TITLE, false) }];
    currentMeetingId = "default";
  } else if (savedMeetings.length) {
    meetings = savedMeetings;
    currentMeetingId = saved.currentMeetingId || meetings[0].id;
  } else {
    meetings = [{
      id: "default",
      members: Array.isArray(saved.members) && saved.members.length ? saved.members : [...defaultMembers],
      avatars: Array.isArray(saved.avatars) ? saved.avatars : [...defaultAvatars],
      state: { ...createDefaultState(DEFAULT_MEETING_TITLE, false), ...(saved.state || {}) }
    }];
    currentMeetingId = "default";
  }
  renameLegacyMemberData();
  const current = meetings.find((meeting) => meeting.id === currentMeetingId) || meetings[0];
  normalizeMeetingDates();
  currentMeetingId = current.id;
  members = [...current.members];
  avatars = current.avatars?.length === members.length ? [...current.avatars] : members.map((_, i) => defaultAvatars[i] || "🙂");
  state = JSON.parse(JSON.stringify(current.state));
}

function useMeeting(id) {
  syncCurrentMeeting();
  const next = meetings.find((meeting) => meeting.id === id) || meetings[0];
  currentMeetingId = next.id;
  members = [...next.members];
  avatars = [...next.avatars];
  state = JSON.parse(JSON.stringify(next.state));
  render();
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    applySavedSnapshot(saved);
  } catch {
    localStorage.removeItem(storageKey);
    applySavedSnapshot(null);
  }
}

function hasMeaningfulRoomData(saved) {
  const savedMeetings = saved ? meetingsFromSaved(saved.meetings) : [];
  if (!savedMeetings.length) return false;
  return savedMeetings.some((meeting) => {
    const roomState = meeting?.state || {};
    const accounts = roomState.accounts && typeof roomState.accounts === "object"
      ? Object.values(roomState.accounts).filter(Boolean)
      : [];
    return (roomState.expenses || []).length > 0
      || (roomState.incomes || []).length > 0
      || (roomState.schedules || []).length > 0
      || accounts.length > 0
      || Boolean(String(roomState.meetMemo || "").trim())
      || (meeting.members || []).length > 1;
  });
}

async function save() {
  syncCurrentMeeting();
  const snapshot = { currentMeetingId, meetings, updatedAt: Date.now(), updatedBy: clientId };
  localStorage.setItem(storageKey, JSON.stringify(snapshot));
  if (!roomRef || isApplyingRemote) {
    $("#saveStatus").textContent = "☁ 저장됨";
    return;
  }
  await authReady;
  try {
    const nextMeetingsObj = meetingsToObject(meetings);
    const patch = {
      ...diffMeetingsPatch(nextMeetingsObj),
      currentMeetingId: snapshot.currentMeetingId,
      updatedAt: snapshot.updatedAt,
      updatedBy: snapshot.updatedBy,
    };
    await update(roomRef, patch);
    lastKnownRoomMeetings = nextMeetingsObj;
    lastRemoteUpdatedAt = snapshot.updatedAt;
    $("#saveStatus").textContent = "☁ 공유 저장됨";
  } catch (error) {
    console.error("Firebase 저장 실패:", error);
    $("#saveStatus").textContent = "이 기기에 저장됨";
  }
}

function markSaving() {
  if (isApplyingRemote) return;
  $("#saveStatus").textContent = "저장 중...";
  clearTimeout(markSaving.timer);
  markSaving.timer = setTimeout(save, 180);
}

async function uploadCurrentLocalToFirebase() {
  syncCurrentMeeting();
  const snapshot = { currentMeetingId, meetings, updatedAt: Date.now(), updatedBy: clientId };
  localStorage.setItem(storageKey, JSON.stringify(snapshot));
  await authReady;
  // Only reached when the remote room doesn't exist yet (see caller), so
  // there's nothing there to preserve — a plain set() is correct here.
  const nextMeetingsObj = meetingsToObject(meetings);
  await set(roomRef, { ...snapshot, meetings: nextMeetingsObj });
  lastKnownRoomMeetings = nextMeetingsObj;
  lastRemoteUpdatedAt = snapshot.updatedAt;
}

async function startFirebaseSync() {
  if (!roomRef) return;
  $("#saveStatus").textContent = "☁ 공유 연결 중...";
  try {
    await authReady;
    const localSaved = JSON.parse(localStorage.getItem(storageKey));
    const remoteSnapshot = await get(roomRef);
    if (remoteSnapshot.exists()) {
      const remoteSaved = remoteSnapshot.val();
      const remoteUpdatedAt = Number(remoteSaved?.updatedAt || 0);
      lastRemoteUpdatedAt = remoteUpdatedAt;
      // Firebase is the shared source of truth. A stale browser-local copy
      // must never overwrite names, schedules, or receipt-linked expenses
      // created by the app on another device.
      isApplyingRemote = true;
      applySavedSnapshot(remoteSaved);
      lastKnownRoomMeetings = toKeyedMeetings(remoteSaved.meetings);
      render();
      isApplyingRemote = false;
      localStorage.setItem(storageKey, JSON.stringify(remoteSaved));
      $("#saveStatus").textContent = "☁ 공유 불러옴";
      ensureMemberLinks();
      refreshCrewGate();
    } else if (hasMeaningfulRoomData(localSaved)) {
      await uploadCurrentLocalToFirebase();
      $("#saveStatus").textContent = "☁ 로컬 데이터 업로드됨";
    } else {
      $("#saveStatus").textContent = "☁ 저장 준비됨";
    }
    onValue(roomRef, (snapshot) => {
      if (!snapshot.exists()) return;
      const remoteSaved = snapshot.val();
      const remoteUpdatedAt = Number(remoteSaved?.updatedAt || 0);
      if (!remoteUpdatedAt || remoteUpdatedAt <= lastRemoteUpdatedAt || remoteSaved.updatedBy === clientId) return;
      lastRemoteUpdatedAt = remoteUpdatedAt;
      isApplyingRemote = true;
      applySavedSnapshot(remoteSaved);
      lastKnownRoomMeetings = toKeyedMeetings(remoteSaved.meetings);
      render();
      isApplyingRemote = false;
      localStorage.setItem(storageKey, JSON.stringify(remoteSaved));
      $("#saveStatus").textContent = "☁ 공유 업데이트됨";
      ensureMemberLinks();
      refreshCrewGate();
    });
  } catch (error) {
    console.error("Firebase 동기화 실패:", error);
    $("#saveStatus").textContent = "이 기기에 저장됨";
  }
}

function memberIcon(name) {
  const index = Math.max(0, members.indexOf(name));
  return `<div class="avatar ${colors[index % colors.length]}">${avatars[index] || "🙂"}</div>`;
}

function selectedOptions(select) {
  return Array.from(select.selectedOptions).map((option) => option.value);
}

function ensureMemberName(name) {
  const clean = String(name || "").trim();
  if (!clean || clean === "공금") return clean;
  if (!members.includes(clean)) {
    members.push(clean);
    avatars.push("🙂");
    if (!state.accounts) state.accounts = {};
  }
  return clean;
}

function payerFromFields(selectId, inputId) {
  const typed = $(`#${inputId}`)?.value.trim();
  if (typed) return typed;
  return $(`#${selectId}`)?.value || members[0] || defaultMembers[0];
}

function setPayerFields(selectId, inputId, buttonId, payer) {
  const select = $(`#${selectId}`);
  const input = $(`#${inputId}`);
  const button = $(`#${buttonId}`);
  if (!select || !input || !button) return;
  if (payer === "공금") {
    select.value = "공금";
    input.value = "";
    button.classList.add("active");
  } else {
    if (members.includes(payer)) select.value = payer;
    input.value = payer || "";
    button.classList.remove("active");
  }
}

function updatePayerVisual(selectId, inputId, buttonId) {
  const select = $(`#${selectId}`);
  const input = $(`#${inputId}`);
  const button = $(`#${buttonId}`);
  if (!select || !input || !button) return;
  button.classList.toggle("active", select.value === "공금" && !input.value.trim());
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function cleanDataAfterMemberChange() {
  state.expenses = state.expenses
    .filter((item) => item.payer === "공금" || members.includes(item.payer))
    .map((item) => ({ ...item, members: (item.members || []).filter((name) => members.includes(name)) }))
    .filter((item) => item.fund || item.payer === "공금" || item.members.length > 0);
  state.incomes = state.incomes.filter((item) => members.includes(item.payer));
}

function renderMembers() {
  $("#memberCount").textContent = `${members.length}명 ⌄`;
  $("#membersList").innerHTML = members.map((name, index) => `
    <div class="member ${index === 0 ? "me" : ""}">
      ${memberIcon(name)}${escapeHtml(name)}${index === 0 ? `<span class="tag">정산 포함</span>` : ""}
      <button class="member-gear ${openMemberSettings === name ? "active" : ""}" data-member-settings="${escapeHtml(name)}" type="button" aria-label="${escapeHtml(name)} 설정">⚙</button>
    </div>
    ${openMemberSettings === name ? `
      <div class="member-settings-panel">
        <div class="panel-head">
          <strong>${escapeHtml(name)} 설정</strong>
          <button class="panel-close" data-member-settings-close type="button">×</button>
        </div>
        <label class="account-inline">
          <span>계좌</span>
          <input data-account="${escapeHtml(name)}" value="${escapeHtml(state.accounts?.[name] || "")}" placeholder="은행 / 계좌번호">
        </label>
        <div class="panel-actions">
          <span class="panel-hint">송금하기 버튼에 사용할 계좌예요.</span>
          ${index === 0 ? `<button class="danger-btn" disabled type="button">기본 프로필</button>` : `<button class="danger-btn" data-member="${escapeHtml(name)}" type="button">프로필 삭제</button>`}
        </div>
      </div>
    ` : ""}
  `).join("") + `
    <form class="member-add" id="memberForm">
      ＋ <input id="memberName" placeholder="친구 이름" aria-label="친구 이름">
      <button type="submit">추가</button>
    </form>
  `;
}

function renderMeetingSelect() {
  const options = meetings
    .map((meeting) => `<option value="${meeting.id}">${meeting.state.title || "이름 없는 모임"}</option>`)
    .join("");
  ["meetingSelect", "mobileMeetingSelect"].forEach((id) => {
    const select = $(`#${id}`);
    if (!select) return;
    select.innerHTML = options;
    select.value = currentMeetingId;
  });
  ["deleteMeetingBtn", "mobileDeleteMeetingBtn"].forEach((id) => {
    $(`#${id}`)?.classList.toggle("hidden", meetings.length <= 1);
  });
}

function fillSelects() {
  const payer = $("#expensePayer").value;
  const incomePayer = $("#incomePayer").value;
  $("#expensePayer").innerHTML = [...members, "공금"].map((name) => `<option>${name}</option>`).join("");
  $("#incomePayer").innerHTML = members.map((name) => `<option>${name}</option>`).join("");
  $("#expenseMembers").innerHTML = members.map((name) => `<option selected>${name}</option>`).join("");
  $("#incomeMembers").innerHTML = members.map((name) => `<option selected>${name}</option>`).join("");
  if ([...members, "공금"].includes(payer)) $("#expensePayer").value = payer;
  if (members.includes(incomePayer)) $("#incomePayer").value = incomePayer;
  renderChoiceControls();
}

function currentParticipants() {
  const names = new Set(members);
  state.expenses.forEach((item) => {
    if (item.payer && item.payer !== "공금") names.add(item.payer);
    (item.members || []).forEach((name) => names.add(name));
  });
  state.incomes.forEach((item) => {
    if (item.payer && item.payer !== "공금") names.add(item.payer);
  });
  return [...names];
}

function selectMultiple(select, values) {
  const picked = new Set(values);
  [...select.options].forEach((option) => {
    option.selected = picked.has(option.value);
  });
}

function renderSingleChoice(containerId, selectId) {
  const select = $(`#${selectId}`);
  const container = $(`#${containerId}`);
  if (!select || !container) return;
  container.innerHTML = [...select.options].map((option) => `
    <button class="person-pill ${option.selected ? "active" : ""}" data-select="${selectId}" data-value="${escapeHtml(option.value)}" type="button">
      ${escapeHtml(option.value)}
    </button>
  `).join("");
}

function renderMultiChoice(containerId, selectId) {
  const select = $(`#${selectId}`);
  const container = $(`#${containerId}`);
  if (!select || !container) return;
  container.innerHTML = [...select.options].map((option) => `
    <button class="member-check ${option.selected ? "active" : ""}" data-multi="${selectId}" data-value="${escapeHtml(option.value)}" type="button">
      ${escapeHtml(option.value)}
    </button>
  `).join("");
}

function renderChoiceControls() {
  updatePayerVisual("expensePayer", "expensePayerName", "fundPayerBtn");
  updatePayerVisual("mobileExpensePayer", "mobileExpensePayerName", "mobileFundPayerBtn");
  renderSingleChoice("incomePayerPills", "incomePayer");
  renderMultiChoice("expenseMemberChecks", "expenseMembers");
  renderMultiChoice("incomeMemberChecks", "incomeMembers");
}

function setFormDatesToMeetDate(force = false) {
  const expenseHasDraft = $("#expenseName")?.value || $("#expenseAmount")?.value;
  const incomeHasDraft = $("#incomeName")?.value || $("#incomeAmount")?.value;
  if (force || !expenseHasDraft || !$("#expenseDate").value) $("#expenseDate").value = state.meetDate;
  if (force || !incomeHasDraft || !$("#incomeDate").value) $("#incomeDate").value = state.meetDate;
}

function groupedTransfers(rows) {
  return rows.reduce((groups, item, index) => {
    if (!groups[item.from]) groups[item.from] = { from: item.from, items: [], total: 0 };
    let target = groups[item.from].items.find((entry) => entry.to === item.to);
    if (!target) {
      target = { from: item.from, to: item.to, amount: 0, details: [], offsetDetails: [], originalIndexes: [], netted: false };
      groups[item.from].items.push(target);
    }
    target.amount += item.amount;
    target.details.push(...(item.details || [item]));
    target.offsetDetails.push(...(item.offsetDetails || []));
    target.netted = target.netted || item.netted || false;
    target.originalIndexes.push(index);
    groups[item.from].total += item.amount;
    return groups;
  }, {});
}

function flatGroupedTransfers(rows) {
  return Object.values(groupedTransfers(rows)).flatMap((group) => group.items);
}

function transferCompletionKey(from, to) {
  return `${from}@@${to}`;
}

function netTransfers(rows) {
  const pairs = rows.reduce((map, item) => {
    if (!item.from || !item.to || item.from === item.to || item.amount <= 0) return map;
    const existingKey = `${item.from}|||${item.to}`;
    const reverseKey = `${item.to}|||${item.from}`;
    const key = map[existingKey] ? existingKey : reverseKey;
    const pairKey = map[key] ? key : existingKey;
    if (!map[pairKey]) map[pairKey] = { a: item.from, b: item.to, ab: 0, ba: 0, abDetails: [], baDetails: [] };
    const pair = map[pairKey];
    if (item.from === pair.a && item.to === pair.b) {
      pair.ab += item.amount;
      pair.abDetails.push(item);
    } else {
      pair.ba += item.amount;
      pair.baDetails.push(item);
    }
    return map;
  }, {});

  return Object.values(pairs).flatMap((pair) => {
    const diff = Math.round(pair.ab - pair.ba);
    if (diff === 0) return [];
    if (diff > 0) {
      return [{
        from: pair.a,
        to: pair.b,
        amount: diff,
        details: pair.abDetails,
        offsetDetails: pair.baDetails,
        netted: pair.ba > 0
      }];
    }
    return [{
      from: pair.b,
      to: pair.a,
      amount: Math.abs(diff),
      details: pair.baDetails,
      offsetDetails: pair.abDetails,
      netted: pair.ab > 0
    }];
  });
}

function clearExpenseEdit() {
  editingExpenseIndex = null;
  $("#expenseSubmitBtn").textContent = "지출 추가";
  $("#cancelExpenseEdit").classList.add("hidden");
}

function clearIncomeEdit() {
  editingIncomeIndex = null;
  $("#incomeSubmitBtn").textContent = "수입 추가";
  $("#cancelIncomeEdit").classList.add("hidden");
}

function startExpenseEdit(index) {
  const item = state.expenses[index];
  if (!item) return;
  setMode("expense");
  recordView = "expense";
  editingExpenseIndex = index;
  clearIncomeEdit();
  $("#expenseName").value = item.name;
  $("#expenseAmount").value = item.amount;
  $("#expenseDate").value = normalizeDate(item.date || state.meetDate);
  setPayerFields("expensePayer", "expensePayerName", "fundPayerBtn", item.payer);
  $("#fundUsedAmount").value = item.fundUsed || "";
  $("#expenseCategory").value = item.category;
  selectMultiple($("#expenseMembers"), item.members?.length ? item.members : members);
  renderChoiceControls();
  $("#expenseForm details").open = true;
  $("#expenseSubmitBtn").textContent = "지출 수정";
  $("#cancelExpenseEdit").classList.remove("hidden");
  renderRecords();
  $("#historyCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function startIncomeEdit(index) {
  const item = state.incomes[index];
  if (!item) return;
  setMode("income");
  recordView = "income";
  editingIncomeIndex = index;
  clearExpenseEdit();
  $("#incomeName").value = item.name;
  $("#incomeAmount").value = item.amount;
  $("#incomeDate").value = normalizeDate(item.date || state.meetDate);
  $("#incomePayer").value = item.payer;
  $("#incomeCategory").value = item.category;
  $("#incomeSplitAll").checked = false;
  selectMultiple($("#incomeMembers"), [item.payer]);
  renderChoiceControls();
  $("#incomeForm details").open = true;
  $("#incomeSubmitBtn").textContent = "수입 수정";
  $("#cancelIncomeEdit").classList.remove("hidden");
  renderRecords();
  $("#historyCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function calculate(expensesSource = state.expenses, incomesSource = state.incomes) {
  const participants = currentParticipants();
  const paid = Object.fromEntries(participants.map((name) => [name, 0]));
  const owed = Object.fromEntries(participants.map((name) => [name, 0]));
  const fundIncome = incomesSource.reduce((sum, item) => sum + item.amount, 0);
  const splitRows = [];
  let personalTotal = 0;
  let total = 0;
  let fundDirectSpent = 0;

  expensesSource.forEach((item, expenseIndex) => {
    total += item.amount;
    if (item.fund || item.payer === "공금") {
      const fundUsed = item.payer === "공금" ? item.amount : Math.min(item.amount, item.fundUsed || 0);
      const fronted = item.payer === "공금" ? 0 : item.amount - fundUsed;
      fundDirectSpent += fundUsed;
      if (fronted > 0 && paid[item.payer] !== undefined) {
        const splitMembers = item.members?.length ? item.members : participants;
        personalTotal += fronted;
        paid[item.payer] += fronted;
        const share = fronted / splitMembers.length;
        splitMembers.forEach((name) => {
          owed[name] += share;
          splitRows.push({
            expenseIndex,
            expenseName: item.name,
            payer: item.payer,
            member: name,
            amount: share,
            total: fronted,
            membersCount: splitMembers.length,
            fundUsed,
            self: name === item.payer,
            type: "fund-mixed",
            proxyPayment: !!item.proxyPayment
          });
        });
      }
      return;
    }
    personalTotal += item.amount;
    paid[item.payer] += item.amount;
    const splitMembers = item.members?.length ? item.members : participants;
    const share = item.amount / splitMembers.length;
    splitMembers.forEach((name) => {
      owed[name] += share;
      splitRows.push({
        expenseIndex,
        expenseName: item.name,
        payer: item.payer,
        member: name,
        amount: share,
        total: item.amount,
        membersCount: splitMembers.length,
        fundUsed: 0,
        self: name === item.payer,
        type: "personal",
        proxyPayment: !!item.proxyPayment
      });
    });
  });

  const balances = participants.map((name) => ({ name, paid: paid[name] || 0, owed: owed[name] || 0, net: (paid[name] || 0) - (owed[name] || 0) }));
  const transfers = splitRows
    .filter((item) => !item.self && item.amount > 0.5)
    .map((item) => ({
      from: item.member,
      to: item.payer,
      amount: item.amount,
      expenseName: item.expenseName,
      total: item.total,
      membersCount: item.membersCount,
      fundUsed: item.fundUsed,
      type: item.type,
      proxyPayment: !!item.proxyPayment
    }));
  return { total, personalTotal, average: participants.length ? personalTotal / participants.length : 0, balances, splitRows, transfers, fundTransfers: [], fundBalance: fundIncome - fundDirectSpent };
}

function schedulesForDate(dateKey = state.meetDate) {
  return (state.schedules || [])
    .filter((item) => item.date === dateKey)
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99") || a.title.localeCompare(b.title, "ko"));
}

function scheduleMeta(item) {
  return [item.time, item.location].filter(Boolean).join(" · ") || "시간·장소 미정";
}

function scheduleRowsHtml(items, emptyText = "등록된 일정이 없어요.", compact = false) {
  if (!items.length) return `<div class="schedule-empty">${escapeHtml(emptyText)}</div>`;
  return items.map((item) => `
    <button class="schedule-row ${compact ? "compact" : ""}" data-schedule-id="${escapeHtml(item.id)}" type="button">
      <span class="schedule-time">${escapeHtml(item.time || "하루")}</span>
      <span class="schedule-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(scheduleMeta(item))}${item.memo ? ` · ${escapeHtml(item.memo)}` : ""}</small></span>
      <span class="schedule-chevron" aria-hidden="true">›</span>
    </button>
  `).join("");
}

function renderHomeCalendar() {
  const selectedDate = fromDateKey(state.meetDate);
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  const scheduleCounts = (state.schedules || []).reduce((counts, item) => {
    counts[item.date] = (counts[item.date] || 0) + 1;
    return counts;
  }, {});
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  $("#homeMonthLabel").textContent = `${year}년 ${month + 1}월`;
  let html = weekdays.map((day) => `<span class="home-calendar-dow">${day}</span>`).join("");
  html += Array.from({ length: firstDay }, () => `<span class="home-calendar-day empty"></span>`).join("");
  for (let day = 1; day <= lastDate; day += 1) {
    const dateKey = toDateKey(new Date(year, month, day));
    const count = scheduleCounts[dateKey] || 0;
    html += `<button class="home-calendar-day ${dateKey === state.meetDate ? "selected" : ""} ${count ? "has-schedule" : ""}" data-home-date="${dateKey}" type="button"><b>${day}</b>${count ? `<i>${count}</i>` : ""}</button>`;
  }
  $("#homeCalendarGrid").innerHTML = html;
  const selected = schedulesForDate();
  $("#homeCalendarCaption").textContent = `${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 · 일정 ${selected.length}개`;
  $("#homeScheduleList").innerHTML = scheduleRowsHtml(selected.slice(0, 3), "이 날짜에는 아직 일정이 없어요.", true);
}

function openScheduleModal(scheduleId = null, preferredDate = state.meetDate) {
  const schedule = (state.schedules || []).find((item) => item.id === scheduleId) || null;
  editingScheduleId = schedule?.id || null;
  $("#scheduleModalTitle").textContent = schedule ? "일정 수정" : "일정 추가";
  $("#scheduleTitle").value = schedule?.title || "";
  $("#scheduleDate").value = schedule?.date || preferredDate || state.meetDate;
  $("#scheduleTime").value = schedule?.time || "";
  $("#scheduleLocation").value = schedule?.location || "";
  $("#scheduleMemo").value = schedule?.memo || "";
  $("#deleteScheduleBtn").classList.toggle("hidden", !schedule);
  $("#scheduleModal").classList.remove("hidden");
  window.setTimeout(() => $("#scheduleTitle").focus(), 30);
}

function closeScheduleModal() {
  editingScheduleId = null;
  $("#scheduleModal").classList.add("hidden");
  $("#scheduleForm").reset();
}

function renderCalendar(result) {
  const date = fromDateKey(state.meetDate);
  const year = date.getFullYear();
  const month = date.getMonth();
  const selectedDay = date.getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  const calendarWeeks = Math.ceil((firstDay + lastDate) / 7);
  const dailyTotals = totalsByDate();
  const selectedTotal = dailyTotals[state.meetDate] || 0;
  const selectedExpenseCount = state.expenses.filter((item) => normalizeDate(item.date || state.meetDate) === state.meetDate).length;
  const scheduleCounts = (state.schedules || []).reduce((counts, item) => {
    counts[item.date] = (counts[item.date] || 0) + 1;
    return counts;
  }, {});
  $("#monthLabel").textContent = `${year}년 ${month + 1}월`;
  $("#calendarGrid").style.setProperty("--calendar-weeks", calendarWeeks);
  $("#calendarGrid").innerHTML = `<div class="dow">일</div><div class="dow">월</div><div class="dow">화</div><div class="dow">수</div><div class="dow">목</div><div class="dow">금</div><div class="dow">토</div>`;
  for (let i = 0; i < firstDay; i += 1) $("#calendarGrid").insertAdjacentHTML("beforeend", `<div class="cal-cell empty"></div>`);
  for (let day = 1; day <= lastDate; day += 1) {
    const active = day === selectedDay;
    const dayKey = toDateKey(new Date(year, month, day));
    const dayTotal = dailyTotals[dayKey] || 0;
    const scheduleCount = scheduleCounts[dayKey] || 0;
    $("#calendarGrid").insertAdjacentHTML("beforeend", `<button class="cal-cell ${active ? "event selected" : ""} ${dayTotal ? "has-amount" : ""} ${scheduleCount ? "has-schedule" : ""}" data-day="${day}" style="--item-index:${day}" type="button"><span>${day}</span>${scheduleCount ? `<div class="schedule-dot" title="일정 ${scheduleCount}개">${scheduleCount}</div>` : ""}${dayTotal ? `<div class="amt">${won(dayTotal)}</div>` : ""}</button>`);
  }
  $("#eventDateText").textContent = `${month + 1}월 ${selectedDay}일 · ${state.title}`;
  const selectedSchedules = schedulesForDate();
  $("#eventMemoText").textContent = `일정 ${selectedSchedules.length}개 · 지출 ${selectedExpenseCount}건`;
  $("#eventTotalText").textContent = won(selectedTotal);
  $("#scheduleList").innerHTML = scheduleRowsHtml(selectedSchedules, "선택한 날짜에 등록된 일정이 없어요.");
  $("#meetDate").value = state.meetDate;
  renderHomeCalendar();
}

function recordsForSelectedDate() {
  const selectedDate = normalizeDate(state.meetDate);
  const byDate = ({ item }) => normalizeDate(item.date || state.meetDate) === selectedDate;
  return {
    date: selectedDate,
    expenses: state.expenses.map((item, index) => ({ item, index })).filter(byDate),
    incomes: state.incomes.map((item, index) => ({ item, index })).filter(byDate)
  };
}

function recordedDates(type) {
  const source = type === "income" ? state.incomes : state.expenses;
  const counts = source.reduce((map, item) => {
    const date = normalizeDate(item.date || state.meetDate);
    map[date] = (map[date] || 0) + 1;
    return map;
  }, {});
  return Object.entries(counts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function recordedDateButtons(type) {
  const dates = recordedDates(type);
  if (!dates.length) return `<span class="record-date-empty">기록된 날짜 없음</span>`;
  return dates.map(({ date, count }) => {
    const parsed = fromDateKey(date);
    const label = `${parsed.getMonth() + 1}월 ${parsed.getDate()}일`;
    return `<button class="record-date-btn ${date === state.meetDate ? "active" : ""}" data-record-date="${date}" type="button"><strong>${label}</strong><small>${count}건</small></button>`;
  }).join("");
}

function selectLatestRecordedDate(type) {
  const dates = recordedDates(type);
  if (dates.length && !dates.some((item) => item.date === state.meetDate)) state.meetDate = dates[0].date;
}

function renderRecords() {
  const showExpenses = recordView === "expense";
  const dayRecords = recordsForSelectedDate();
  $("#recordDateList").innerHTML = recordedDateButtons(recordView);
  $("#expenseTable")?.classList.toggle("hidden", !showExpenses);
  $("#incomeRows")?.classList.toggle("hidden", showExpenses);
  $("#totalLabel").textContent = showExpenses ? "총 지출" : "총 수입";
  $("#expenseRows").innerHTML = dayRecords.expenses.length ? dayRecords.expenses.map(({ item, index }) => {
    const icon = item.fund || item.payer === "공금" ? "💰" : ["☕", "🍗", "🎤", "🚇", "🛍"][index % 5];
    const typeText = item.fund || item.payer === "공금"
      ? item.payer === "공금" ? "공금에서 결제" : `공금 ${won(item.fundUsed || 0)} + ${item.payer} ${won(item.amount - (item.fundUsed || 0))}`
      : item.proxyPayment
        ? `${(item.proxyFor || []).join(", ")} (대신 결제) · N빵: ${(item.members || []).join(", ")}`
        : item.members.join(", ");
    return `<tr class="record-clickable" data-record-type="expense" data-record-index="${index}" tabindex="0">
      <td><div class="item-name"><div class="item-icon ic${(index % 5) + 1}">${icon}</div><div><strong>${item.name}</strong><span class="record-date">${shortDate(normalizeDate(item.date || state.meetDate))}</span></div></div></td>
      <td>${won(item.amount)}</td><td>${item.payer}</td>
      <td><div class="who-list">${typeText.split(", ").map((name) => `<span class="chip">${name}</span>`).join("")}</div></td>
      <td class="trash" aria-hidden="true">›</td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-record">선택한 날짜 지출 내역이 없어요.</td></tr>`;
  $("#incomeRows").innerHTML = dayRecords.incomes.length
    ? `<div style="margin-top:14px;">${dayRecords.incomes.map(({ item, index }) => `<div class="fund-row record-clickable" data-record-type="income" data-record-index="${index}" tabindex="0"><div><strong>${item.name}</strong><span>${shortDate(normalizeDate(item.date || state.meetDate))} · ${item.payer} · ${item.category}</span></div><div><strong>${won(item.amount)}</strong><span aria-hidden="true">›</span></div></div>`).join("")}</div>`
    : `<div class="fund-row"><div><strong>선택한 날짜 수입 내역 없음</strong><span>${shortDate(dayRecords.date)}에는 기록이 없어요.</span></div></div>`;
}

function openRecordDetail(type, index) {
  const collection = type === "income" ? state.incomes : state.expenses;
  const item = collection[index];
  if (!item) return;
  activeRecordDetail = { type, index };
  const isIncome = type === "income";
  const date = normalizeDate(item.date || state.meetDate);
  const participants = isIncome
    ? (item.members || []).join(", ")
    : (item.members || item.usedBy || []).join(", ");
  const payment = isIncome
    ? "공금에 반영"
    : item.payer === "공금"
      ? "공금에서 결제"
      : item.fundUsed > 0
        ? `공금 ${won(item.fundUsed)} + ${item.payer} ${won(item.amount - item.fundUsed)}`
        : item.proxyPayment
          ? `${(item.proxyFor || []).join(", ")} 대신 결제`
          : "개인 결제";
  $("#recordDetailType").textContent = isIncome ? "수입 내역" : "지출 내역";
  $("#recordDetailTitle").textContent = item.name || (isIncome ? "수입" : "지출");
  $("#recordDetailBody").innerHTML = `
    <div class="record-detail-field"><span>금액</span><strong>${won(item.amount)}</strong></div>
    <div class="record-detail-field"><span>날짜</span><strong>${date}</strong></div>
    <div class="record-detail-field"><span>${isIncome ? "입금한 사람" : "결제한 사람"}</span><strong>${escapeHtml(item.payer || "미선택")}</strong></div>
    <div class="record-detail-field"><span>분류</span><strong>${escapeHtml(item.category || (isIncome ? "수입" : "기타"))}</strong></div>
    <div class="record-detail-field wide"><span>처리 방식</span><strong>${escapeHtml(payment)}</strong></div>
    ${participants ? `<div class="record-detail-field wide"><span>${isIncome ? "함께 낸 사람" : "같이 사용한 사람"}</span><strong>${escapeHtml(participants)}</strong></div>` : ""}
  `;
  const receiptLink = $("#recordReceiptLink");
  receiptLink.classList.toggle("hidden", !item.receiptId);
  if (item.receiptId) receiptLink.href = `receipt/index.html?id=${encodeURIComponent(item.receiptId)}&room=${encodeURIComponent(roomId)}`;
  $("#recordDetailModal").classList.remove("hidden");
}

function closeRecordDetail() {
  activeRecordDetail = null;
  $("#recordDetailModal").classList.add("hidden");
}

function calculateSelectedDate() {
  const dayRecords = recordsForSelectedDate();
  return calculate(dayRecords.expenses.map(({ item }) => item), dayRecords.incomes.map(({ item }) => item));
}

function renderSettlementDetail(selectedResult, rows, dayRecords) {
  if (!$("#detailRows")) return;
  const expenseTotal = dayRecords.expenses.reduce((sum, { item }) => sum + item.amount, 0);
  const incomeTotal = dayRecords.incomes.reduce((sum, { item }) => sum + item.amount, 0);
  const grouped = Object.values(groupedTransfers(rows));
  const flatRows = flatGroupedTransfers(rows);
  $("#detailCount").textContent = `${shortDate(dayRecords.date)} · 송금 ${flatRows.length}건`;
  $("#detailSummary").innerHTML = `
    <div><span>선택 날짜</span><strong>${shortDate(dayRecords.date)}</strong></div>
    <div><span>지출 합계</span><strong>${won(expenseTotal)}</strong></div>
    <div><span>수입 합계</span><strong>${won(incomeTotal)}</strong></div>
    <div><span>송금 합계</span><strong>${won(rows.reduce((sum, item) => sum + item.amount, 0))}</strong></div>
  `;
  if (!rows.length) {
    $("#detailRows").innerHTML = `<div class="detail-empty">선택한 날짜에 정산할 금액이 없습니다.</div>`;
    return;
  }
  const balanceHtml = selectedResult.balances.map((item) => `
    <div class="detail-person">
      <strong>${escapeHtml(item.name)}</strong>
      <span>낸 돈 ${won(item.paid)} · 내 몫 ${won(item.owed)} · ${item.net >= 0 ? "받을 돈" : "낼 돈"} ${won(Math.abs(item.net))}</span>
    </div>
  `).join("");
  const transferHtml = grouped.map((group) => `
    <section class="detail-group">
      <div class="detail-group-head">
        <strong>${escapeHtml(group.from)}</strong>
        <span>총 ${won(group.total)}</span>
      </div>
      ${group.items.map((item) => {
        const offsetAmount = item.offsetDetails.reduce((sum, detail) => sum + detail.amount, 0);
        const offsetText = item.netted ? `<div class="detail-offset">서로 보낼 돈 ${won(offsetAmount)} 차감 후 금액입니다.</div>` : "";
        return `<div class="detail-target">
          <div class="detail-route">${escapeHtml(item.from)} → ${escapeHtml(item.to)} <b>${won(item.amount)}</b></div>
          ${offsetText}
          <div class="detail-items">
            ${item.details.map((detail) => `
              <div class="detail-item">
                <span>${escapeHtml(detail.expenseName || "정산 항목")}${detail.proxyPayment ? " (대신 결제)" : ""}</span>
                <strong>${won(detail.amount)}</strong>
              </div>
            `).join("")}
          </div>
        </div>`;
      }).join("")}
    </section>
  `).join("");
  $("#detailRows").innerHTML = `
    <div class="detail-block">
      <div class="detail-title">사람별 계산</div>
      ${balanceHtml}
    </div>
    <div class="detail-block">
      <div class="detail-title">송금 근거</div>
      ${transferHtml}
    </div>
  `;
}

function renderSummary(result) {
  const dayRecords = recordsForSelectedDate();
  const selectedResult = calculateSelectedDate();
  const dayExpenseTotal = dayRecords.expenses.reduce((sum, { item }) => sum + item.amount, 0);
  const dayIncomeTotal = dayRecords.incomes.reduce((sum, { item }) => sum + item.amount, 0);
  $("#recordCount").textContent = `${shortDate(dayRecords.date)} · 지출 ${dayRecords.expenses.length}개 · 수입 ${dayRecords.incomes.length}개`;
  $("#totalSpentText").textContent = won(recordView === "expense" ? dayExpenseTotal : dayIncomeTotal);
  const selectedRows = netTransfers([...selectedResult.transfers, ...selectedResult.fundTransfers]);
  const rows = netTransfers([...result.transfers, ...result.fundTransfers]);
  const groups = Object.values(groupedTransfers(rows));
  const flatRows = flatGroupedTransfers(rows);
  const pendingRows = flatRows.filter((item) => !state.completedTransfers?.[transferCompletionKey(item.from, item.to)]);
  const pendingTotal = pendingRows.reduce((sum, item) => sum + item.amount, 0);
  const completedCount = Math.max(0, flatRows.length - pendingRows.length);
  const progressPercent = flatRows.length ? Math.round((completedCount / flatRows.length) * 100) : 100;
  const myName = (currentUser?.displayName || currentUser?.email?.split("@")[0] || "").trim();
  const myBalance = result.balances.find((item) => item.name === myName);
  const myReceivable = Math.max(0, myBalance?.net || 0);
  $("#summaryExpense").textContent = won(result.total);
  $("#summaryIncome").textContent = won(myReceivable);
  $("#summaryPending").textContent = won(pendingTotal);
  $("#summaryPendingCount").textContent = `미완료 송금 ${pendingRows.length}건`;
  $("#heroPendingMirror").textContent = won(pendingTotal);
  $("#heroProgressBar").style.width = `${progressPercent}%`;
  $("#heroProgressText").textContent = flatRows.length
    ? `정산 ${completedCount} / ${flatRows.length} 완료 · 미완료 송금 ${pendingRows.length}건`
    : "보낼 돈이 모두 정리됐어요.";
  $("#heroTransferRows").innerHTML = flatRows.length
    ? flatRows.slice(0, 3).map((item) => {
      const completionKey = transferCompletionKey(item.from, item.to);
      const completed = !!state.completedTransfers?.[completionKey];
      return `<div class="hero-transfer ${completed ? "completed" : ""}">
        <span class="hero-avatar">${escapeHtml(item.from.slice(0, 1))}</span>
        <span class="hero-route">${escapeHtml(item.from)} → ${escapeHtml(item.to)}</span>
        <strong>${completed ? "정산완료" : won(item.amount)}</strong>
        ${completed ? "" : `<button type="button" data-main-transfer-complete="${escapeHtml(completionKey)}">완료 표시</button>`}
      </div>`;
    }).join("")
    : `<div class="hero-empty"><span>✓</span><strong>이번 모임 정산 완료</strong><small>새 지출이 등록되면 자동으로 계산해 드려요.</small></div>`;
  $("#settleRows").innerHTML = rows.length
    ? groups.map((group) => {
      const isOpen = !collapsedSettleGroups.has(group.from);
      const pendingGroupTotal = group.items.reduce((sum, item) => sum + (state.completedTransfers?.[transferCompletionKey(item.from, item.to)] ? 0 : item.amount), 0);
      return `
      <div class="settle-group">
        <div class="settle-group-head">
          <div class="settle-people">${memberIcon(group.from)}${group.from}</div>
          <div class="settle-group-action">
            <div class="amt">${won(pendingGroupTotal)}</div>
            <button class="settle-toggle ${isOpen ? "open" : ""}" data-settle-toggle="${escapeHtml(group.from)}" type="button" aria-label="${escapeHtml(group.from)} 상세 보기"></button>
          </div>
        </div>
        <div class="settle-group-list ${isOpen ? "" : "collapsed"}">
          ${group.items.map((item) => {
            const completionKey = transferCompletionKey(item.from, item.to);
            const completed = !!state.completedTransfers?.[completionKey];
            const details = item.details.map((detail) => `${detail.expenseName}${detail.proxyPayment ? " (대신 결제)" : ""} ${won(detail.amount)}`).join(" · ");
            const offsetAmount = item.offsetDetails.reduce((sum, detail) => sum + detail.amount, 0);
            const offsetText = item.netted ? `서로 보낼 돈 ${won(offsetAmount)} 차감 · ` : "";
            return `<div class="settle-target ${completed ? "completed" : ""}">
              <div class="settle-main">
                <div class="settle-people small">${memberIcon(item.to)}${item.to}${completed ? '<span class="transfer-complete-label">송금 완료</span>' : ""}</div>
                <div class="settle-desc">${offsetText}${details}</div>
              </div>
              <div class="settle-pay"><div class="amt">${won(item.amount)}</div><button class="complete-transfer-btn ${completed ? "active" : ""}" data-main-transfer-complete="${escapeHtml(completionKey)}" type="button">${completed ? "완료 취소" : "송금 완료"}</button></div>
            </div>`;
          }).join("")}
        </div>
      </div>
    `;
    }).join("")
    : `<div class="settle-row empty-settle"><div class="settle-people">정산할 금액이 없습니다</div></div>`;
  document.querySelector(".settle-total")?.classList.toggle("hidden", !rows.length);
  $("#settleCount").textContent = `${shortDate(dayRecords.date)} · 보낼 사람 ${groups.length}명`;
  const groupedRowCount = flatRows.length;
  if (rows.length) {
    $("#settleTotalLabel").textContent = `미완료 ${pendingRows.length}건 · 전체 ${groupedRowCount}건`;
    $("#settleTotalAmount").textContent = `남은 금액 ${won(pendingTotal)}`;
  }
  renderSettlementDetail(selectedResult, selectedRows, dayRecords);
}

function mobileDateLabel() {
  const date = fromDateKey(state.meetDate);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekdays[date.getDay()]})`;
}

function mobileActiveValues(containerId, fallback = members) {
  const active = [...document.querySelectorAll(`#${containerId} .mobile-choice.active`)].map((item) => item.dataset.value);
  return active.length ? active : [...fallback];
}

function renderMobileChoices(containerId, names, selected = names) {
  const container = $(`#${containerId}`);
  if (!container) return;
  const picked = new Set(selected);
  container.innerHTML = names.map((name) => `
    <button class="mobile-choice ${picked.has(name) ? "active" : ""}" data-mobile-choice="${containerId}" data-value="${escapeHtml(name)}" type="button">
      ${escapeHtml(name)}
    </button>
  `).join("");
}

function renderMobileSelect(id, names, extra = []) {
  const select = $(`#${id}`);
  if (!select) return;
  const current = select.value;
  const options = [...names, ...extra];
  select.innerHTML = options.map((name) => `<option>${escapeHtml(name)}</option>`).join("");
  if (options.includes(current)) select.value = current;
}

function renderMobile(result) {
  if (!$("#mobileTitle")) return;
  const rows = flatGroupedTransfers(netTransfers([...result.transfers, ...result.fundTransfers]));
  const pendingRows = rows.filter((item) => !state.completedTransfers?.[transferCompletionKey(item.from, item.to)]);
  const totalToSend = pendingRows.reduce((sum, item) => sum + item.amount, 0);
  const dayRecords = recordsForSelectedDate();
  $("#mobileTitle").value = state.title;
  $("#mobileMeetDateText").textContent = `${state.title || "새 모임"} · 남은 송금`;
  const selectedSchedules = schedulesForDate();
  $("#mobileDateTitle").textContent = `${mobileDateLabel()} · 일정 ${selectedSchedules.length}개`;
  $("#mobileSettleTotal").textContent = won(totalToSend);
  $("#mobileTotalSpent").textContent = won(result.total);
  $("#mobileFundBalance").textContent = won(result.fundBalance);
  $("#mobileSettleCount").textContent = `${pendingRows.length}건`;
  $("#mobileSettleRows").innerHTML = rows.length ? rows.map((item) => {
    const completionKey = transferCompletionKey(item.from, item.to);
    const completed = !!state.completedTransfers?.[completionKey];
    const detailParts = item.details.map((detail) => `${detail.expenseName} ${won(detail.amount)}`);
    const details = detailParts.join(" · ");
    const offsetAmount = item.offsetDetails.reduce((sum, detail) => sum + detail.amount, 0);
    const offset = item.netted ? `서로 보낼 돈 ${won(offsetAmount)} 차감 · ` : "";
    const mobileDetail = detailParts.length > 1
      ? `<details class="mobile-transfer-detail"><summary>포함 항목 ${detailParts.length}건</summary><div>${offset}${detailParts.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}</div></details>`
      : `<div class="mobile-detail">${offset}${escapeHtml(details)}</div>`;
    return `<div class="mobile-transfer ${completed ? "completed" : ""}">
      <div class="mobile-transfer-head">
        <strong>${escapeHtml(item.from)} → ${escapeHtml(item.to)}${completed ? '<span class="transfer-complete-label">완료</span>' : ""}</strong>
        <span class="amount">${won(item.amount)}</span>
      </div>
      ${mobileDetail}
      <div class="mobile-transfer-actions"><button class="complete-transfer-btn ${completed ? "active" : ""}" data-mobile-complete="${escapeHtml(completionKey)}" type="button">${completed ? "완료 취소" : "송금 완료"}</button></div>
    </div>`;
  }).join("") : `<div class="mobile-empty">정산할 금액이 없어요.</div>`;

  const recentExpenses = state.expenses.slice(0, 3);
  $("#mobileHomeRecentRows").innerHTML = recentExpenses.length ? recentExpenses.map((item) => `
    <div class="mobile-record compact">
      <div class="mobile-record-head"><strong>${escapeHtml(item.name)}</strong><span class="amount">${won(item.amount)}</span></div>
      <div class="mobile-detail">${shortDate(normalizeDate(item.date || state.meetDate))} · ${escapeHtml(item.payer)}</div>
    </div>
  `).join("") : `<div class="mobile-empty">아직 지출 내역이 없어요.</div>`;

  renderMobileSelect("mobileExpensePayer", members, ["공금"]);
  renderMobileSelect("mobileIncomePayer", members);
  renderMobileChoices("mobileExpenseMembers", members, mobileActiveValues("mobileExpenseMembers"));
  renderMobileChoices("mobileIncomeMembers", members, mobileActiveValues("mobileIncomeMembers"));
  if (!$("#mobileExpenseDate").value) $("#mobileExpenseDate").value = state.meetDate;
  if (!$("#mobileIncomeDate").value) $("#mobileIncomeDate").value = state.meetDate;

  updatePayerVisual("mobileExpensePayer", "mobileExpensePayerName", "mobileFundPayerBtn");
  const records = mobileRecordView === "expense" ? dayRecords.expenses : dayRecords.incomes;
  $("#mobileRecordDates").innerHTML = recordedDateButtons(mobileRecordView);
  $("#mobileRecordCount").textContent = `${shortDate(dayRecords.date)} · ${records.length}개`;
  $("#mobileRecordRows").innerHTML = records.length ? records.map(({ item, index }) => `
    <div class="mobile-record record-clickable" data-record-type="${mobileRecordView}" data-record-index="${index}" tabindex="0">
      <div class="mobile-record-head">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="amount">${won(item.amount)}</span>
      </div>
      <div class="mobile-detail">${shortDate(normalizeDate(item.date || state.meetDate))} · ${escapeHtml(item.payer)} · ${escapeHtml(item.category || "")}</div>
      <span class="mobile-record-chevron" aria-hidden="true">›</span>
    </div>
  `).join("") : `<div class="mobile-empty">선택한 날짜 ${mobileRecordView === "expense" ? "지출" : "수입"} 내역이 없어요.</div>`;

  $("#mobileMeetDate").value = state.meetDate;
  const totals = totalsByDate();
  const scheduleCounts = (state.schedules || []).reduce((counts, item) => {
    counts[item.date] = (counts[item.date] || 0) + 1;
    return counts;
  }, {});
  const selectedDate = fromDateKey(state.meetDate);
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  $("#mobileMonthLabel").textContent = `${year}년 ${month + 1}월`;
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  let calendarHtml = weekdays.map((day) => `<span class="mobile-dow">${day}</span>`).join("");
  calendarHtml += Array.from({ length: firstDay }, () => `<span class="mobile-day empty"></span>`).join("");
  for (let day = 1; day <= lastDate; day += 1) {
    const dateKey = toDateKey(new Date(year, month, day));
    const amount = totals[dateKey] || 0;
    const scheduleCount = scheduleCounts[dateKey] || 0;
    calendarHtml += `<button class="mobile-day ${dateKey === state.meetDate ? "selected" : ""} ${amount ? "has-record" : ""} ${scheduleCount ? "has-schedule" : ""}" data-mobile-date="${dateKey}" style="--item-index:${day}" type="button"><b>${day}</b>${scheduleCount ? `<em>${scheduleCount}</em>` : ""}${amount ? `<i>${won(amount)}</i>` : ""}</button>`;
  }
  $("#mobileCalendar").innerHTML = calendarHtml;
  $("#mobileScheduleList").innerHTML = scheduleRowsHtml(selectedSchedules, "이 날짜에는 아직 일정이 없어요.", true);

  $("#mobileMemberCount").textContent = `${members.length}명`;
  $("#mobileMemberRows").innerHTML = members.map((name, index) => `
    <div class="mobile-member-row">
      <div class="mobile-member-head">
        <strong>${escapeHtml(name)}</strong>
        ${index === 0 ? `<span class="tag">기본</span>` : `<button data-mobile-remove-member="${escapeHtml(name)}" type="button">삭제</button>`}
      </div>
      <input class="mobile-account" data-mobile-account="${escapeHtml(name)}" value="${escapeHtml(state.accounts?.[name] || "")}" placeholder="계좌번호">
    </div>
  `).join("");
}

function render() {
  state.title = String(state.title || "새 모임");
  state.meetDate = normalizeDate(state.meetDate);
  normalizeRecordDates(state);
  state.accounts = state.accounts || {};
  $("#groupTitle").value = state.title;
  renderMeetingSelect();
  renderMembers();
  fillSelects();
  const result = calculate();
  renderCalendar(result);
  renderRecords();
  renderSummary(result);
  renderMobile(result);
  requestAnimationFrame(() => window.lucide?.createIcons());
  setFormDatesToMeetDate(false);
  markSaving();
}

function setMode(mode) {
  const income = mode === "income";
  recordView = income ? "income" : "expense";
  selectLatestRecordedDate(recordView);
  $("#expenseMode").classList.toggle("active", !income);
  $("#incomeMode").classList.toggle("active", income);
  $("#expenseForm").classList.add("hidden");
  $("#incomeForm").classList.toggle("hidden", !income);
  const result = calculate();
  renderCalendar(result);
  renderRecords();
  renderSummary(result);
  renderMobile(result);
}

function addMember(name) {
  const clean = name.trim();
  if (!clean || members.includes(clean)) return;
  members.push(clean);
  avatars.push("🙂");
  state.accounts = state.accounts || {};
  state.accounts[clean] = state.accounts[clean] || "";
  state.expenses = state.expenses.map((item) => item.fund || item.payer === "공금" ? item : { ...item, members: [...item.members, clean] });
  render();
}

function addMeeting() {
  syncCurrentMeeting();
  const title = `새 모임 ${meetings.length + 1}`;
  const meeting = makeMeeting(title, false);
  meetings.push(meeting);
  currentMeetingId = meeting.id;
  members = [...meeting.members];
  avatars = [...meeting.avatars];
  state = JSON.parse(JSON.stringify(meeting.state));
  render();
  notifyMeetingCreated(title);
}

function deleteMeeting() {
  // always keep at least one meeting so the rest of the UI never has
  // nothing to display
  if (meetings.length <= 1) return;
  const current = meetings.find((meeting) => meeting.id === currentMeetingId);
  if (!current) return;
  if (!confirm(`"${current.state.title || "이 모임"}" 모임을 삭제할까요? 모임 안의 지출/영수증 내역도 함께 삭제됩니다.`)) return;
  meetings = meetings.filter((meeting) => meeting.id !== currentMeetingId);
  const next = meetings[0];
  currentMeetingId = next.id;
  members = [...next.members];
  avatars = [...next.avatars];
  state = JSON.parse(JSON.stringify(next.state));
  render();
}

// Cloud Functions triggers can't be deployed on this Firebase project (Blaze
// plan required, unavailable) — push delivery goes through a Netlify
// function instead, called explicitly right after a meeting is created
// rather than relying on a database write trigger.
async function notifyMeetingCreated(name) {
  const token = await currentUser?.getIdToken().catch(() => null);
  if (!token) return;
  return fetch("/.netlify/functions/notify-broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ title: "새 일정이 추가됐어요", body: name })
  }).then((response) => {
    if (!response.ok) throw new Error(`푸시 알림 전송 실패 (${response.status})`);
    return response;
  }).catch((error) => {
    console.error("일정 푸시 알림을 보내지 못했습니다.", error);
  });
}

function removeMember(name) {
  if (name === members[0] || members.length <= 1) return;
  members = members.filter((item) => item !== name);
  avatars = members.map((_, index) => avatars[index] || "🙂");
  if (state.accounts) delete state.accounts[name];
  if (openMemberSettings === name) openMemberSettings = null;
  cleanDataAfterMemberChange();
  render();
}

function shiftMonth(delta) {
  const date = fromDateKey(state.meetDate);
  date.setMonth(date.getMonth() + delta);
  state.meetDate = toDateKey(date);
  render();
}

function playSceneTransition() {
  document.body.classList.remove("scene-transitioning");
  void document.body.offsetWidth;
  document.body.classList.add("scene-transitioning");
  window.setTimeout(() => document.body.classList.remove("scene-transitioning"), 220);
}

function activateNav(target) {
  playSceneTransition();
  if (target === "settle") delete document.body.dataset.page;
  else document.body.dataset.page = target;
  document.body.dataset.mobileView = target === "settle" ? "" : target;
  if (target === "settle") delete document.body.dataset.mobileView;
  document.body.classList.remove("mobile-menu-open");
  document.querySelectorAll("[data-nav]").forEach((item) => {
    item.classList.toggle("active", item.dataset.nav === target);
  });
  const targets = {
    settle: "#settleCard",
    history: "#historyCard",
    calendar: "#calendarCard",
    detail: "#detailCard",
    settings: "#membersCard"
  };
  const element = document.querySelector(targets[target] || "#membersCard");
  if (target === "settle") renderSummary(calculate());
  if (["settle", "detail", "history", "settings", "calendar"].includes(target)) {
    scrollTo({ top: 0, behavior: "smooth" });
  } else if (!matchMedia("(max-width: 720px)").matches) {
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    scrollTo({ top: 0, behavior: "smooth" });
  }
}

function showAppShell() {
  if (!currentUser) {
    showLandingAuth("login");
    return;
  }
  ensureMemberLinks();
  if (!isSiteCrewMember()) {
    showNoCrewGate();
    return;
  }
  hideNoCrewGate();
  document.body.classList.remove("landing-visible");
  document.body.classList.add("app-visible");
  $("#landingAuth")?.classList.add("hidden");
  const params = new URLSearchParams(location.search);
  params.delete("landing");
  history.replaceState(null, "", `${location.pathname}?${params.toString()}#app`);
  window.scrollTo({ top: 0, behavior: "auto" });
  activateNav("settle");
  updateProfileButton();
}

// A left-crew account is still a real, signed-in Firebase user — nothing
// stops it from re-loading this shared room's data. Membership (by uid link
// or, for legacy entries, matching display name) is what actually gates
// access to the crew's content; being merely logged in is not enough.
function isSiteCrewMember() {
  if (!currentUser) return false;
  if (currentUser.email && currentUser.email === ADMIN_EMAIL) return true;
  const myName = (currentUser.displayName || currentUser.email?.split("@")[0] || "").trim();
  return meetings.some((meeting) => {
    const links = meeting.state?.memberLinks || {};
    if (Object.values(links).includes(currentUser.uid)) return true;
    return !!myName && (meeting.members || []).includes(myName);
  });
}

// Re-checks crew membership once real remote room data has loaded (called
// after startFirebaseSync's initial fetch and after every onValue update) —
// only acts if the visitor is already past the marketing landing page, so
// it doesn't yank a signed-in user out of the public landing they're just
// browsing.
function refreshCrewGate() {
  if (!currentUser) return;
  if (!document.body.classList.contains("app-visible") && !document.body.classList.contains("crew-gate-visible")) return;
  if (isSiteCrewMember()) {
    hideNoCrewGate();
    document.body.classList.remove("landing-visible");
    document.body.classList.add("app-visible");
  } else {
    showNoCrewGate();
  }
}

function showNoCrewGate() {
  document.body.classList.remove("landing-visible", "app-visible");
  document.body.classList.add("crew-gate-visible");
  $("#noCrewGate")?.classList.remove("hidden");
  $("#landingAuth")?.classList.add("hidden");
}

function hideNoCrewGate() {
  document.body.classList.remove("crew-gate-visible");
  $("#noCrewGate")?.classList.add("hidden");
}

function showLandingAuth(mode = "login") {
  const signup = mode === "signup";
  $("#landingAuth")?.classList.remove("hidden");
  document.querySelectorAll("[data-auth-tab]").forEach((button) => button.classList.toggle("active", button.dataset.authTab === mode));
  document.querySelectorAll(".signup-only").forEach((item) => item.classList.toggle("hidden", !signup));
  $("#authTitle").textContent = signup ? "회원가입" : "로그인";
  $("#authDescription").textContent = signup ? "크루 지출, 영수증 한 장으로." : "모임 정산을 이어서 진행하세요.";
  $(".auth-submit").textContent = signup ? "회원가입" : "로그인";
  const error = $("#authError");
  if (error) {
    error.textContent = "";
    error.classList.add("hidden");
  }
}

function setAuthError(message) {
  const error = $("#authError");
  if (!error) return;
  error.textContent = message || "";
  error.classList.toggle("hidden", !message);
}

async function handleAuthFormSubmit() {
  const isSignup = document.querySelector("[data-auth-tab].active")?.dataset.authTab === "signup";
  const email = ($("#authEmail")?.value || "").trim();
  const password = $("#authPassword")?.value || "";
  const name = ($("#authName")?.value || "").trim();
  const submitBtn = $(".auth-submit");
  if (!email || !password) {
    setAuthError("이메일과 비밀번호를 입력해 주세요");
    return;
  }
  setAuthError("");
  if (submitBtn) submitBtn.disabled = true;
  try {
    if (isSignup) {
      const cred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
      if (name) await updateProfile(cred.user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(firebaseAuth, email, password);
    }
    showAppShell();
  } catch (error) {
    console.error(error);
    setAuthError("이메일 또는 비밀번호를 확인해 주세요");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleGoogleLogin() {
  const googleBtn = $("#googleLoginBtn");
  if (googleBtn) googleBtn.disabled = true;
  setAuthError("");
  try {
    await signInWithPopup(firebaseAuth, googleProvider);
    showAppShell();
  } catch (error) {
    console.error(error);
    setAuthError("Google 로그인에 실패했어요");
  } finally {
    if (googleBtn) googleBtn.disabled = false;
  }
}

async function handleLogout() {
  closeProfileModal();
  await signOut(firebaseAuth).catch((error) => console.error(error));
}

// Ties the signed-in account (uid) to whichever existing member name
// matches it, per meeting, so later actions (leaving the crew, in
// particular) can resolve "who am I here" from the account rather than a
// display-name string match — two accounts can't share a name, and a
// renamed account won't lose its membership record.
function ensureMemberLinks() {
  if (!currentUser) return;
  const myName = (currentUser.displayName || currentUser.email?.split("@")[0] || "").trim();
  if (!myName) return;
  let changed = false;
  meetings.forEach((meeting) => {
    meeting.state = meeting.state || {};
    meeting.state.memberLinks = meeting.state.memberLinks || {};
    const alreadyLinked = Object.values(meeting.state.memberLinks).includes(currentUser.uid);
    if (alreadyLinked) return;
    if ((meeting.members || []).includes(myName) && !meeting.state.memberLinks[myName]) {
      meeting.state.memberLinks[myName] = currentUser.uid;
      changed = true;
    }
  });
  if (changed) {
    syncCurrentMeeting();
    save();
  }
}

async function handleLeaveCrew() {
  if (!confirm("정말 이 크루에서 탈퇴할까요? 탈퇴하면 초대 링크로만 다시 들어올 수 있어요.")) return;
  if (currentUser) {
    const uid = currentUser.uid;
    const fallbackName = (currentUser.displayName || currentUser.email?.split("@")[0] || "").trim();
    let changed = false;
    meetings.forEach((meeting) => {
      meeting.state = meeting.state || {};
      meeting.state.memberLinks = meeting.state.memberLinks || {};
      const linkedName = Object.entries(meeting.state.memberLinks).find(([, linkedUid]) => linkedUid === uid)?.[0];
      const targetName = linkedName || (fallbackName && (meeting.members || []).includes(fallbackName) ? fallbackName : null);
      if (!targetName) return;
      const index = (meeting.members || []).indexOf(targetName);
      if (index < 0) return;
      meeting.members.splice(index, 1);
      if (Array.isArray(meeting.avatars)) meeting.avatars.splice(index, 1);
      delete meeting.state.memberLinks[targetName];
      if (meeting.state.accounts) delete meeting.state.accounts[targetName];
      changed = true;
      // syncCurrentMeeting() rebuilds the active meeting's members/avatars
      // from these globals, which would otherwise undo the splice above for
      // whichever meeting is currently open.
      if (meeting.id === currentMeetingId) {
        const globalIndex = members.indexOf(targetName);
        if (globalIndex >= 0) {
          members.splice(globalIndex, 1);
          avatars.splice(globalIndex, 1);
        }
        if (state.accounts) delete state.accounts[targetName];
        if (state.memberLinks) delete state.memberLinks[targetName];
      }
    });
    if (changed) {
      syncCurrentMeeting();
      await save();
    }
  }
  await handleLogout();
}

function updateProfileButton() {
  if (!currentUser) return;
  const label = (currentUser.displayName || currentUser.email || "").trim();
  const initial = label ? label[0].toUpperCase() : "?";
  document.querySelectorAll("#profileNavBtn, #profileNavBtnMobile").forEach((btn) => {
    btn.textContent = initial;
    btn.classList.remove("hidden");
  });
}

function openProfileModal() {
  if (!currentUser) return;
  const name = currentUser.displayName || currentUser.email || "사용자";
  $("#profileName").textContent = name;
  $("#profileEmail").textContent = currentUser.email || "";
  const avatarImg = $("#profileAvatarImg");
  const avatarInitial = $("#profileAvatarInitial");
  if (currentUser.photoURL) {
    avatarImg.src = currentUser.photoURL;
    avatarImg.classList.remove("hidden");
    avatarInitial.classList.add("hidden");
  } else {
    avatarImg.classList.add("hidden");
    avatarInitial.classList.remove("hidden");
    avatarInitial.textContent = name.trim()[0]?.toUpperCase() || "?";
  }
  $("#profileModal")?.classList.remove("hidden");
}

function closeProfileModal() {
  $("#profileModal")?.classList.add("hidden");
}

// Runs on every auth state change. Signed-out visitors are always sent back
// to the login screen — even mid-session, e.g. after signing out — instead
// of silently falling back to a no-login shared session like the site used
// to.
function renderAuthGate() {
  if (currentUser) {
    updateProfileButton();
    return;
  }
  // Only react here if they were already inside the app (e.g. just signed
  // out) — the very first auth check on page load is handled by the
  // authReady.then() bootstrap below, which knows whether this visit even
  // wants the app (vs. just browsing the public marketing landing page).
  const wasInsideApp = document.body.classList.contains("app-visible") || document.body.classList.contains("crew-gate-visible");
  if (!wasInsideApp) return;
  hideNoCrewGate();
  document.body.classList.remove("app-visible");
  document.body.classList.add("landing-visible");
  showLandingAuth("login");
}

function resetAll() {
  if (!confirm("모든 기록을 초기 상태로 되돌릴까요?")) return;
  localStorage.removeItem(storageKey);
  members = [...defaultMembers];
  avatars = [...defaultAvatars];
  state = createDefaultState(DEFAULT_MEETING_TITLE, false);
  meetings = [{ id: "default", members: [...members], avatars: [...avatars], state: JSON.parse(JSON.stringify(state)) }];
  currentMeetingId = "default";
  render();
}

setupRoomId();
load();
normalizeMeetingDates();
isApplyingRemote = true;
render();
isApplyingRemote = false;
startFirebaseSync();
authReady.then(() => {
  if (shouldStartOnLanding && location.hash !== "#app") {
    document.body.classList.add("landing-visible");
    document.body.classList.remove("app-visible");
  } else if (currentUser) {
    document.body.classList.remove("landing-visible");
    document.body.classList.add("app-visible");
    updateProfileButton();
    ensureMemberLinks();
    // meetings may still be the local/default placeholder here — startFirebaseSync()
    // re-checks membership once the real remote room data has actually loaded.
    if (!isSiteCrewMember()) showNoCrewGate();
  } else {
    // A direct #app/?room= link (e.g. shared from inside the app) but no
    // signed-in session yet — ask them to log in instead of silently
    // exposing the shared crew's data.
    document.body.classList.remove("app-visible");
    document.body.classList.add("landing-visible");
    showLandingAuth("login");
  }
});

$("#addMeetingBtn")?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  addMeeting();
});

$("#meetingSelect")?.addEventListener("change", (event) => {
  useMeeting(event.target.value);
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "scheduleForm") {
    const title = $("#scheduleTitle").value.trim();
    const date = $("#scheduleDate").value;
    if (!title || !date) return;
    const nextSchedule = {
      id: editingScheduleId || `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      date,
      time: $("#scheduleTime").value,
      location: $("#scheduleLocation").value.trim(),
      memo: $("#scheduleMemo").value.trim()
    };
    state.schedules = state.schedules || [];
    const existingIndex = state.schedules.findIndex((item) => item.id === editingScheduleId);
    const isNewSchedule = existingIndex < 0;
    if (existingIndex >= 0) state.schedules.splice(existingIndex, 1, nextSchedule);
    else state.schedules.push(nextSchedule);
    state.meetDate = date;
    closeScheduleModal();
    render();
    if (isNewSchedule) {
      const scheduleTime = nextSchedule.time ? ` ${nextSchedule.time}` : "";
      const scheduleLocation = nextSchedule.location ? ` · ${nextSchedule.location}` : "";
      notifyMeetingCreated(`${nextSchedule.title} · ${nextSchedule.date}${scheduleTime}${scheduleLocation}`);
    }
    return;
  }
  if (event.target.id === "landingAuthForm") {
    handleAuthFormSubmit();
    return;
  }
  if (event.target.id === "memberForm") {
    addMember($("#memberName").value);
  }
  if (event.target.id === "expenseForm") {
    const amount = numberFrom($("#expenseAmount").value);
    const selectedMembers = selectedOptions($("#expenseMembers"));
    const payer = ensureMemberName(payerFromFields("expensePayer", "expensePayerName"));
    const fundUsed = payer === "공금" ? amount : Math.min(amount, numberFrom($("#fundUsedAmount").value));
    const isFund = payer === "공금" || fundUsed > 0;
    const fronted = payer === "공금" ? 0 : amount - fundUsed;
    if (!amount || ((!isFund || fronted > 0) && selectedMembers.length === 0)) return;
    const nextExpense = {
      name: $("#expenseName").value.trim() || "새 지출",
      date: $("#expenseDate").value || state.meetDate,
      amount,
      payer,
      category: $("#expenseCategory").value,
      members: payer === "공금" ? [] : selectedMembers,
      fund: isFund,
      fundUsed: isFund ? fundUsed : 0
    };
    if (editingExpenseIndex !== null) {
      state.expenses.splice(editingExpenseIndex, 1, nextExpense);
      clearExpenseEdit();
    } else {
      state.expenses.unshift(nextExpense);
    }
    event.target.reset();
    $("#expensePayerName").value = "";
    $("#fundPayerBtn").classList.remove("active");
    render();
  }
  if (event.target.id === "incomeForm") {
    const amount = numberFrom($("#incomeAmount").value);
    if (!amount) return;
    const splitMembers = selectedOptions($("#incomeMembers"));
    const shouldSplit = $("#incomeSplitAll").checked;
    const nextIncomes = [];
    if (shouldSplit && splitMembers.length) {
      const share = Math.round(amount / splitMembers.length);
      const remainder = amount - share * splitMembers.length;
      splitMembers.forEach((payer, index) => {
        nextIncomes.push({
          name: $("#incomeName").value.trim() || "공금 충전",
          date: $("#incomeDate").value || state.meetDate,
          amount: share + (index === 0 ? remainder : 0),
          payer,
          category: $("#incomeCategory").value
        });
      });
    } else {
      nextIncomes.push({ name: $("#incomeName").value.trim() || "공금 수입", date: $("#incomeDate").value || state.meetDate, amount, payer: $("#incomePayer").value, category: $("#incomeCategory").value });
    }
    if (editingIncomeIndex !== null) {
      state.incomes.splice(editingIncomeIndex, 1, ...nextIncomes);
      clearIncomeEdit();
    } else {
      state.incomes.unshift(...nextIncomes);
    }
    event.target.reset();
    render();
  }
  if (event.target.id === "mobileExpenseForm") {
    const amount = numberFrom($("#mobileExpenseAmount").value);
    const selectedMembers = mobileActiveValues("mobileExpenseMembers");
    const payer = ensureMemberName(payerFromFields("mobileExpensePayer", "mobileExpensePayerName"));
    const fundUsed = payer === "공금" ? amount : Math.min(amount, numberFrom($("#mobileFundUsedAmount").value));
    const isFund = payer === "공금" || fundUsed > 0;
    const fronted = payer === "공금" ? 0 : amount - fundUsed;
    if (!amount || ((!isFund || fronted > 0) && selectedMembers.length === 0)) return;
    state.expenses.unshift({
      name: $("#mobileExpenseName").value.trim() || "새 지출",
      date: $("#mobileExpenseDate").value || state.meetDate,
      amount,
      payer,
      category: $("#mobileExpenseCategory").value,
      members: payer === "공금" ? [] : selectedMembers,
      fund: isFund,
      fundUsed: isFund ? fundUsed : 0
    });
    event.target.reset();
    $("#mobileExpensePayerName").value = "";
    $("#mobileFundPayerBtn").classList.remove("active");
    render();
  }
  if (event.target.id === "mobileIncomeForm") {
    const amount = numberFrom($("#mobileIncomeAmount").value);
    if (!amount) return;
    const splitMembers = mobileActiveValues("mobileIncomeMembers");
    const nextIncomes = [];
    if ($("#mobileIncomeSplitAll").checked && splitMembers.length) {
      const share = Math.round(amount / splitMembers.length);
      const remainder = amount - share * splitMembers.length;
      splitMembers.forEach((payer, index) => {
        nextIncomes.push({
          name: $("#mobileIncomeName").value.trim() || "공금 충전",
          date: $("#mobileIncomeDate").value || state.meetDate,
          amount: share + (index === 0 ? remainder : 0),
          payer,
          category: $("#mobileIncomeCategory").value
        });
      });
    } else {
      nextIncomes.push({
        name: $("#mobileIncomeName").value.trim() || "공금 수입",
        date: $("#mobileIncomeDate").value || state.meetDate,
        amount,
        payer: $("#mobileIncomePayer").value,
        category: $("#mobileIncomeCategory").value
      });
    }
    state.incomes.unshift(...nextIncomes);
    event.target.reset();
    render();
  }
});

document.addEventListener("click", async (event) => {
  if (event.target.id === "openScheduleBtn" || event.target.id === "homeAddScheduleBtn" || event.target.id === "mobileAddScheduleBtn") {
    openScheduleModal(null, state.meetDate);
    return;
  }
  if (event.target.id === "closeScheduleModal" || event.target.id === "cancelScheduleBtn" || event.target.id === "scheduleModal") {
    closeScheduleModal();
    return;
  }
  const scheduleRow = event.target.closest("[data-schedule-id]");
  if (scheduleRow) {
    openScheduleModal(scheduleRow.dataset.scheduleId);
    return;
  }
  if (event.target.id === "deleteScheduleBtn" && editingScheduleId) {
    const schedule = (state.schedules || []).find((item) => item.id === editingScheduleId);
    if (!schedule || !confirm(`"${schedule.title}" 일정을 삭제할까요?`)) return;
    state.schedules = state.schedules.filter((item) => item.id !== editingScheduleId);
    closeScheduleModal();
    render();
    return;
  }
  if (event.target.id === "homePrevMonth") {
    shiftMonth(-1);
    return;
  }
  if (event.target.id === "homeNextMonth") {
    shiftMonth(1);
    return;
  }
  const homeDate = event.target.closest("[data-home-date]");
  if (homeDate) {
    state.meetDate = homeDate.dataset.homeDate;
    render();
    return;
  }
  const enterApp = event.target.closest("[data-enter-app]");
  if (enterApp) {
    showAppShell();
    return;
  }
  const openAuth = event.target.closest("[data-open-auth]");
  if (openAuth) {
    showLandingAuth(openAuth.dataset.openAuth || "login");
    return;
  }
  const authTab = event.target.closest("[data-auth-tab]");
  if (authTab) {
    showLandingAuth(authTab.dataset.authTab);
    return;
  }
  if (event.target.closest("[data-close-auth]")) {
    $("#landingAuth")?.classList.add("hidden");
    return;
  }
  if (event.target.closest("#googleLoginBtn")) {
    handleGoogleLogin();
    return;
  }
  if (event.target.closest("#profileNavBtn, #profileNavBtnMobile")) {
    openProfileModal();
    return;
  }
  if (event.target.closest("[data-close-profile]")) {
    closeProfileModal();
    return;
  }
  if (event.target.closest("#logoutBtn")) {
    handleLogout();
    return;
  }
  if (event.target.closest("#leaveCrewBtn")) {
    handleLeaveCrew();
    return;
  }
  if (event.target.closest("#noCrewLogoutBtn")) {
    handleLogout();
    return;
  }
  if (event.target.closest("[data-landing-menu]")) {
    $("#landingPage")?.classList.toggle("menu-open");
    return;
  }
  const recordRow = event.target.closest("[data-record-type][data-record-index]");
  if (recordRow) {
    openRecordDetail(recordRow.dataset.recordType, Number(recordRow.dataset.recordIndex));
    return;
  }
  if (event.target.id === "closeRecordDetail" || event.target.id === "recordDetailModal") {
    closeRecordDetail();
    return;
  }
  if (event.target.id === "deleteRecordDetail" && activeRecordDetail) {
    if (!confirm("이 내역을 삭제할까요?")) return;
    const collection = activeRecordDetail.type === "income" ? state.incomes : state.expenses;
    collection.splice(activeRecordDetail.index, 1);
    closeRecordDetail();
    render();
    return;
  }
  const mobileTab = event.target.closest("[data-mobile-tab]");
  if (mobileTab) {
    const tab = mobileTab.dataset.mobileTab;
    document.body.dataset.mobileScreen = tab;
    document.querySelectorAll("[data-mobile-tab]").forEach((item) => item.classList.toggle("active", item.dataset.mobileTab === tab));
    document.querySelectorAll("[data-mobile-screen]").forEach((item) => item.classList.toggle("active", item.dataset.mobileScreen === tab));
    scrollTo({ top: 0, behavior: "smooth" });
  }
  const mobileMode = event.target.closest("[data-mobile-mode]");
  if (mobileMode) {
    mobileInputMode = mobileMode.dataset.mobileMode;
    document.querySelectorAll("[data-mobile-mode]").forEach((item) => item.classList.toggle("active", item.dataset.mobileMode === mobileInputMode));
    $("#mobileExpenseForm").classList.add("hidden");
    $("#mobileExpenseNotice")?.classList.toggle("hidden", mobileInputMode !== "expense");
    $("#mobileIncomeForm").classList.toggle("hidden", mobileInputMode !== "income");
  }
  const mobileRecords = event.target.closest("[data-mobile-records]");
  if (mobileRecords) {
    mobileRecordView = mobileRecords.dataset.mobileRecords;
    selectLatestRecordedDate(mobileRecordView);
    document.querySelectorAll("[data-mobile-records]").forEach((item) => item.classList.toggle("active", item.dataset.mobileRecords === mobileRecordView));
    renderMobile(calculate());
  }
  const recordDate = event.target.closest("[data-record-date]");
  if (recordDate) {
    state.meetDate = recordDate.dataset.recordDate;
    render();
    return;
  }
  const mobileChoice = event.target.closest("[data-mobile-choice]");
  if (mobileChoice) {
    mobileChoice.classList.toggle("active");
  }
  if (event.target.id === "mobileTodayBtn") {
    state.meetDate = toDateKey(new Date());
    render();
  }
  if (event.target.id === "mobilePrevMonth") shiftMonth(-1);
  if (event.target.id === "mobileNextMonth") shiftMonth(1);
  if (event.target.id === "mobileAddMeetingBtn") addMeeting();
  if (event.target.id === "mobileDeleteMeetingBtn") deleteMeeting();
  if (event.target.id === "mobileResetBtn") resetAll();
  if (event.target.id === "mobileAddMemberBtn") {
    addMember($("#mobileNewMember").value);
    $("#mobileNewMember").value = "";
  }
  if (event.target.dataset.mobileRemoveMember) removeMember(event.target.dataset.mobileRemoveMember);
  if (event.target.dataset.mobileDeleteExpense !== undefined) {
    state.expenses.splice(Number(event.target.dataset.mobileDeleteExpense), 1);
    render();
  }
  if (event.target.dataset.mobileDeleteIncome !== undefined) {
    state.incomes.splice(Number(event.target.dataset.mobileDeleteIncome), 1);
    render();
  }
  if (event.target.dataset.mobileDate) {
    state.meetDate = event.target.dataset.mobileDate;
    render();
  }
  if (event.target.id === "expenseMode") setMode("expense");
  if (event.target.id === "incomeMode") setMode("income");
  const personPill = event.target.closest(".person-pill");
  if (personPill) {
    if (personPill.id === "fundPayerBtn") {
      setPayerFields("expensePayer", "expensePayerName", "fundPayerBtn", "공금");
      return;
    }
    if (personPill.id === "mobileFundPayerBtn") {
      setPayerFields("mobileExpensePayer", "mobileExpensePayerName", "mobileFundPayerBtn", "공금");
      return;
    }
    const select = $(`#${personPill.dataset.select}`);
    if (!select) return;
    select.value = personPill.dataset.value;
    renderChoiceControls();
  }
  const memberCheck = event.target.closest(".member-check");
  if (memberCheck) {
    const select = $(`#${memberCheck.dataset.multi}`);
    const option = [...select.options].find((item) => item.value === memberCheck.dataset.value);
    if (option) option.selected = !option.selected;
    renderChoiceControls();
  }
  if (event.target.id === "cancelExpenseEdit") {
    $("#expenseForm").reset();
    clearExpenseEdit();
    render();
  }
  if (event.target.id === "cancelIncomeEdit") {
    $("#incomeForm").reset();
    clearIncomeEdit();
    render();
  }
  if (event.target.id === "prevMonth") shiftMonth(-1);
  if (event.target.id === "nextMonth") shiftMonth(1);
  if (event.target.id === "todayBtn") {
    state.meetDate = toDateKey(new Date());
    render();
    setFormDatesToMeetDate(true);
  }
  if (event.target.id === "resetBtn") resetAll();
  if (event.target.id === "addMeetingBtn") addMeeting();
  if (event.target.id === "deleteMeetingBtn") deleteMeeting();
  const memberSettings = event.target.closest("[data-member-settings]");
  if (memberSettings) {
    const name = memberSettings.dataset.memberSettings;
    openMemberSettings = openMemberSettings === name ? null : name;
    renderMembers();
  }
  if (event.target.closest("[data-member-settings-close]")) {
    openMemberSettings = null;
    renderMembers();
  }
  const navItem = event.target.closest("[data-nav]");
  if (navItem?.dataset.nav) activateNav(navItem.dataset.nav);
  if (event.target.dataset.member) removeMember(event.target.dataset.member);
  if (event.target.dataset.expense !== undefined) {
    clearExpenseEdit();
    state.expenses.splice(Number(event.target.dataset.expense), 1);
    render();
  }
  if (event.target.dataset.income !== undefined) {
    clearIncomeEdit();
    state.incomes.splice(Number(event.target.dataset.income), 1);
    render();
  }
  if (event.target.dataset.editExpense !== undefined) startExpenseEdit(Number(event.target.dataset.editExpense));
  if (event.target.dataset.editIncome !== undefined) startIncomeEdit(Number(event.target.dataset.editIncome));
  const settleToggle = event.target.closest("[data-settle-toggle]");
  if (settleToggle) {
    const name = settleToggle.dataset.settleToggle;
    if (collapsedSettleGroups.has(name)) collapsedSettleGroups.delete(name);
    else collapsedSettleGroups.add(name);
    renderSummary(calculate());
  }
  const completionButton = event.target.closest("[data-main-transfer-complete],[data-mobile-complete]");
  if (completionButton) {
    const key = completionButton.dataset.mainTransferComplete || completionButton.dataset.mobileComplete;
    state.completedTransfers = state.completedTransfers || {};
    state.completedTransfers[key] = !state.completedTransfers[key];
    render();
    return;
  }
  const day = event.target.closest(".cal-cell")?.dataset.day;
  if (day) {
    const date = fromDateKey(state.meetDate);
    date.setDate(Number(day));
    state.meetDate = toDateKey(date);
    render();
    setFormDatesToMeetDate(true);
  }
  if (event.target.id === "copyBtn" || event.target.id === "mobileShareBtn" || event.target.classList.contains("share-btn")) {
    const result = calculate();
    const rows = flatGroupedTransfers(netTransfers([...result.transfers, ...result.fundTransfers])).map((item) => `${item.from} -> ${item.to}: ${won(item.amount)}`).join("\n") || "정산할 금액 없음";
    await navigator.clipboard.writeText(`[놀고정산]\n${state.title}\n${shareUrl()}\n날짜: ${state.meetDate}\n총 지출: ${won(result.total)}\n공금 잔액: ${won(result.fundBalance)}\n${rows}`);
    const target = event.target;
    const old = target.textContent;
    target.textContent = "복사 완료!";
    setTimeout(() => target.textContent = old, 1200);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#scheduleModal").classList.contains("hidden")) {
    closeScheduleModal();
    return;
  }
  if (event.key === "Escape" && !$("#recordDetailModal").classList.contains("hidden")) closeRecordDetail();
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-record-type][data-record-index]")) {
    event.preventDefault();
    openRecordDetail(event.target.dataset.recordType, Number(event.target.dataset.recordIndex));
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "groupTitle") state.title = event.target.value;
  if (event.target.id === "mobileTitle") state.title = event.target.value;
  if (event.target.id === "meetMemo") state.meetMemo = event.target.value;
  if (event.target.id === "meetDate") state.meetDate = event.target.value;
  if (event.target.id === "meetTime") state.meetTime = event.target.value;
  if (event.target.id === "mobileMeetDate") state.meetDate = event.target.value;
  if (event.target.id === "expensePayerName") {
    $("#expensePayer").value = members[0] || "";
    updatePayerVisual("expensePayer", "expensePayerName", "fundPayerBtn");
  }
  if (event.target.id === "mobileExpensePayerName") {
    $("#mobileExpensePayer").value = members[0] || "";
    updatePayerVisual("mobileExpensePayer", "mobileExpensePayerName", "mobileFundPayerBtn");
  }
  if (event.target.dataset.account) {
    state.accounts = state.accounts || {};
    state.accounts[event.target.dataset.account] = event.target.value;
  }
  if (event.target.dataset.mobileAccount) {
    state.accounts = state.accounts || {};
    state.accounts[event.target.dataset.mobileAccount] = event.target.value;
  }
  if (["groupTitle", "meetMemo", "meetDate", "meetTime", "mobileTitle", "mobileMeetDate"].includes(event.target.id)) render();
  if (event.target.id === "meetDate") setFormDatesToMeetDate(true);
  if (event.target.id === "mobileMeetDate") {
    $("#mobileExpenseDate").value = state.meetDate;
    $("#mobileIncomeDate").value = state.meetDate;
  }
  if (event.target.dataset.account || event.target.dataset.mobileAccount) markSaving();
});

document.addEventListener("change", (event) => {
  if (event.target.id === "meetingSelect") useMeeting(event.target.value);
  if (event.target.id === "mobileMeetingSelect") useMeeting(event.target.value);
  if (event.target.id === "incomeSplitAll") {
    [...$("#incomeMembers").options].forEach((option) => {
      option.selected = event.target.checked;
    });
    renderChoiceControls();
  }
  if (event.target.id === "mobileIncomeSplitAll") {
    document.querySelectorAll("#mobileIncomeMembers .mobile-choice").forEach((item) => item.classList.toggle("active", event.target.checked));
  }
});

setTimeout(() => {
  document.body.classList.add("ui-ready");
}, 900);
