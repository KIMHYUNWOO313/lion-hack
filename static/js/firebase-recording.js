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
  let recording = false;
  let meetingStartMs = Date.now();
  let finalizePromise = null;

  function setStatus(text, level = "info") {
    onStatusChange?.({ text, level, sessionId, recording });
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

  async function createSession() {
    sessionId = uuid();
    meetingStartMs = Date.now();
    const user = auth.currentUser;
    const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
    await setDoc(sessionRef, {
      roomId,
      roomName: roomName || "",
      status: "recording",
      startedAt: serverTimestamp(),
      startedBy: {
        uid: user?.uid || "",
        email: user?.email || "",
        displayName: user?.displayName || participantName || "",
      },
      participants: [
        {
          participantId,
          name: participantName || "",
          firebaseUid: user?.uid || "",
        },
      ],
    });
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
    const idx = chunkIndex++;
    const path = `recordings/${roomId}/${sessionId}/${participantId}/chunk-${String(idx).padStart(5, "0")}.webm`;
    const storageRef = ref(storage, path);
    const task = uploadBytesResumable(storageRef, blob, {
      contentType: blob.type || "video/webm",
    });

    await new Promise((resolve, reject) => {
      task.on("state_changed", null, reject, resolve);
    });

    const url = await getDownloadURL(storageRef);
    uploadedChunks.push({ index: idx, path, url, size: blob.size });
    const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
    await updateDoc(sessionRef, {
      [`videos.${participantId}.chunks`]: uploadedChunks,
      [`videos.${participantId}.participantName`]: participantName,
      updatedAt: serverTimestamp(),
    });
  }

  async function start() {
    if (recording) return sessionId;
    try {
      setStatus("Firebase 연결 중…");
      await ensureFirebaseAuth();
      await createSession();
      setStatus("녹화 준비 중…");

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
      return sessionId;
    } catch (err) {
      console.error("Recording start failed:", err);
      setStatus(err.message || "녹화 시작 실패", "error");
      return null;
    }
  }

  async function saveChatClient(message, fromId, fromName, msgElapsedSec) {
    if (!sessionId || !message) return;
    try {
      await addDoc(collection(db, "meetings", roomId, "sessions", sessionId, "chat"), {
        fromId,
        fromName,
        message: message.slice(0, 500),
        elapsedSec: msgElapsedSec ?? elapsedSec(),
        createdAt: serverTimestamp(),
        source: "client",
      });
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
          recorder.stop();
        } catch (_) {
          resolve();
        }
      });
      await stopRecorder;

      audioSources.forEach((s) => {
        try {
          s.disconnect();
        } catch (_) {}
      });
      audioSources.clear();
      if (audioCtx?.state !== "closed") {
        await audioCtx?.close().catch(() => {});
      }

      if (sessionId) {
        try {
          const sessionRef = doc(db, "meetings", roomId, "sessions", sessionId);
          await updateDoc(sessionRef, {
            status: "completed",
            endedAt: serverTimestamp(),
            durationSec: elapsedSec(),
            [`videos.${participantId}.status`]: "completed",
            [`videos.${participantId}.chunkCount`]: uploadedChunks.length,
          });
        } catch (err) {
          console.warn("Session finalize failed:", err);
        }
      }

      setStatus("녹화 저장 완료", "done");
    })();

    return finalizePromise;
  }

  return {
    start,
    stop,
    saveChatClient,
    onRemoteStream,
    getSessionId: () => sessionId,
    isRecording: () => recording,
  };
}
