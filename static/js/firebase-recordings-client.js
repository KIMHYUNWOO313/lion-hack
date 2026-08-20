/**
 * Client-side Firestore access for recordings (fallback when server SA missing).
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  collectionGroup,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

function getCookie(name) {
  const v = `; ${document.cookie}`;
  const p = v.split(`; ${name}=`);
  if (p.length === 2) return p.pop().split(";").shift();
  return "";
}

function tsToIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch (_) {}
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function userCanAccess(data, uid) {
  if (!uid || !data) return false;
  if (data.startedBy?.uid === uid) return true;
  for (const p of data.participants || []) {
    if (p.firebaseUid === uid) return true;
  }
  return false;
}

function serializeVideos(videos) {
  const items = [];
  for (const [participantId, info] of Object.entries(videos || {})) {
    if (!info || typeof info !== "object") continue;
    let chunks = info.chunks || [];
    if (!Array.isArray(chunks)) chunks = Object.values(chunks);
    chunks = chunks
      .filter((c) => c && c.url)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    items.push({
      participantId,
      participantName: info.participantName || participantId.slice(0, 8),
      status: info.status || "",
      chunkCount: info.chunkCount || chunks.length,
      chunks: chunks.map((c, i) => ({
        index: c.index ?? i,
        url: c.url,
        size: c.size || 0,
      })),
    });
  }
  return items;
}

function serializeSessionSummary(roomId, sessionId, data) {
  const videos = data.videos || {};
  let chunkCount = 0;
  let participantCount = 0;
  for (const info of Object.values(videos)) {
    if (!info || typeof info !== "object") continue;
    participantCount += 1;
    let chunks = info.chunks || [];
    if (!Array.isArray(chunks)) chunks = Object.values(chunks);
    chunkCount += chunks.length;
  }
  return {
    roomId,
    sessionId,
    roomName: data.roomName || "",
    status: data.status || "unknown",
    startedAt: tsToIso(data.startedAt),
    endedAt: tsToIso(data.endedAt),
    durationSec: data.durationSec || 0,
    chunkCount,
    participantCount,
  };
}

function serializeSession(roomId, sessionId, data) {
  const videoTracks = serializeVideos(data.videos);
  return {
    roomId,
    sessionId,
    roomName: data.roomName || "",
    status: data.status || "unknown",
    startedAt: tsToIso(data.startedAt),
    endedAt: tsToIso(data.endedAt),
    updatedAt: tsToIso(data.updatedAt),
    durationSec: data.durationSec || 0,
    startedBy: data.startedBy || {},
    participants: data.participants || [],
    videoTracks,
    chunkCount: videoTracks.reduce((n, v) => n + v.chunks.length, 0),
  };
}

let _app = null;
let _auth = null;
let _db = null;

export function initFirebaseRecordings(firebaseConfig) {
  if (!_app) {
    _app = initializeApp(firebaseConfig, "lion-recordings-view");
    _auth = getAuth(_app);
    _db = getFirestore(_app);
  }
  return { auth: _auth, db: _db };
}

export async function ensureFirebaseUser(auth) {
  if (auth.currentUser) return auth.currentUser;

  const existing = await new Promise((resolve) => {
    let done = false;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (done) return;
      done = true;
      unsub();
      resolve(user);
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      unsub();
      resolve(auth.currentUser || null);
    }, 400);
  });
  if (existing) return existing;

  const res = await fetch("/api/auth/firebase-token/", {
    headers: { "X-CSRFToken": getCookie("csrftoken") },
  });
  if (res.ok) {
    const data = await res.json();
    await signInWithCustomToken(auth, data.token);
    return auth.currentUser;
  }

  throw new Error(
    "Firebase 로그인이 필요합니다. 홈에서 로그아웃 후 다시 로그인해 주세요."
  );
}

export async function listRecordingsClient(firebaseConfig) {
  const { auth, db } = initFirebaseRecordings(firebaseConfig);
  const user = await ensureFirebaseUser(auth);
  const uid = user.uid;

  const attempts = [
    query(
      collectionGroup(db, "sessions"),
      where("startedBy.uid", "==", uid),
      orderBy("startedAt", "desc"),
      limit(30)
    ),
    query(collectionGroup(db, "sessions"), where("startedBy.uid", "==", uid), limit(30)),
  ];

  for (const q of attempts) {
    try {
      const snap = await getDocs(q);
      return snap.docs.map((docSnap) => {
        const roomId = docSnap.ref.parent.parent?.id;
        return serializeSessionSummary(roomId, docSnap.id, docSnap.data());
      });
    } catch (err) {
      console.warn("Firestore recordings query failed:", err);
    }
  }

  return [];
}

export async function getRecordingDetailClient(firebaseConfig, roomId, sessionId) {
  const { auth, db } = initFirebaseRecordings(firebaseConfig);
  const user = await ensureFirebaseUser(auth);
  const uid = user.uid;

  const { doc, getDoc } = await import(
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"
  );
  const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
  const sessionSnap = await getDoc(sessionRef);
  if (!sessionSnap.exists()) return null;

  const data = sessionSnap.data();
  if (!userCanAccess(data, uid)) return null;

  const detail = serializeSession(roomId, sessionId, data);

  const chatSnap = await getDocs(collection(sessionRef, "chat"));
  detail.chat = chatSnap.docs
    .map((d) => {
      const row = d.data();
      return {
        id: d.id,
        fromId: row.fromId || "",
        fromName: row.fromName || "",
        message: row.message || "",
        elapsedSec: row.elapsedSec || 0,
        createdAt: tsToIso(row.createdAt),
      };
    })
    .sort((a, b) => a.elapsedSec - b.elapsedSec);

  const transcriptSnap = await getDocs(collection(sessionRef, "transcripts"));
  detail.transcripts = transcriptSnap.docs
    .map((d) => {
      const row = d.data();
      return {
        id: d.id,
        fromId: row.fromId || "",
        fromName: row.fromName || "",
        transcript: row.transcript || "",
        elapsedSec: row.elapsedSec || 0,
        createdAt: tsToIso(row.createdAt),
      };
    })
    .sort((a, b) => a.elapsedSec - b.elapsedSec);

  return detail;
}
