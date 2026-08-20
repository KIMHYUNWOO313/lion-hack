import { listRecordingsClient } from "./firebase-recordings-client.js";

const listEl = document.getElementById("recordings-list");
const loadingEl = document.getElementById("recordings-loading");
const errorEl = document.getElementById("recordings-error");
const emptyEl = document.getElementById("recordings-empty");

const firebaseConfig = JSON.parse(document.getElementById("firebase-config").textContent);
const useClientOnly = document.body.dataset.clientOnly === "true";

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return iso;
  }
}

function formatDuration(sec) {
  const n = Number(sec) || 0;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

function statusLabel(status) {
  const map = {
    recording: "녹화 중",
    completed: "완료",
    uploading: "업로드 중",
    failed: "실패",
  };
  return map[status] || status || "—";
}

function renderCard(item) {
  const title = item.roomName || "회의 녹화";
  const href = `/recordings/${item.roomId}/${item.sessionId}/`;
  const tracks = item.participantCount ?? item.videoTracks?.length ?? 0;
  const chunks = item.chunkCount || 0;
  const chatHint = item.status === "completed" ? "채팅·영상 포함" : "처리 중";

  return `
    <a class="recording-card" href="${escapeHtml(href)}">
      <div class="recording-card-icon">
        <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
          <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
        </svg>
      </div>
      <div class="recording-card-body">
        <h2>${escapeHtml(title)}</h2>
        <p class="recording-card-date">${formatDate(item.startedAt)}</p>
        <div class="recording-card-tags">
          <span class="rec-tag">${escapeHtml(statusLabel(item.status))}</span>
          <span class="rec-tag">${formatDuration(item.durationSec)}</span>
          <span class="rec-tag">${tracks}명 · ${chunks}청크</span>
          <span class="rec-tag">${chatHint}</span>
        </div>
      </div>
      <span class="recording-card-arrow">→</span>
    </a>`;
}

function showItems(items) {
  loadingEl.classList.add("hidden");
  if (!items.length) {
    emptyEl.classList.remove("hidden");
    return;
  }
  listEl.innerHTML = items.map(renderCard).join("");
  listEl.classList.remove("hidden");
}

function showError(msg) {
  loadingEl.classList.add("hidden");
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

async function loadFromServer() {
  const res = await fetch("/api/recordings/", { credentials: "same-origin" });
  if (res.ok) {
    const data = await res.json();
    return data.recordings || [];
  }
  if (res.status === 503) {
    const data = await res.json();
    if (data.code === "firestore_not_created") {
      throw new Error(data.error || "Firestore가 아직 설정되지 않았습니다.");
    }
    return null;
  }
  const data = await res.json();
  throw new Error(data.error || "녹화본을 불러오지 못했습니다.");
}

async function load() {
  try {
    if (useClientOnly) {
      showItems(await listRecordingsClient(firebaseConfig));
      return;
    }

    const clientPromise = listRecordingsClient(firebaseConfig).catch(() => []);
    const serverPromise = loadFromServer().catch(() => null);

    const [clientItems, serverItems] = await Promise.all([clientPromise, serverPromise]);
    const items =
      serverItems && serverItems.length
        ? serverItems
        : clientItems && clientItems.length
          ? clientItems
          : serverItems || clientItems || [];

    showItems(items);
  } catch (err) {
    try {
      const fallback = await listRecordingsClient(firebaseConfig);
      if (fallback.length) {
        showItems(fallback);
        return;
      }
    } catch (_) {
      /* ignore */
    }
    showError(err.message || "녹화본을 불러오지 못했습니다.");
  }
}

load();
