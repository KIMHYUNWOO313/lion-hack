/**
 * Lion Meet — Firebase recording (video + audio + chat metadata)
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  collection,
  addDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getDownloadURL,
  getStorage,
  ref,
  uploadBytesResumable,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

function getCookie(name) {
  const v = `; ${document.cookie}`;
  const p = v.split(`; ${name}=`);
  if (p.length === 2) return p.pop().split(";").shift();
  return "";
}

function pickMimeType() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `rec-${Date.now()}`;
}

const WRITE_TIMEOUT_MS = 12_000;
const FINALIZE_TIMEOUT_MS = 15_000;

export function createMeetingRecorder(options) {
  const {
    firebaseConfig,
    roomId,
    roomName,
    participantId,
    participantName,
    getLocalStream,
    getRemoteStreams,
    getParticipantIds,
    onStatusChange,
  } = options;

  const app = initializeApp(firebaseConfig, `lion-recording-${roomId}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  storage.maxUploadRetryTime = 20_000;
  storage.maxOperationRetryTime = 20_000;

  let sessionId = null;
  let recorder = null;
  let canvas = null;
  let ctx = null;
  let drawTimer = null;
  let audioCtx = null;
  let audioDest = null;
  const audioSources = new Map();
  let chunkIndex = 0;
  let uploadedChunks = [];
  const pendingUploads = new Set();
  let recording = false;
  let meetingStartMs = Date.now();
  let finalizePromise = null;
  let useServerSession = false;

  function setStatus(text, level = "info") {
    onStatusChange?.({ text, level, sessionId, recording });
  }

  // Firestore writes never settle while the backend is unreachable (e.g. the
  // database has not been created yet), so every call needs its own deadline.
  function withTimeout(promise, ms, label) {
    let timer = null;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 시간 초과 (${ms / 1000}초)`)),
          ms
        );
      }),
    ]);
  }

  async function ensureFirebaseAuth() {
    if (auth.currentUser) return auth.currentUser;

    const existingUser = await new Promise((resolve) => {
      let settled = false;
      const unsub = onAuthStateChanged(auth, (user) => {
        if (settled) return;
        settled = true;
        unsub();
        resolve(user);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        resolve(auth.currentUser || null);
      }, 2000);
    });
    if (existingUser) return existingUser;

    const res = await fetch("/api/auth/firebase-token/", {
      headers: { "X-CSRFToken": getCookie("csrftoken") },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        data.code === "firebase_admin_missing"
          ? "Firebase Storage 업로드를 위해 서버 service account 설정이 필요합니다."
          : data.error || "Firebase 인증에 실패했습니다."
      );
    }
    await signInWithCustomToken(auth, data.token);
    return auth.currentUser;
  }

  async function startServerSession(existingSessionId = null) {
    const res = await fetch("/api/recordings/session/start/", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCookie("csrftoken"),
      },
      body: JSON.stringify({
        roomId,
        roomName,
        participantId,
        participantName,
        sessionId: existingSessionId || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "녹화 세션 생성 실패");
    }
    sessionId = data.sessionId;
    meetingStartMs = Date.now();
    useServerSession = true;
    return sessionId;
  }

  async function registerChunkOnServer(idx, url, size) {
    if (!useServerSession || !sessionId) return;
    try {
      await fetch(`/api/recordings/session/${sessionId}/chunk/`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": getCookie("csrftoken"),
        },
        body: JSON.stringify({
          participantId,
          participantName,
          index: idx,
          url,
          size,
        }),
      });
    } catch (err) {
      console.warn("Server chunk register failed:", err);
    }
  }

  async function completeSessionOnServer(duration) {
    if (!useServerSession || !sessionId) return false;
    try {
      const res = await fetch(`/api/recordings/session/${sessionId}/complete/`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": getCookie("csrftoken"),
        },
        body: JSON.stringify({ participantId, durationSec: duration }),
      });
      return res.ok;
    } catch (err) {
      console.warn("Server session complete failed:", err);
      return false;
    }
  }

  async function mirrorSessionToFirestore(user, status = "recording") {
    if (!sessionId) return;
    try {
      const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
      await withTimeout(
        setDoc(
          sessionRef,
          {
            roomId,
            roomName: roomName || "",
            status,
            startedAt: serverTimestamp(),
            startedBy: {
              uid: user?.uid || "",
              email: user?.email || "",
              displayName: user?.displayName || participantName || "",
            },
            participantUids: user?.uid ? [user.uid] : [],
            [`videos.${participantId}.participantName`]: participantName,
            [`videos.${participantId}.chunks`]: uploadedChunks,
          },
          { merge: true }
        ),
        WRITE_TIMEOUT_MS,
        "Firestore mirror"
      );
      await indexSessionForUser(user, status).catch(() => {});
    } catch (_) {
      /* Firestore optional */
    }
  }

  async function indexSessionForUser(user, status = "recording") {
    if (!user?.uid || !sessionId) return;
    const indexRef = doc(db, "userRecordings", user.uid, "sessions", `${roomId}_${sessionId}`);
    await withTimeout(
      setDoc(
        indexRef,
        {
          roomId,
          sessionId,
          roomName: roomName || "",
          status,
          startedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          participantId,
          participantName: participantName || "",
        },
        { merge: true }
      ),
      WRITE_TIMEOUT_MS,
      "녹화 목록 저장"
    );
  }

  async function createSession() {
    await startServerSession();
    mirrorSessionToFirestore(auth.currentUser, "recording");
    return sessionId;
  }

  async function attachToSession(existingSessionId) {
    await startServerSession(existingSessionId);
    mirrorSessionToFirestore(auth.currentUser, "recording");
    return sessionId;
  }

  function elapsedSec() {
    return Math.floor((Date.now() - meetingStartMs) / 1000);
  }

  function getVideoSources() {
    const ids = getParticipantIds?.() || [];
    return ids
      .map((id) => {
        const video = document.getElementById(`video-${id}`);
        if (!video?.srcObject && !video?.videoWidth) return null;
        return { id, video, label: id === participantId ? participantName : id.slice(0, 6) };
      })
      .filter(Boolean);
  }

  function layoutGrid(count, width, height) {
    if (count <= 1) return [{ x: 0, y: 0, w: width, h: height }];
    if (count === 2) {
      return [
        { x: 0, y: 0, w: width / 2, h: height },
        { x: width / 2, y: 0, w: width / 2, h: height },
      ];
    }
    const cols = count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const cellW = width / cols;
    const cellH = height / rows;
    const slots = [];
    for (let i = 0; i < count; i++) {
      slots.push({
        x: (i % cols) * cellW,
        y: Math.floor(i / cols) * cellH,
        w: cellW,
        h: cellH,
      });
    }
    return slots;
  }

  function drawCompositeFrame() {
    if (!ctx || !canvas) return;
    const sources = getVideoSources();
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const slots = layoutGrid(sources.length || 1, canvas.width, canvas.height);
    if (!sources.length) {
      ctx.fillStyle = "#444";
      ctx.font = "24px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Lion Meet 녹화 중…", canvas.width / 2, canvas.height / 2);
      return;
    }

    sources.forEach((src, i) => {
      const slot = slots[i];
      try {
        if (src.video.readyState >= 2) {
          ctx.drawImage(src.video, slot.x, slot.y, slot.w, slot.h);
        } else {
          ctx.fillStyle = "#2d2d2d";
          ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
        }
      } catch (_) {
        ctx.fillStyle = "#2d2d2d";
        ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
      }
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(slot.x, slot.y + slot.h - 28, slot.w, 28);
      ctx.fillStyle = "#fff";
      ctx.font = "14px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(src.label || "참가자", slot.x + 8, slot.y + slot.h - 8);
    });
  }

  function connectAudioStream(stream, key) {
    if (!audioCtx || !audioDest || !stream) return;
    if (audioSources.has(key)) return;
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return;
    try {
      const source = audioCtx.createMediaStreamSource(new MediaStream(tracks));
      source.connect(audioDest);
      audioSources.set(key, source);
    } catch (_) {
      /* ignore duplicate or invalid stream */
    }
  }

  function setupAudioMix() {
    audioCtx = new AudioContext();
    audioDest = audioCtx.createMediaStreamDestination();
    connectAudioStream(getLocalStream?.(), "local");
    getRemoteStreams?.().forEach((stream, peerId) => connectAudioStream(stream, peerId));
  }

  async function uploadChunk(blob) {
    const task = (async () => {
      const idx = chunkIndex++;
      const path = `recordings/${roomId}/${sessionId}/${participantId}/chunk-${String(idx).padStart(5, "0")}.webm`;
      const storageRef = ref(storage, path);
      const uploadTask = uploadBytesResumable(storageRef, blob, {
        contentType: blob.type || "video/webm",
      });

      await new Promise((resolve, reject) => {
        uploadTask.on("state_changed", null, reject, resolve);
      });

      const url = await getDownloadURL(storageRef);
      uploadedChunks.push({ index: idx, path, url, size: blob.size });
      await registerChunkOnServer(idx, url, blob.size);
      if (!useServerSession) {
        const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
        await withTimeout(
          updateDoc(sessionRef, {
            [`videos.${participantId}.chunks`]: uploadedChunks,
            [`videos.${participantId}.participantName`]: participantName,
            [`videos.${participantId}.firebaseUid`]: auth.currentUser?.uid || "",
            updatedAt: serverTimestamp(),
          }),
          WRITE_TIMEOUT_MS,
          "청크 정보 저장"
        );
      }
    })();

    pendingUploads.add(task);
    try {
      await task;
    } finally {
      pendingUploads.delete(task);
    }
  }

  async function beginCapture() {
    canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    ctx = canvas.getContext("2d");
    setupAudioMix();
    drawCompositeFrame();
    drawTimer = setInterval(drawCompositeFrame, 1000 / 15);

    const videoStream = canvas.captureStream(15);
    audioDest.stream.getAudioTracks().forEach((t) => videoStream.addTrack(t));

    const mimeType = pickMimeType();
    if (!mimeType) {
      throw new Error("브라우저가 WebM 녹화를 지원하지 않습니다.");
    }

    recorder = new MediaRecorder(videoStream, {
      mimeType,
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000,
    });

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) {
        uploadChunk(e.data).catch((err) => {
          console.warn("Chunk upload failed:", err);
          setStatus("업로드 일부 실패", "warn");
        });
      }
    };

    recorder.onerror = (e) => {
      console.error("MediaRecorder error:", e);
      setStatus("녹화 오류", "error");
    };

    recorder.start(15_000);
    recording = true;
    setStatus("녹화 중", "recording");
  }

  async function start(existingSessionId = null) {
    if (recording) return sessionId;
    try {
      setStatus("Firebase 연결 중…");
      await ensureFirebaseAuth();
      if (existingSessionId) {
        await attachToSession(existingSessionId);
      } else {
        await createSession();
      }
      setStatus("녹화 준비 중…");
      await beginCapture();
      return sessionId;
    } catch (err) {
      console.error("Recording start failed:", err);
      setStatus(err.message || "녹화 시작 실패", "error");
      return null;
    }
  }

  async function joinSession(existingSessionId) {
    return start(existingSessionId);
  }

  async function saveChatClient(message, fromId, fromName, msgElapsedSec) {
    if (!sessionId || !message) return;
    try {
      await withTimeout(
        addDoc(collection(db, "meetings", roomId, "sessions", sessionId, "chat"), {
          fromId,
          fromName,
          message: message.slice(0, 500),
          elapsedSec: msgElapsedSec ?? elapsedSec(),
          createdAt: serverTimestamp(),
          source: "client",
        }),
        WRITE_TIMEOUT_MS,
        "채팅 저장"
      );
    } catch (err) {
      console.warn("Client chat save failed:", err);
    }
  }

  function onRemoteStream(peerId, stream) {
    connectAudioStream(stream, peerId);
  }

  function stop() {
    if (finalizePromise) return finalizePromise;

    finalizePromise = (async () => {
      if (!recording && !sessionId) return;

      recording = false;
      setStatus("녹화 저장 중…");

      clearInterval(drawTimer);
      drawTimer = null;

      const stopRecorder = new Promise((resolve) => {
        if (!recorder || recorder.state === "inactive") {
          resolve();
          return;
        }
        recorder.onstop = resolve;
        try {
          if (recorder.state === "recording") {
            recorder.requestData();
          }
          recorder.stop();
        } catch (_) {
          resolve();
        }
      });
      await withTimeout(stopRecorder, 5_000, "녹화 종료").catch(() => {});
      await withTimeout(
        Promise.allSettled([...pendingUploads]),
        FINALIZE_TIMEOUT_MS,
        "남은 영상 업로드"
      ).catch((err) => console.warn(err));

      audioSources.forEach((s) => {
        try {
          s.disconnect();
        } catch (_) {}
      });
      audioSources.clear();
      if (audioCtx?.state !== "closed") {
        await audioCtx?.close().catch(() => {});
      }

      let saved = false;
      const duration = elapsedSec();
      if (sessionId) {
        saved = await completeSessionOnServer(duration);
        if (!saved) {
          try {
            const user = auth.currentUser;
            const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
            await withTimeout(
              updateDoc(sessionRef, {
                status: "completed",
                endedAt: serverTimestamp(),
                durationSec: duration,
                [`videos.${participantId}.status`]: "completed",
                [`videos.${participantId}.chunkCount`]: uploadedChunks.length,
              }),
              WRITE_TIMEOUT_MS,
              "녹화 마무리 저장"
            );
            saved = true;
          } catch (err) {
            console.warn("Session finalize failed:", err);
          }
        }
        mirrorSessionToFirestore(auth.currentUser, "completed");
      }

      setStatus(
        saved ? "녹화 저장 완료" : "녹화 저장 실패 — 다시 시도해 주세요",
        saved ? "done" : "error"
      );
    })();

    return finalizePromise;
  }

  return {
    start,
    joinSession,
    stop,
    saveChatClient,
    onRemoteStream,
    getSessionId: () => sessionId,
    isRecording: () => recording,
  };
}
