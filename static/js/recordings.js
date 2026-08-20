import { listRecordingsClient } from "./firebase-recordings-client.js";

const listEl = document.getElementById("recordings-list");
const loadingEl = document.getElementById("recordings-loading");
const errorEl = document.getElementById("recordings-error");
const emptyEl = document.getElementById("recordings-empty");

const firebaseConfig = JSON.parse(document.getElementById("firebase-config").textContent);

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

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: "same-origin", signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

async function load() {
  try {
    const { res, data } = await fetchJson("/api/recordings/");
    if (res.ok) {
      showItems(data.recordings || []);
      return;
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      /* fall through to client */
    }
  }

  try {
    const items = await listRecordingsClient(firebaseConfig);
    showItems(items);
  } catch (err) {
    showError(err.message || "녹화본을 불러오지 못했습니다.");
  }
}

load();
