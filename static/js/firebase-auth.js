import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";

function getCookie(name) {
  const v = `; ${document.cookie}`;
  const p = v.split(`; ${name}=`);
  if (p.length === 2) return p.pop().split(";").shift();
  return "";
}

function firebaseErrorMessage(code) {
  const map = {
    "auth/email-already-in-use": "이미 사용 중인 이메일입니다.",
    "auth/invalid-email": "올바른 이메일을 입력해 주세요.",
    "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
    "auth/user-not-found": "등록되지 않은 이메일입니다.",
    "auth/wrong-password": "비밀번호가 올바르지 않습니다.",
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않습니다.",
    "auth/too-many-requests": "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  };
  return map[code] || "인증에 실패했습니다. 다시 시도해 주세요.";
}

export function createFirebaseAuth(firebaseConfig) {
  const app = initializeApp(firebaseConfig);
  try {
    getAnalytics(app);
  } catch (_) {
    /* analytics may fail on localhost without measurement consent */
  }
  const auth = getAuth(app);

  let currentUser = null;
  let pendingAction = null;

  const els = {
    navAuth: document.getElementById("nav-auth"),
    authModal: document.getElementById("auth-modal"),
    authTitle: document.getElementById("auth-modal-title"),
    authError: document.getElementById("auth-error"),
    authEmail: document.getElementById("auth-email"),
    authPassword: document.getElementById("auth-password"),
    authName: document.getElementById("auth-name"),
    authNameRow: document.getElementById("auth-name-row"),
    authSubmit: document.getElementById("auth-submit-btn"),
    authSwitchText: document.getElementById("auth-switch-text"),
    authSwitchBtn: document.getElementById("auth-switch-btn"),
    closeAuth: document.getElementById("close-auth-btn"),
    openLogin: document.getElementById("open-login-btn"),
    openSignup: document.getElementById("open-signup-btn"),
    logoutBtn: document.getElementById("logout-btn"),
  };

  let authMode = "login";

  function setAuthError(msg) {
    if (!msg) {
      els.authError.classList.add("hidden");
      els.authError.textContent = "";
      return;
    }
    els.authError.textContent = msg;
    els.authError.classList.remove("hidden");
  }

  function renderNav() {
    if (!els.navAuth) return;
    if (currentUser) {
      const label = currentUser.displayName || currentUser.email || "사용자";
      els.navAuth.innerHTML = `
        <span class="home-user-label">${escapeHtml(label)}</span>
        <button type="button" id="logout-btn" class="zm-btn zm-btn-outline zm-btn-sm">로그아웃</button>
      `;
      document.getElementById("logout-btn")?.addEventListener("click", handleLogout);
      document.getElementById("recordings-link")?.classList.remove("hidden");
    } else {
      els.navAuth.innerHTML = `
        <button type="button" id="open-login-btn" class="zm-btn zm-btn-outline zm-btn-sm">로그인</button>
        <button type="button" id="open-signup-btn" class="zm-btn zm-btn-primary zm-btn-sm">회원가입</button>
      `;
      document.getElementById("open-login-btn")?.addEventListener("click", () => openAuthModal("login"));
      document.getElementById("open-signup-btn")?.addEventListener("click", () => openAuthModal("signup"));
      document.getElementById("recordings-link")?.classList.add("hidden");
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function openAuthModal(mode, action = null) {
    authMode = mode;
    pendingAction = action;
    setAuthError("");
    els.authEmail.value = "";
    els.authPassword.value = "";
    if (els.authName) els.authName.value = "";

    if (mode === "signup") {
      els.authTitle.textContent = "회원가입";
      els.authSubmit.textContent = "가입하기";
      els.authNameRow?.classList.remove("hidden");
      els.authSwitchText.textContent = "이미 계정이 있으신가요?";
      els.authSwitchBtn.textContent = "로그인";
    } else {
      els.authTitle.textContent = "로그인";
      els.authSubmit.textContent = "로그인";
      els.authNameRow?.classList.add("hidden");
      els.authSwitchText.textContent = "계정이 없으신가요?";
      els.authSwitchBtn.textContent = "회원가입";
    }

    els.authModal.classList.remove("hidden");
    els.authEmail.focus();
  }

  function closeAuthModal() {
    els.authModal.classList.add("hidden");
    pendingAction = null;
    setAuthError("");
  }

  async function syncSession(idToken) {
    const res = await fetch("/api/auth/session/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCookie("csrftoken"),
      },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "세션 생성에 실패했습니다.");
    }
    currentUser = data.user;
    renderNav();
    return data;
  }

  async function refreshMe() {
    const res = await fetch("/api/auth/me/");
    const data = await res.json();
    currentUser = data.authenticated ? data.user : null;
    renderNav();
    return data;
  }

  async function handleAuthSubmit() {
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    const name = els.authName?.value.trim() || "";

    if (!email || !password) {
      setAuthError("이메일과 비밀번호를 입력해 주세요.");
      return;
    }

    els.authSubmit.disabled = true;
    setAuthError("");

    try {
      let credential;
      if (authMode === "signup") {
        credential = await createUserWithEmailAndPassword(auth, email, password);
        if (name) {
          await updateProfile(credential.user, { displayName: name });
        }
      } else {
        credential = await signInWithEmailAndPassword(auth, email, password);
      }

      const idToken = await credential.user.getIdToken(true);
      await syncSession(idToken);

      closeAuthModal();
      if (pendingAction) {
        const action = pendingAction;
        pendingAction = null;
        action();
      }

      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      if (next && next.startsWith("/")) {
        window.location.href = next;
      }
    } catch (err) {
      setAuthError(firebaseErrorMessage(err.code));
    } finally {
      els.authSubmit.disabled = false;
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
    } catch (_) {
      /* ignore */
    }
    try {
      await fetch("/api/auth/logout/", {
        method: "POST",
        headers: { "X-CSRFToken": getCookie("csrftoken") },
      });
    } catch (_) {
      /* session cleared server-side is best-effort */
    }
    currentUser = null;
    renderNav();
    window.location.reload();
  }

  function requireAuth(action) {
    if (currentUser) {
      action();
      return;
    }
    openAuthModal("login", action);
  }

  els.authSubmit?.addEventListener("click", handleAuthSubmit);
  els.closeAuth?.addEventListener("click", closeAuthModal);
  els.authSwitchBtn?.addEventListener("click", () => {
    openAuthModal(authMode === "login" ? "signup" : "login", pendingAction);
  });

  els.authModal?.addEventListener("click", (e) => {
    if (e.target === els.authModal) closeAuthModal();
  });

  [els.authEmail, els.authPassword, els.authName].forEach((el) => {
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleAuthSubmit();
    });
  });

  return {
    refreshMe,
    requireAuth,
    openAuthModal,
    isAuthenticated: () => Boolean(currentUser),
    getUser: () => currentUser,
  };
}
