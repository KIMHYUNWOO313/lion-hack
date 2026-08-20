/**
 * Lion Meet — WebRTC mesh + Legal AI advisor (Zoom-style UI)
 */
(function () {
  "use strict";

  const config = window.MEETING_CONFIG;
  if (!config) return;

  let ws = null;
  let localStream = null;
  let screenStream = null;
  let myId = null;
  let myName = "";
  let audioEnabled = true;
  let videoEnabled = true;
  let isSharingScreen = false;
  let meetingStartTime = null;
  let timerInterval = null;

  const peers = new Map();
  const participants = new Map();
  const pendingCandidates = new Map();
  const remoteStreams = new Map();
  let drawerOpen = false;
  let activeDrawerTab = "participants";
  const DRAWER_TITLES = {
    participants: "참가자",
    chat: "채팅",
    legal: "법률 AI",
    risk: "리스크 모니터",
  };

  let legalCountries = [];
  let legalEnabled = false;
  let sttEnabled = false;
  let sttReady = false;
  let sttAudioCtx = null;
  let sttWorklet = null;
  let sttSource = null;
  const sttPartial = new Map();
  const speechLines = new Map();
  const waveformLevels = [];
  const WAVEFORM_MAX = 120;
  let lastRiskWindow = null;
  let myCountry = localStorage.getItem("lionmeet_my_country") || "KR";

  function loadPartnerCountries() {
    const stored = localStorage.getItem("lionmeet_partner_countries");
    if (stored) {
      try {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) return arr.filter(Boolean).slice(0, 8);
      } catch (_) {
        /* ignore */
      }
    }
    const legacy = localStorage.getItem("lionmeet_partner_country");
    return legacy ? [legacy] : [];
  }

  let partnerCountries = loadPartnerCountries();
  let meetingContext = localStorage.getItem("lionmeet_meeting_context") || "";
  let legalHistory = [];
  let legalBusy = false;
  let legalUiInitialized = false;
  let lastDetectedRisk = null;
  let alternativesBusy = false;
  let meetingRecorder = null;
  let recordingSessionId = null;
  let sharedRecordingSessionId = null;
  let recordingInitStarted = false;
  let leavingIntentionally = false;

  const DRAWER_WIDTH_KEY = "lionmeet_drawer_width";
  const DRAWER_MIN = 300;
  const DRAWER_MAX_RATIO = 0.55;
  let drawerWidth = Math.min(
    Math.max(parseInt(localStorage.getItem(DRAWER_WIDTH_KEY), 10) || 380, DRAWER_MIN),
    Math.floor(window.innerWidth * DRAWER_MAX_RATIO)
  );

  let lobbyVideoEnabled = true;
  let lobbyAudioEnabled = true;
  let mediaReady = false;

  const $ = (sel) => document.querySelector(sel);

  // ── Media (camera / mic) ───────────────────────────────────────────

  function showMediaError(msg) {
    const el = $("#media-error-msg");
    if (el) {
      el.textContent = msg;
      el.classList.remove("hidden");
    }
  }

  function hideMediaError() {
    $("#media-error-msg")?.classList.add("hidden");
  }

  function applyMediaToPreview() {
    const preview = $("#lobby-preview");
    if (preview && localStream) {
      preview.srcObject = localStream;
      preview.play().catch(() => {});
    }
    $("#media-permission-prompt")?.classList.add("hidden");
    $("#lobby-media-controls")?.classList.remove("hidden");
    $("#join-meeting-btn")?.removeAttribute("disabled");
  }

  async function requestMedia() {
    hideMediaError();

    if (!navigator.mediaDevices?.getUserMedia) {
      showMediaError("이 브라우저는 카메라/마이크를 지원하지 않습니다.");
      return false;
    }

    if (!window.isSecureContext) {
      showMediaError(
        "카메라/마이크는 HTTPS에서만 사용할 수 있습니다. https:// 로 접속해 주세요."
      );
    }

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }

    const constraints = {
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        facingMode: "user",
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 24000 },
      },
    };

    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn("Full media failed:", err.name, err.message);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (err2) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          lobbyVideoEnabled = false;
          videoEnabled = false;
          $("#toggle-lobby-video")?.classList.add("off");
        } catch (err3) {
          const msg =
            err.name === "NotAllowedError"
              ? "카메라/마이크 권한이 거부되었습니다. 브라우저 주소창의 🔒 아이콘에서 허용해 주세요."
              : err.name === "NotFoundError"
              ? "카메라 또는 마이크를 찾을 수 없습니다."
              : `미디어 접근 실패: ${err.message}`;
          showMediaError(msg);
          return false;
        }
      }
    }

    mediaReady = true;
    lobbyVideoEnabled = localStream.getVideoTracks().some((t) => t.enabled);
    lobbyAudioEnabled = localStream.getAudioTracks().some((t) => t.enabled);
    audioEnabled = lobbyAudioEnabled;
    videoEnabled = lobbyVideoEnabled;

    applyMediaToPreview();
    return true;
  }

  // ── Lobby ──────────────────────────────────────────────────────────

  async function initLobby() {
    $("#participant-name").value = `참가자-${Math.random().toString(36).slice(2, 8)}`;

    $("#enable-media-btn")?.addEventListener("click", () => requestMedia());

    $("#toggle-lobby-video").addEventListener("click", async () => {
      if (!localStream) {
        await requestMedia();
        return;
      }
      lobbyVideoEnabled = !lobbyVideoEnabled;
      videoEnabled = lobbyVideoEnabled;
      localStream.getVideoTracks().forEach((t) => (t.enabled = lobbyVideoEnabled));
      $("#toggle-lobby-video").classList.toggle("off", !lobbyVideoEnabled);
    });

    $("#toggle-lobby-audio").addEventListener("click", async () => {
      if (!localStream) {
        await requestMedia();
        return;
      }
      lobbyAudioEnabled = !lobbyAudioEnabled;
      audioEnabled = lobbyAudioEnabled;
      localStream.getAudioTracks().forEach((t) => (t.enabled = lobbyAudioEnabled));
      $("#toggle-lobby-audio").classList.toggle("off", !lobbyAudioEnabled);
    });

    $("#join-meeting-btn").addEventListener("click", joinMeeting);

    $("#copy-link-btn")?.addEventListener("click", () => {
      navigator.clipboard.writeText(window.location.href);
      $("#copy-link-btn").textContent = "완료!";
      setTimeout(() => { $("#copy-link-btn").textContent = "복사"; }, 2000);
    });

    $("#copy-code-btn")?.addEventListener("click", () => {
      const code = config.joinCodeDisplay || config.joinCode;
      navigator.clipboard.writeText(code);
      $("#copy-code-btn").textContent = "완료!";
      setTimeout(() => { $("#copy-code-btn").textContent = "복사"; }, 2000);
    });
  }

  function setupMeetingCodeCopy() {
    $("#copy-meeting-code-btn")?.addEventListener("click", () => {
      const code = config.joinCodeDisplay || config.joinCode;
      navigator.clipboard.writeText(code);
      const btn = $("#copy-meeting-code-btn");
      if (btn) {
        btn.textContent = "완료!";
        setTimeout(() => { btn.textContent = "복사"; }, 2000);
      }
    });
  }

  // ── Join ───────────────────────────────────────────────────────────

  async function joinMeeting() {
    if (!localStream) {
      const ok = await requestMedia();
      if (!ok) return;
    }

    myName = $("#participant-name").value.trim() || "익명";
    audioEnabled = lobbyAudioEnabled;
    videoEnabled = lobbyVideoEnabled;

    $("#lobby").classList.add("hidden");
    $("#meeting-room").classList.remove("hidden");

    connectWebSocket();
    setupControls();
    setupMeetingCodeCopy();
    startMeetingTimer();
  }

  function connectWebSocket() {
    ws = new WebSocket(config.wsUrl);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", name: myName }));
    ws.onmessage = (e) => handleSignaling(JSON.parse(e.data));
    ws.onclose = () => $("#connection-status").classList.remove("online");
    ws.onerror = (err) => console.error("WS error:", err);
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // ── Signaling ──────────────────────────────────────────────────────

  async function handleSignaling(data) {
    switch (data.type) {
      case "welcome":
        myId = data.participantId;
        participants.set(myId, { name: myName, audio: audioEnabled, video: videoEnabled });
        addLocalVideoTile();

        for (const p of data.participants || []) {
          participants.set(p.participantId, { name: p.participantName, audio: true, video: true });
          await maybeConnect(p.participantId, p.participantName);
        }
        updateParticipantList();
        updateVideoGridLayout();

        if (data.legalCountries) {
          legalCountries = data.legalCountries;
          legalEnabled = !!data.legalEnabled;
          initLegalUI();
          if (!legalEnabled) {
            appendLegalSystemMessage("OpenAI API 키가 없어 법률 AI를 사용할 수 없습니다.");
          }
        }

        if (data.activeRecordingSessionId) {
          sharedRecordingSessionId = data.activeRecordingSessionId;
        }
        initMeetingRecording();

        sttEnabled = !!data.sttEnabled;
        if (sttEnabled) {
          startSTT();
        } else {
          setSttStatus("off", "음성 인식 비활성 (API 키 없음)");
        }
        initRiskWaveform();
        break;

      case "recording-session-active":
        if (data.sessionId && data.fromId !== myId) {
          sharedRecordingSessionId = data.sessionId;
          if (!recordingSessionId) {
            initMeetingRecording();
          }
        }
        break;

      case "stt-ready":
        sttReady = true;
        setSttStatus("ready", "실시간 음성 인식 중");
        break;

      case "stt-error":
        setSttStatus("off", `STT 오류: ${data.message || "unknown"}`);
        console.warn("STT error:", data.message);
        break;

      case "transcript-delta":
        handleTranscriptDelta(data);
        break;

      case "transcript-completed":
        handleTranscriptCompleted(data);
        break;

      case "risk-detected":
        handleRiskDetected(data);
        break;

      case "legal-alternatives-typing":
        setAlternativesLoading(!!data.active);
        break;

      case "legal-alternatives-response":
        handleLegalAlternativesResponse(data);
        break;

      case "participant-joined":
        if (data.participantId === myId) return;
        if (!participants.has(data.participantId)) {
          participants.set(data.participantId, {
            name: data.participantName,
            audio: true,
            video: true,
          });
          updateParticipantList();
          await maybeConnect(data.participantId, data.participantName);
        }
        break;

      case "participant-left":
        removePeer(data.participantId);
        participants.delete(data.participantId);
        updateParticipantList();
        break;

      case "offer":
        if (data.fromId === myId) return;
        if (data.targetId && data.targetId !== myId) return;
        await handleOffer(data);
        break;

      case "answer":
        if (data.fromId === myId) return;
        if (data.targetId && data.targetId !== myId) return;
        await handleAnswer(data);
        break;

      case "ice-candidate":
        if (data.fromId === myId) return;
        if (data.targetId && data.targetId !== myId) return;
        await handleIceCandidate(data);
        break;

      case "media-state":
        if (data.fromId === myId) return;
        updateRemoteMediaState(data.fromId, data.audio, data.video);
        break;

      case "legal-typing":
        setLegalTyping(!!data.active);
        break;

      case "legal-response":
        legalBusy = false;
        setLegalTyping(false);
        appendLegalMessage("assistant", data.message, data.references);
        legalHistory.push({ role: "assistant", content: data.message });
        break;

      case "legal-alert":
        handleLegalAlert(data);
        break;

      case "chat":
        appendChatMessage(data.fromName, data.message, data.fromId === myId);
        break;
    }
  }

  /** Lower UUID initiates — prevents offer/answer glare */
  function shouldInitiate(peerId) {
    return myId && peerId && myId < peerId;
  }

  async function maybeConnect(peerId, peerName) {
    if (!myId || peerId === myId || peers.has(peerId)) return;
    await createPeerConnection(peerId, peerName, shouldInitiate(peerId));
  }

  // ── WebRTC ─────────────────────────────────────────────────────────

  function getStreamForPeer() {
    return screenStream || localStream;
  }

  async function createPeerConnection(peerId, peerName, isInitiator) {
    if (peers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceCandidatePoolSize: 10,
    });

    peers.set(peerId, { pc, name: peerName });

    const stream = getStreamForPeer();
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: "ice-candidate", targetId: peerId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      remoteStreams.set(peerId, stream);
      attachStreamToTile(peerId, peerName, stream);
      meetingRecorder?.onRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed") {
        pc.restartIce?.();
      } else if (state === "closed") {
        removePeer(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        pc.restartIce?.();
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "offer", targetId: peerId, sdp: offer });
    }
  }

  async function handleOffer(data) {
    const peerId = data.fromId;
    const peerName = data.fromName || "참가자";

    if (!peers.has(peerId)) {
      await createPeerConnection(peerId, peerName, false);
    }

    const peer = peers.get(peerId);
    if (!peer) return;

    const pc = peer.pc;
    if (pc.signalingState === "have-local-offer") {
      if (shouldInitiate(peerId)) return;
      await pc.setLocalDescription({ type: "rollback" });
    }

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushPendingCandidates(peerId);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "answer", targetId: peerId, sdp: answer });
  }

  async function handleAnswer(data) {
    const peer = peers.get(data.fromId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushPendingCandidates(data.fromId);
  }

  async function handleIceCandidate(data) {
    const peer = peers.get(data.fromId);
    if (!peer?.pc.remoteDescription) {
      if (!pendingCandidates.has(data.fromId)) pendingCandidates.set(data.fromId, []);
      pendingCandidates.get(data.fromId).push(data.candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.warn("ICE error:", err);
    }
  }

  async function flushPendingCandidates(peerId) {
    const list = pendingCandidates.get(peerId) || [];
    const peer = peers.get(peerId);
    if (!peer) return;
    for (const c of list) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.warn("Pending ICE:", err);
      }
    }
    pendingCandidates.delete(peerId);
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      peer.pc.close();
      peers.delete(peerId);
    }
    remoteStreams.delete(peerId);
    document.getElementById(`tile-${peerId}`)?.remove();
    updateVideoGridLayout();
  }

  async function renegotiateAllPeers() {
    for (const [peerId, peer] of peers) {
      const stream = getStreamForPeer();
      if (!stream) continue;

      const senders = peer.pc.getSenders();
      for (const track of stream.getTracks()) {
        const sender = senders.find((s) => s.track?.kind === track.kind);
        if (sender) await sender.replaceTrack(track);
        else peer.pc.addTrack(track, stream);
      }

      if (shouldInitiate(peerId)) {
        try {
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          send({ type: "offer", targetId: peerId, sdp: offer });
        } catch (err) {
          console.warn("Renegotiation failed:", err);
        }
      }
    }
  }

  // ── Video tiles ────────────────────────────────────────────────────

  function getInitials(name) {
    return (name || "?").slice(0, 2).toUpperCase();
  }

  function addLocalVideoTile() {
    addVideoTile(myId, myName, localStream, true);
    updateTileMediaState(myId, audioEnabled, videoEnabled);
  }

  function addVideoTile(id, name, stream, isLocal = false) {
    if (document.getElementById(`tile-${id}`)) return;

    const tile = document.createElement("div");
    tile.id = `tile-${id}`;
    tile.className = `zm-tile${isLocal ? " local" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "zm-avatar";
    avatar.id = `avatar-${id}`;
    avatar.textContent = getInitials(name);

    const video = document.createElement("video");
    video.id = `video-${id}`;
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true;
    if (stream) video.srcObject = stream;

    const footer = document.createElement("div");
    footer.className = "zm-tile-footer";
    footer.innerHTML = `
      <span class="zm-tile-name">${escapeHtml(name)}${isLocal ? " (나)" : ""}</span>
      <span class="zm-tile-icons" id="icons-${id}"></span>
    `;

    tile.appendChild(avatar);
    tile.appendChild(video);
    tile.appendChild(footer);
    $("#video-grid").appendChild(tile);

    if (stream) updateTileVideoVisibility(id, stream.getVideoTracks()[0]?.enabled !== false);
    updateVideoGridLayout();
  }

  function attachStreamToTile(peerId, peerName, stream) {
    let tile = document.getElementById(`tile-${peerId}`);
    if (!tile) addVideoTile(peerId, peerName, stream, false);
    else {
      const video = document.getElementById(`video-${peerId}`);
      if (video) video.srcObject = stream;
    }
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      vt.onmute = () => updateTileVideoVisibility(peerId, false);
      vt.onunmute = () => updateTileVideoVisibility(peerId, true);
      updateTileVideoVisibility(peerId, vt.enabled && !vt.muted);
    }
  }

  function updateTileVideoVisibility(id, hasVideo) {
    const tile = document.getElementById(`tile-${id}`);
    if (tile) tile.classList.toggle("no-video", !hasVideo);
  }

  function updateTileMediaState(id, audio, video) {
    updateTileVideoVisibility(id, video);
    const icons = document.getElementById(`icons-${id}`);
    if (!icons) return;
    icons.innerHTML = "";
    if (!audio) icons.innerHTML += `<span class="zm-muted-icon" title="음소거">&#128263;</span>`;
  }

  function updateVideoGridLayout() {
    const grid = $("#video-grid");
    const count = grid.children.length;
    grid.className = "zm-video-grid";
    if (count <= 1) grid.classList.add("grid-1");
    else if (count === 2) grid.classList.add("grid-2");
    else if (count <= 4) grid.classList.add("grid-4");
    else if (count <= 9) grid.classList.add("grid-9");
    else grid.classList.add("grid-many");
    $("#participant-count").textContent = String(participants.size);
  }

  function updateRemoteMediaState(peerId, audio, video) {
    const p = participants.get(peerId);
    if (p) {
      p.audio = audio;
      p.video = video;
    }
    updateTileMediaState(peerId, audio, video);
    updateParticipantList();
  }

  function updateParticipantList() {
    const list = $("#participants-list");
    list.innerHTML = "";
    participants.forEach((p, id) => {
      const li = document.createElement("li");
      li.className = id === myId ? "self" : "";
      const avatar = document.createElement("span");
      avatar.className = "zm-p-avatar";
      avatar.textContent = getInitials(p.name);
      const info = document.createElement("span");
      info.className = "zm-p-info";
      info.textContent = `${p.name}${id === myId ? " (나)" : ""}`;
      const status = document.createElement("span");
      status.className = "zm-p-status";
      if (!p.audio) status.textContent = "음소거";
      else if (!p.video) status.textContent = "비디오 끔";
      li.appendChild(avatar);
      li.appendChild(info);
      li.appendChild(status);
      list.appendChild(li);
    });
    $("#participant-count").textContent = String(participants.size);
  }

  // ── Controls ───────────────────────────────────────────────────────

  /** Mac/IME: Enter로 조합 확정 시 전송이 중복되지 않도록 처리 */
  function bindEnterToSend(input, onSend) {
    if (!input || input.dataset.enterBound) return;
    input.dataset.enterBound = "1";

    let composing = false;
    let blockEnterUntil = 0;

    input.addEventListener("compositionstart", () => {
      composing = true;
    });

    input.addEventListener("compositionend", () => {
      composing = false;
      blockEnterUntil = Date.now() + 80;
    });

    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (Date.now() < blockEnterUntil) return;
      e.preventDefault();
      onSend();
    });
  }

  function setupControls() {
    $("#toggle-audio").addEventListener("click", toggleAudio);
    $("#toggle-video").addEventListener("click", toggleVideo);
    $("#toggle-screen").addEventListener("click", toggleScreenShare);
    $("#toggle-risk").addEventListener("click", () => openDrawer("risk"));
    $("#toggle-legal").addEventListener("click", () => openDrawer("legal"));
    $("#toggle-chat").addEventListener("click", () => openDrawer("chat"));
    $("#toggle-sidebar").addEventListener("click", () => openDrawer("participants"));
    $("#close-drawer").addEventListener("click", closeDrawer);
    $("#leave-meeting").addEventListener("click", leaveMeeting);

    initDrawerResize();
    applyDrawerWidth();

    document.querySelectorAll(".zm-tab").forEach((tab) => {
      tab.addEventListener("click", () => openDrawer(tab.dataset.tab));
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawerOpen) closeDrawer();
    });

    $("#send-chat-btn").addEventListener("click", sendChat);
    bindEnterToSend($("#chat-input"), sendChat);

    $("#legal-send-btn")?.addEventListener("click", sendLegalQuery);
    bindEnterToSend($("#legal-input"), sendLegalQuery);
    $("#legal-quick-check")?.addEventListener("click", runLegalQuickCheck);
    $("#risk-alternatives-btn")?.addEventListener("click", requestLegalAlternatives);

    window.addEventListener("pagehide", () => {
      if (!leavingIntentionally) {
        meetingRecorder?.stop();
      }
    });
  }

  function applyDrawerWidth() {
    const drawer = $("#drawer");
    if (drawer && drawerOpen) {
      drawer.style.width = `${drawerWidth}px`;
    }
  }

  function initDrawerResize() {
    const resizer = $("#drawer-resizer");
    const drawer = $("#drawer");
    if (!resizer || !drawer) return;

    resizer.addEventListener("pointerdown", (e) => {
      if (!drawerOpen || e.button !== 0) return;
      e.preventDefault();

      drawer.classList.remove("is-animating");
      resizer.setPointerCapture(e.pointerId);
      document.body.classList.add("drawer-resizing");

      const startX = e.clientX;
      const startW = drawerWidth;
      let pendingW = startW;
      let rafId = null;

      const applyWidth = () => {
        rafId = null;
        drawer.style.width = `${pendingW}px`;
      };

      const onMove = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const maxW = Math.floor(window.innerWidth * DRAWER_MAX_RATIO);
        const delta = startX - ev.clientX;
        pendingW = drawerWidth = Math.min(
          Math.max(startW + delta, DRAWER_MIN),
          maxW
        );
        if (!rafId) rafId = requestAnimationFrame(applyWidth);
      };

      const onEnd = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        resizer.releasePointerCapture(ev.pointerId);
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onEnd);
        resizer.removeEventListener("pointercancel", onEnd);
        document.body.classList.remove("drawer-resizing");
        if (rafId) cancelAnimationFrame(rafId);
        drawer.style.width = `${drawerWidth}px`;
        localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth));
      };

      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onEnd);
      resizer.addEventListener("pointercancel", onEnd);
    });
  }

  function openDrawer(tab) {
    activeDrawerTab = tab;
    drawerOpen = true;

    const drawer = $("#drawer");
    const main = $("#zm-main");
    const resizer = $("#drawer-resizer");

    drawer?.classList.add("open");
    main?.classList.add("drawer-open");
    resizer?.setAttribute("aria-hidden", "false");
    drawer?.setAttribute("aria-hidden", "false");

    if (drawer) {
      drawer.classList.add("is-animating");
      drawer.style.width = "0px";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          drawer.style.width = `${drawerWidth}px`;
        });
      });
      const onEnd = (ev) => {
        if (ev.propertyName !== "width") return;
        drawer.classList.remove("is-animating");
        drawer.removeEventListener("transitionend", onEnd);
      };
      drawer.addEventListener("transitionend", onEnd);
    }

    document.querySelectorAll(".zm-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === tab)
    );
    document.querySelectorAll(".zm-tab-panel").forEach((p) => p.classList.remove("active"));
    $(`#tab-${tab}`)?.classList.add("active");

    const title = $("#drawer-title");
    if (title) title.textContent = DRAWER_TITLES[tab] || tab;

    updateDrawerToolbarState();

    if (tab === "chat") {
      setTimeout(() => $("#chat-input")?.focus(), 280);
    } else if (tab === "legal") {
      setTimeout(() => $("#legal-input")?.focus(), 280);
    }
  }

  function closeDrawer() {
    drawerOpen = false;
    const drawer = $("#drawer");
    const main = $("#zm-main");
    const resizer = $("#drawer-resizer");

    if (drawer) {
      drawer.classList.add("is-animating");
      drawer.style.width = "0px";
      const finish = (ev) => {
        if (ev.propertyName !== "width") return;
        drawer.classList.remove("open", "is-animating");
        drawer.style.width = "";
        drawer.removeEventListener("transitionend", finish);
      };
      drawer.addEventListener("transitionend", finish);
    } else {
      $("#drawer")?.classList.remove("open");
    }

    main?.classList.remove("drawer-open");
    resizer?.setAttribute("aria-hidden", "true");
    drawer?.setAttribute("aria-hidden", "true");
    updateDrawerToolbarState();
  }

  function updateDrawerToolbarState() {
    const map = {
      participants: "#toggle-sidebar",
      chat: "#toggle-chat",
      legal: "#toggle-legal",
      risk: "#toggle-risk",
    };
    Object.entries(map).forEach(([tab, sel]) => {
      const btn = $(sel);
      if (!btn) return;
      btn.classList.toggle("drawer-open", drawerOpen && activeDrawerTab === tab);
    });
  }

  function toggleAudio() {
    audioEnabled = !audioEnabled;
    localStream?.getAudioTracks().forEach((t) => (t.enabled = audioEnabled));
    const btn = $("#toggle-audio");
    btn.classList.toggle("off", !audioEnabled);
    btn.querySelector(".zm-tool-label").textContent = audioEnabled ? "음소거" : "음소거 해제";
    const p = participants.get(myId);
    if (p) p.audio = audioEnabled;
    updateTileMediaState(myId, audioEnabled, videoEnabled);
    updateParticipantList();
    send({ type: "media-state", audio: audioEnabled, video: videoEnabled });
    if (audioEnabled && sttEnabled && !sttAudioCtx) startSTT();
    else if (!audioEnabled) stopSTT(false);
  }

  function toggleVideo() {
    videoEnabled = !videoEnabled;
    localStream?.getVideoTracks().forEach((t) => (t.enabled = videoEnabled));
    const btn = $("#toggle-video");
    btn.classList.toggle("off", !videoEnabled);
    btn.querySelector(".zm-tool-label").textContent = videoEnabled ? "비디오" : "비디오 켜기";
    const p = participants.get(myId);
    if (p) p.video = videoEnabled;
    updateTileVideoVisibility(myId, videoEnabled);
    updateTileMediaState(myId, audioEnabled, videoEnabled);
    updateParticipantList();
    send({ type: "media-state", audio: audioEnabled, video: videoEnabled });
  }

  async function toggleScreenShare() {
    if (isSharingScreen) {
      stopScreenShare();
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: false,
      });
      isSharingScreen = true;
      $("#toggle-screen").classList.add("active");

      const localVideo = document.getElementById(`video-${myId}`);
      if (localVideo) {
        localVideo.srcObject = screenStream;
        updateTileVideoVisibility(myId, true);
      }

      $("#screen-share-banner").classList.remove("hidden");
      $("#screen-sharer-name").textContent = myName;
      screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
      await renegotiateAllPeers();
    } catch (err) {
      console.warn("Screen share cancelled:", err);
    }
  }

  function stopScreenShare() {
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;
    isSharingScreen = false;
    $("#toggle-screen").classList.remove("active");
    $("#screen-share-banner").classList.add("hidden");

    const localVideo = document.getElementById(`video-${myId}`);
    if (localVideo) localVideo.srcObject = localStream;
    updateTileVideoVisibility(myId, videoEnabled);
    renegotiateAllPeers();
  }

  function sendChat() {
    const input = $("#chat-input");
    const message = input.value.trim();
    if (!message) return;
    const elapsedSec = meetingStartTime
      ? Math.floor((Date.now() - meetingStartTime) / 1000)
      : 0;
    send({
      type: "chat",
      message,
      recordingSessionId: recordingSessionId || undefined,
    });
    appendChatMessage(myName, message, true);
    if (!config.firebaseAdminEnabled) {
      meetingRecorder?.saveChatClient(message, myId, myName, elapsedSec);
    }
    input.value = "";
  }

  function showRecordingSaving(active) {
    const el = $("#recording-saving-overlay");
    if (el) el.classList.toggle("hidden", !active);
  }

  async function initMeetingRecording() {
    if (recordingInitStarted && recordingSessionId) return;
    recordingInitStarted = true;

    const firebaseConfig = config.firebase;
    if (!firebaseConfig || !window.MeetingRecorderFactory) {
      recordingInitStarted = false;
      if (!window.MeetingRecorderFactory) {
        window.addEventListener(
          "meeting-recorder-ready",
          () => initMeetingRecording(),
          { once: true }
        );
      }
      return;
    }

    try {
      if (!meetingRecorder) {
        meetingRecorder = window.MeetingRecorderFactory({
          firebaseConfig,
          roomId: config.roomId,
          roomName: config.roomName,
          participantId: myId,
          participantName: myName,
          getLocalStream: () => screenStream || localStream,
          getRemoteStreams: () => remoteStreams,
          getParticipantIds: () => [myId, ...remoteStreams.keys()],
          onStatusChange: ({ text, level, recording: isRec }) => {
            const badge = $("#recording-badge");
            if (badge) {
              badge.classList.toggle("hidden", level !== "recording" && !isRec);
              badge.title = text || "회의 녹화 중";
            }
          },
        });
      }

      const existingSession = sharedRecordingSessionId;
      recordingSessionId = existingSession
        ? await meetingRecorder.joinSession(existingSession)
        : await meetingRecorder.start();

      if (recordingSessionId) {
        send({
          type: "recording-session",
          sessionId: recordingSessionId,
          broadcast: !existingSession,
        });
      } else {
        recordingInitStarted = false;
        setTimeout(() => initMeetingRecording(), 3000);
      }
    } catch (err) {
      recordingInitStarted = false;
      console.warn("Meeting recording unavailable:", err);
      setTimeout(() => initMeetingRecording(), 5000);
    }
  }

  async function finalizeRecording() {
    if (!meetingRecorder) return;
    showRecordingSaving(true);
    try {
      await meetingRecorder.stop();
    } catch (err) {
      console.warn("Recording stop failed:", err);
    } finally {
      showRecordingSaving(false);
    }
  }

  async function leaveMeeting() {
    leavingIntentionally = true;
    clearInterval(timerInterval);
    stopSTT();
    await finalizeRecording();
    peers.forEach((_, id) => removePeer(id));
    localStream?.getTracks().forEach((t) => t.stop());
    screenStream?.getTracks().forEach((t) => t.stop());
    ws?.close();
    window.location.href = "/";
  }

  function startMeetingTimer() {
    meetingStartTime = Date.now();
    timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - meetingStartTime) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      $("#meeting-timer").textContent = `${m}:${s}`;
    }, 1000);
  }

  // ── Legal AI advisor ───────────────────────────────────────────────

  function initLegalUI() {
    const mySelect = $("#legal-my-country");
    const contextEl = $("#legal-context");
    if (!mySelect) return;

    mySelect.innerHTML = "";
    legalCountries.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.code;
      opt.textContent = c.label;
      if (c.code === myCountry) opt.selected = true;
      mySelect.appendChild(opt);
    });

    partnerCountries = partnerCountries.filter((c) => c !== myCountry).slice(0, 8);
    renderPartnerCountryCheckboxes();

    if (contextEl) contextEl.value = meetingContext;

    if (!legalUiInitialized) {
      legalUiInitialized = true;
      mySelect.addEventListener("change", () => {
        myCountry = mySelect.value;
        localStorage.setItem("lionmeet_my_country", myCountry);
        partnerCountries = partnerCountries.filter((c) => c !== myCountry);
        localStorage.setItem("lionmeet_partner_countries", JSON.stringify(partnerCountries));
        renderPartnerCountryCheckboxes();
        syncLegalSettings();
      });

      contextEl?.addEventListener("input", () => {
        meetingContext = contextEl.value.slice(0, 1000);
        localStorage.setItem("lionmeet_meeting_context", meetingContext);
        syncLegalSettings();
      });

      appendLegalSystemMessage("국가를 선택하고 질문하거나 리스크 점검을 눌러 주세요.");
    }

    syncLegalSettings();
  }

  function renderPartnerCountryCheckboxes() {
    const container = $("#legal-partner-countries");
    if (!container) return;

    container.innerHTML = "";
    legalCountries.forEach((c) => {
      if (c.code === myCountry) return;

      const label = document.createElement("label");
      label.className = "zm-country-chip";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.code;
      cb.checked = partnerCountries.includes(c.code);
      cb.disabled = !cb.checked && partnerCountries.length >= 8;

      cb.addEventListener("change", () => {
        partnerCountries = [...container.querySelectorAll("input:checked")].map((i) => i.value);
        if (partnerCountries.length > 8) {
          cb.checked = false;
          partnerCountries = partnerCountries.slice(0, 8);
        }
        localStorage.setItem("lionmeet_partner_countries", JSON.stringify(partnerCountries));
        renderPartnerCountryCheckboxes();
        syncLegalSettings();
      });

      label.appendChild(cb);
      label.appendChild(document.createTextNode(c.label));
      container.appendChild(label);
    });
  }

  function getSelectedPartnerCountries() {
    return partnerCountries.filter((c) => c !== myCountry).slice(0, 8);
  }

  function syncLegalSettings() {
    send({
      type: "legal-settings",
      myCountry,
      partnerCountries: getSelectedPartnerCountries(),
      meetingContext,
    });
  }

  function getLegalPayload() {
    const contextEl = $("#legal-context");
    const ctx = (contextEl?.value || meetingContext || "").trim();
    return {
      myCountry: $("#legal-my-country")?.value || myCountry,
      partnerCountries: getSelectedPartnerCountries(),
      meetingContext: ctx,
      history: legalHistory,
    };
  }

  function sendLegalQuery() {
    if (!legalEnabled || legalBusy) return;
    const input = $("#legal-input");
    const message = input?.value.trim();
    if (!message) return;

    syncLegalSettings();
    appendLegalMessage("user", message);
    legalHistory.push({ role: "user", content: message });
    if (input) input.value = "";

    legalBusy = true;
    send({ type: "legal-query", message, ...getLegalPayload(), history: legalHistory.slice(0, -1) });
  }

  function runLegalQuickCheck() {
    if (!legalEnabled || legalBusy) return;
    syncLegalSettings();
    const partners = getSelectedPartnerCountries();
    const myLabel =
      legalCountries.find((c) => c.code === myCountry)?.label || myCountry;
    const partnerLabels = partners.length
      ? partners
          .map((p) => legalCountries.find((c) => c.code === p)?.label || p)
          .join(", ")
      : "미지정";

    const message =
      `다음 국제 미팅의 법률·세금·컴플라이언스 리스크를 점검해 주세요.\n` +
      `- 우리: ${myLabel}\n` +
      `- 상대 (${partners.length || 0}개국): ${partnerLabels}\n` +
      `계약, 세금, 데이터 규제, IP 관점에서 ▲/●/○ 위험도와 확인할 사항을 정리해 주세요.`;

    appendLegalMessage("user", "리스크 점검 요청");
    legalHistory.push({ role: "user", content: message });
    legalBusy = true;
    send({ type: "legal-query", message, ...getLegalPayload(), history: legalHistory.slice(0, -1) });
  }

  function setLegalTyping(active) {
    let el = document.getElementById("legal-typing");
    const chat = $("#legal-chat");
    if (!chat) return;

    if (active) {
      if (!el) {
        el = document.createElement("div");
        el.id = "legal-typing";
        el.className = "zm-legal-msg assistant typing";
        el.innerHTML = `<span class="zm-legal-avatar">AI</span><div class="zm-legal-bubble"><p>분석 중</p><span class="zm-typing-dots"><span></span><span></span><span></span></span></div>`;
        chat.appendChild(el);
      }
    } else {
      el?.remove();
    }
    chat.scrollTop = chat.scrollHeight;
  }

  function appendLegalSystemMessage(text) {
    const chat = $("#legal-chat");
    if (!chat) return;
    const el = document.createElement("div");
    el.className = "zm-legal-msg system";
    el.innerHTML = `<p>${escapeHtml(text)}</p>`;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function appendLegalMessage(role, text, references) {
    const chat = $("#legal-chat");
    if (!chat) return;
    document.getElementById("legal-typing")?.remove();

    const body = (text || "").trim() || "응답을 생성하지 못했습니다. 다시 시도해 주세요.";
    const refsHtml =
      references?.length && role === "assistant"
        ? `<div class="zm-legal-refs">📚 DB 참조 ${references.length}건: ${references
            .slice(0, 4)
            .map((r) => `<a href="${escapeHtml(r.url || "#")}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>`)
            .join(" · ")}</div>`
        : "";

    const el = document.createElement("div");
    el.className = `zm-legal-msg ${role}`;
    const isUser = role === "user";
    el.innerHTML = `
      <span class="zm-legal-avatar">${isUser ? escapeHtml(getInitials(myName)) : "AI"}</span>
      <div class="zm-legal-bubble">
        <div class="zm-legal-body">${formatLegalText(body)}</div>
        ${refsHtml}
        ${
          !isUser
            ? `<button type="button" class="zm-legal-share-btn">참가자에게 공유</button>`
            : ""
        }
      </div>`;

    if (!isUser) {
      el.querySelector(".zm-legal-share-btn")?.addEventListener("click", () =>
        shareLegalInsight(body, "medium")
      );
    }

    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function formatLegalText(text) {
    if (typeof window.renderMarkdown === "function") {
      return window.renderMarkdown(text || "");
    }
    return escapeHtml(text || "").replace(/\n/g, "<br>");
  }

  function shareLegalInsight(fullText, severity) {
    const summary = fullText.slice(0, 800);
    const title =
      severity === "high"
        ? "▲ 높은 위험 — 법률·세무 알림"
        : severity === "medium"
        ? "● 중간 위험 — 법률·세무 알림"
        : "법률·세무 알림";

    const countries = [myCountry, ...getSelectedPartnerCountries()];
    send({
      type: "legal-share",
      title,
      summary,
      severity: severity || "medium",
      countries,
    });

    appendLegalSystemMessage("참가자 전체에게 알림을 공유했습니다.");
  }

  function handleLegalAlert(data) {
    appendSharedLegalAlert(data);
    showLegalAlertBanner(data);
  }

  function appendSharedLegalAlert(data) {
    const chat = $("#legal-chat");
    if (!chat) return;
    const el = document.createElement("div");
    el.className = "zm-legal-msg alert";
    el.innerHTML = `
      <span class="zm-legal-avatar">!</span>
      <div class="zm-legal-bubble alert">
        <p class="zm-legal-alert-from"><strong>${escapeHtml(data.fromName || "참가자")}</strong> 공유</p>
        <div class="zm-legal-body">${formatLegalText((data.summary || "").slice(0, 400))}</div>
      </div>`;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function showLegalAlertBanner(data) {
    const stack = $("#legal-alert-stack");
    if (!stack) return;

    const banner = document.createElement("div");
    banner.className = `zm-legal-banner severity-${data.severity || "medium"}`;
    banner.innerHTML = `
      <div class="zm-legal-banner-head">
        <span class="zm-legal-banner-badge">법률·세무</span>
        <strong>${escapeHtml(data.fromName || "참가자")}</strong>
        <span>${escapeHtml(data.title || "")}</span>
        <button type="button" class="zm-legal-banner-close" aria-label="닫기">&times;</button>
      </div>
      <p>${escapeHtml((data.summary || "").slice(0, 200))}${(data.summary || "").length > 200 ? "…" : ""}</p>`;

    banner.querySelector(".zm-legal-banner-close")?.addEventListener("click", () => {
      banner.remove();
    });

    stack.appendChild(banner);
    setTimeout(() => banner.remove(), 12000);
  }

  // ── Realtime STT + Risk monitor ────────────────────────────────────

  function setSttStatus(mode, text) {
    const dot = $("#stt-status-dot");
    const label = $("#stt-status-text");
    if (dot) {
      dot.classList.remove("live", "ready");
      if (mode === "live") dot.classList.add("live");
      if (mode === "ready") dot.classList.add("ready");
    }
    if (label && text) label.textContent = text;
  }

  function formatElapsed(sec) {
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  async function startSTT() {
    if (!sttEnabled || !localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) {
      setSttStatus("off", "마이크 없음");
      return;
    }

    try {
      stopSTT(false);
      // Let the browser's native resampler produce the exact rate expected by
      // OpenAI. It is substantially cleaner than dropping samples in JavaScript.
      sttAudioCtx = new AudioContext({ sampleRate: 24000 });
      if (sttAudioCtx.state === "suspended") {
        await sttAudioCtx.resume();
      }
      await sttAudioCtx.audioWorklet.addModule(config.stt?.pcmProcessorUrl || "/static/js/pcm-processor.js");
      sttWorklet = new AudioWorkletNode(sttAudioCtx, "pcm-processor", {
        processorOptions: {
          boostGain: config.stt?.boostGain ?? 1.0,
        },
      });
      sttSource = sttAudioCtx.createMediaStreamSource(new MediaStream([track]));
      sttSource.connect(sttWorklet);

      sttWorklet.port.onmessage = (ev) => {
        const buf = ev.data?.audio;
        const level = ev.data?.level || 0;
        if (level) pushWaveformLevel(level);
        if (!sttReady || !audioEnabled || !buf) return;
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        send({ type: "stt-audio", audio: btoa(binary), level });
      };

      setSttStatus("live", "음성 인식 연결 중…");
    } catch (err) {
      console.error("STT init failed:", err);
      setSttStatus("off", "음성 인식 초기화 실패");
    }
  }

  function stopSTT(resetStatus = true) {
    sttReady = false;
    sttSource?.disconnect();
    sttWorklet?.disconnect();
    sttAudioCtx?.close().catch(() => {});
    sttSource = null;
    sttWorklet = null;
    sttAudioCtx = null;
    if (resetStatus) setSttStatus("off", "음성 인식 중지");
  }

  function pushWaveformLevel(level) {
    waveformLevels.push(Math.min(1, level * 12));
    while (waveformLevels.length > WAVEFORM_MAX) waveformLevels.shift();
    drawRiskWaveform();
  }

  function initRiskWaveform() {
    drawRiskWaveform();
  }

  function drawRiskWaveform() {
    const canvas = $("#risk-waveform");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const levels = waveformLevels.length ? waveformLevels : new Array(60).fill(0.05);
    const barW = w / levels.length;

    levels.forEach((lv, i) => {
      const barH = Math.max(2, lv * (h - 8));
      const x = i * barW;
      const y = (h - barH) / 2;
      let color = "rgba(45, 140, 255, 0.55)";
      if (lastRiskWindow) {
        const ratio = i / levels.length;
        const startR = lastRiskWindow.startRatio ?? 0.55;
        const endR = lastRiskWindow.endRatio ?? 0.85;
        if (ratio >= startR && ratio <= endR) color = "rgba(255, 71, 87, 0.95)";
      }
      ctx.fillStyle = color;
      ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1), barH);
    });
  }

  function isSttEcho(text) {
    const t = (text || "").trim();
    if (!t) return true;
    return ["화상회의 실시간", "정확히 전사합니다", "한국어 우선"].some((m) => t.includes(m));
  }

  function speechLineKey(fromId, itemId) {
    return `${fromId}:${itemId}`;
  }

  function handleTranscriptDelta(data) {
    const key = speechLineKey(data.fromId, data.itemId);
    const text = (sttPartial.get(key) || "") + (data.delta || "");
    sttPartial.set(key, text);
    updateSpeechLine(key, data.fromName, text, data.elapsedSec, false);
  }

  function handleTranscriptCompleted(data) {
    const key = speechLineKey(data.fromId, data.itemId);
    const text = (data.transcript || "").trim() || (sttPartial.get(key) || "").trim();
    sttPartial.delete(key);
    if (!text || isSttEcho(text)) {
      speechLines.get(key)?.remove();
      speechLines.delete(key);
      return;
    }
    updateSpeechLine(key, data.fromName, text, data.elapsedSec, true);
  }

  function updateSpeechLine(key, speaker, text, elapsedSec, finalized) {
    const feed = $("#speech-feed");
    if (!feed || !text) return;
    feed.querySelector(".zm-speech-empty")?.remove();

    let li = speechLines.get(key);
    if (!li) {
      li = document.createElement("li");
      li.className = "zm-speech-line partial";
      li.dataset.key = key;
      feed.appendChild(li);
      speechLines.set(key, li);
    }

    li.classList.toggle("partial", !finalized);
    li.classList.toggle("final", finalized);
    li.innerHTML = `
      <span class="time">${formatElapsed(elapsedSec ?? 0)}</span>
      <span class="speaker">${escapeHtml(speaker || "참가자")}:</span>
      ${finalized ? "" : '<span class="zm-speech-live-tag">인식 중</span>'}
      <span class="text">${escapeHtml(text)}</span>`;

    feed.scrollTop = feed.scrollHeight;

    if (finalized) {
      speechLines.delete(key);
    }
  }

  function appendSpeechFeed(speaker, text, elapsedSec) {
    updateSpeechLine(`final:${Date.now()}:${Math.random()}`, speaker, text, elapsedSec, true);
  }

  function handleRiskDetected(data) {
    const severity = data.severity || "medium";
    const score = Number(data.score) || 0;
    const box = $("#risk-alert-box");
    const sevLabel = $("#risk-severity-label");
    const category = $("#risk-category");
    const scoreEl = $("#risk-score");

    if (box) {
      box.classList.remove("idle", "high", "medium", "low");
      box.classList.add(severity === "none" ? "idle" : severity);
    }
    if (sevLabel) {
      sevLabel.textContent =
        severity === "high" ? "높음" : severity === "medium" ? "중간" : severity === "low" ? "낮음" : "—";
    }
    if (category) {
      category.textContent = [data.category, data.title].filter(Boolean).join(" · ") || data.summary || "";
    }
    if (scoreEl) scoreEl.textContent = String(Math.round(score));

    const start = data.windowStart ?? data.elapsedSec ?? 0;
    const end = data.windowEnd ?? start + 30;
    $("#risk-window-start") && ($("#risk-window-start").textContent = formatElapsed(start));
    $("#risk-window-end") && ($("#risk-window-end").textContent = formatElapsed(end));

    lastRiskWindow = { startRatio: 0.55, endRatio: 0.85 };
    drawRiskWaveform();

    const basisList = $("#risk-basis-list");
    if (basisList) {
      basisList.innerHTML = "";
      const items = [...(data.basis || []), ...(data.laws || []).map((l) => `관련 법령: ${l}`)];
      if (!items.length && data.summary) items.push(data.summary);
      items.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        basisList.appendChild(li);
      });
    }

    showLegalAlertBanner({
      fromName: data.fromName || "리스크 모니터",
      title: data.title || "법률 리스크 탐지",
      summary: data.summary || (data.basis || [])[0] || "",
      severity,
    });

    lastDetectedRisk = data;
    const altSection = $("#risk-alternatives-section");
    if (altSection) {
      altSection.classList.remove("hidden");
      $("#risk-alternatives-list") && ($("#risk-alternatives-list").innerHTML = "");
    }

    if (severity === "high") openDrawer("risk");
  }

  function setAlternativesLoading(active) {
    alternativesBusy = active;
    const btn = $("#risk-alternatives-btn");
    const loading = $("#risk-alternatives-loading");
    if (btn) btn.disabled = active;
    loading?.classList.toggle("hidden", !active);
  }

  function requestLegalAlternatives() {
    if (!legalEnabled || alternativesBusy || !lastDetectedRisk) return;
    syncLegalSettings();
    setAlternativesLoading(true);
    send({
      type: "legal-alternatives",
      risk: lastDetectedRisk,
      ...getLegalPayload(),
    });
  }

  function handleLegalAlternativesResponse(data) {
    setAlternativesLoading(false);
    const list = $("#risk-alternatives-list");
    if (!list) return;

    list.innerHTML = "";
    const summary = (data.summary || "").trim();
    if (summary) {
      const p = document.createElement("p");
      p.className = "zm-risk-alt-summary";
      p.textContent = summary;
      list.appendChild(p);
    }

    const alternatives = data.alternatives || [];
    if (!alternatives.length) {
      const empty = document.createElement("p");
      empty.className = "zm-risk-alt-empty";
      empty.textContent = summary ? "추가 대안을 생성하지 못했습니다." : "차선책을 생성하지 못했습니다.";
      list.appendChild(empty);
      return;
    }

    alternatives.forEach((alt, idx) => {
      const card = document.createElement("article");
      card.className = "zm-risk-alt-card";
      const jurisdictions = (alt.jurisdictions || [])
        .map((code) => legalCountries.find((c) => c.code === code)?.label || code)
        .join(", ");
      const cautions = (alt.cautions || []).map((c) => `<li>${escapeHtml(c)}</li>`).join("");
      card.innerHTML = `
        <h4>${escapeHtml(alt.title || `대안 ${idx + 1}`)}</h4>
        <p>${escapeHtml(alt.description || "")}</p>
        ${alt.whyCompliant ? `<p class="zm-risk-alt-why"><strong>합법 근거:</strong> ${escapeHtml(alt.whyCompliant)}</p>` : ""}
        ${jurisdictions ? `<p class="zm-risk-alt-juris"><strong>관련 관할:</strong> ${escapeHtml(jurisdictions)}</p>` : ""}
        ${cautions ? `<ul class="zm-risk-alt-cautions">${cautions}</ul>` : ""}
      `;
      list.appendChild(card);
    });

    const questions = data.questionsToConfirm || [];
    if (questions.length) {
      const qWrap = document.createElement("div");
      qWrap.className = "zm-risk-alt-questions";
      qWrap.innerHTML = `<strong>확인할 질문</strong><ul>${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
      list.appendChild(qWrap);
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────

  function formatChatTime(date = new Date()) {
    return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function appendChatMessage(sender, message, isSelf) {
    $("#chat-empty")?.classList.add("hidden");

    const div = document.createElement("div");
    div.className = `zm-chat-msg${isSelf ? " self" : ""}`;
    div.innerHTML = `
      <span class="zm-chat-avatar">${escapeHtml(getInitials(sender))}</span>
      <div class="zm-chat-bubble-wrap">
        <div class="zm-chat-meta">
          <span class="zm-chat-sender">${escapeHtml(isSelf ? "나" : sender)}</span>
          <span class="zm-chat-time">${formatChatTime()}</span>
        </div>
        <div class="zm-chat-body">${escapeHtml(message)}</div>
      </div>`;

    const container = $("#chat-messages");
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  initLobby();
})();
