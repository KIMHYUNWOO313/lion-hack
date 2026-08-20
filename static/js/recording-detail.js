import { getRecordingDetailClient } from "./firebase-recordings-client.js";

const cfg = JSON.parse(document.getElementById("recording-detail-meta").textContent);
const firebaseConfig = JSON.parse(document.getElementById("firebase-config").textContent);

const loadingEl = document.getElementById("detail-loading");
const errorEl = document.getElementById("detail-error");
const contentEl = document.getElementById("detail-content");
const player = document.getElementById("recording-player");
const chunkIndicator = document.getElementById("chunk-indicator");

let currentTrack = null;
let chunkIndex = 0;

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
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return iso;
  }
}

function formatElapsed(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDuration(sec) {
  const n = Number(sec) || 0;
  return `${Math.floor(n / 60)}분 ${n % 60}초`;
}

function statusLabel(status) {
  const map = { recording: "녹화 중", completed: "완료", uploading: "업로드 중" };
  return map[status] || status;
}

function playTrack(track) {
  if (!track?.chunks?.length) {
    player.removeAttribute("src");
    chunkIndicator.textContent = "업로드된 영상이 없습니다.";
    chunkIndicator.classList.remove("hidden");
    return;
  }
  currentTrack = track;
  chunkIndex = 0;
  playChunk(0);
}

function playChunk(index) {
  if (!currentTrack?.chunks?.[index]) return;
  chunkIndex = index;
  const chunk = currentTrack.chunks[index];
  player.src = chunk.url;
  player.load();
  player.play().catch(() => {});

  if (currentTrack.chunks.length > 1) {
    chunkIndicator.textContent = `파트 ${index + 1} / ${currentTrack.chunks.length}`;
    chunkIndicator.classList.remove("hidden");
  } else {
    chunkIndicator.classList.add("hidden");
  }
}

player?.addEventListener("ended", () => {
  if (currentTrack && chunkIndex + 1 < currentTrack.chunks.length) {
    playChunk(chunkIndex + 1);
  }
});

function renderTrackTabs(tracks) {
  const tabs = document.getElementById("track-tabs");
  if (!tabs) return;
  tabs.innerHTML = "";

  if (!tracks.length) {
    tabs.innerHTML = '<span class="recording-no-tracks">영상 트랙 없음</span>';
    return;
  }

  tracks.forEach((track, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `recording-track-tab${i === 0 ? " active" : ""}`;
    btn.textContent = track.participantName || `참가자 ${i + 1}`;
    btn.addEventListener("click", () => {
      tabs.querySelectorAll(".recording-track-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      playTrack(track);
    });
    tabs.appendChild(btn);
  });

  playTrack(tracks[0]);
}

function renderChat(messages) {
  const el = document.getElementById("side-chat");
  if (!el) return;
  if (!messages.length) {
    el.innerHTML = '<p class="recording-empty-side">저장된 채팅이 없습니다.</p>';
    return;
  }
  el.innerHTML = messages
    .map(
      (m) => `
      <div class="recording-chat-row">
        <span class="recording-chat-time">${formatElapsed(m.elapsedSec)}</span>
        <div class="recording-chat-bubble">
          <strong>${escapeHtml(m.fromName || "참가자")}</strong>
          <p>${escapeHtml(m.message)}</p>
        </div>
      </div>`
    )
    .join("");
}

function renderTranscripts(items) {
  const el = document.getElementById("side-transcripts");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<p class="recording-empty-side">저장된 전사가 없습니다.</p>';
    return;
  }
  el.innerHTML = items
    .map(
      (m) => `
      <div class="recording-transcript-row">
        <span class="recording-chat-time">${formatElapsed(m.elapsedSec)}</span>
        <div class="recording-chat-bubble">
          <strong>${escapeHtml(m.fromName || "참가자")}</strong>
          <p>${escapeHtml(m.transcript)}</p>
        </div>
      </div>`
    )
    .join("");
}

function setupSideTabs() {
  document.querySelectorAll(".recording-side-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".recording-side-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const name = tab.dataset.tab;
      document.getElementById("side-chat").classList.toggle("hidden", name !== "chat");
      document.getElementById("side-transcripts").classList.toggle("hidden", name !== "transcripts");
    });
  });
}

function showRecording(rec) {
  document.getElementById("detail-title").textContent = rec.roomName || "회의 녹화";
  document.getElementById("detail-date").textContent = formatDate(rec.startedAt);
  document.getElementById("detail-duration").textContent = formatDuration(rec.durationSec);
  const statusEl = document.getElementById("detail-status");
  statusEl.textContent = statusLabel(rec.status);
  statusEl.dataset.status = rec.status || "";

  renderTrackTabs(rec.videoTracks || []);
  renderChat(rec.chat || []);
  renderTranscripts(rec.transcripts || []);
  setupSideTabs();

  loadingEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
}

function showError(msg) {
  loadingEl.classList.add("hidden");
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

async function load() {
  try {
    const res = await fetch(`/api/recordings/${cfg.roomId}/${cfg.sessionId}/`);
    if (res.ok) {
      const data = await res.json();
      showRecording(data.recording);
      return;
    }

    if (res.status === 503) {
      const rec = await getRecordingDetailClient(firebaseConfig, cfg.roomId, cfg.sessionId);
      if (!rec) {
        showError("녹화본을 찾을 수 없거나 접근 권한이 없습니다.");
        return;
      }
      showRecording(rec);
      return;
    }

    const data = await res.json();
    showError(data.error || "녹화본을 불러오지 못했습니다.");
  } catch (err) {
    try {
      const rec = await getRecordingDetailClient(firebaseConfig, cfg.roomId, cfg.sessionId);
      if (!rec) {
        showError("녹화본을 찾을 수 없거나 접근 권한이 없습니다.");
        return;
      }
      showRecording(rec);
    } catch (clientErr) {
      showError(clientErr.message || "연결에 실패했습니다.");
    }
  }
}

load();
