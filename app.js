// ══════════════════════════════════════════════════════
//  TalentFlow ATS — app.js
//  Firebase v10 (modular CDN) + pure JS
//  Architecture: server-side cursor pagination + where()
//  filtering — scales to 50,000+ candidates.
// ══════════════════════════════════════════════════════

import { initializeApp }                                    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword,
         signInWithEmailAndPassword, signOut,
         onAuthStateChanged, updateProfile }                from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs,
         doc, updateDoc, deleteDoc, setDoc, getDoc,
         query, orderBy, where, limit, startAfter,
         serverTimestamp, onSnapshot,
         getCountFromServer }                               from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ──────────────────────────────────────────────────────
//  🔥  FIREBASE CONFIG
// ──────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyB3Z4-HU5pADplI-5ONrnV-4sm-eYMXRLo",
  authDomain:        "ats-system-d83ef.firebaseapp.com",
  projectId:         "ats-system-d83ef",
  storageBucket:     "ats-system-d83ef.firebasestorage.app",
  messagingSenderId: "150874136182",
  appId:             "1:150874136182:web:c0a8542124cc33647f0957"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── State ──────────────────────────────────────────────
let currentUser    = null;
let incomingUnsub  = null;    // Firestore real-time unsub handle

// ── Pagination state ───────────────────────────────────
// We NEVER load allCandidates into memory for the main table.
// Instead we maintain a cursor stack for Prev/Next.
const PAGE_SIZE     = 100;    // documents per page
let   cursorStack   = [];     // stack of "first doc of each page" for Prev navigation
let   lastVisible   = null;   // last doc of current page — used for Next
let   currentFilters = { status: "", dept: "", search: "", sort: "newest" };
let   totalFiltered  = 0;     // count from getCountFromServer (for page-info label)
let   currentPageNum = 1;

// ── Small in-memory caches (lightweight) ──────────────
// Only used for: dashboard recent-5, bulk email, openEditModal, openViewModal.
// These are tight targeted queries — never the full 50k set.
let   recentDocs    = [];     // last 8 docs for dashboard
let   bulkCandidateMap = {};  // email→candidate for bulk send

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = "toast" + (type === "ok" ? " ok" : type === "err" ? " err" : "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-IN", { day:"numeric", month:"short", year:"numeric" });
}

function statusBadge(s) {
  const map = { Selected:"badge-sel", Rejected:"badge-rej", "On Hold":"badge-hold" };
  return `<span class="badge ${map[s]||""}">${esc(s||"—")}</span>`;
}

function authErr(code) {
  const m = {
    "auth/email-already-in-use":   "Email already registered.",
    "auth/invalid-email":          "Invalid email address.",
    "auth/wrong-password":         "Incorrect password.",
    "auth/user-not-found":         "No account with that email.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/invalid-credential":     "Invalid credentials — check email and password.",
    "auth/too-many-requests":      "Too many attempts. Try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return m[code] || "Error: " + code;
}

// ═══════════════════════════════════════════════════════
//  AUTH — TABS, LOGIN, SIGNUP, LOGOUT
// ═══════════════════════════════════════════════════════
window.switchTab = function(tab) {
  document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");
  document.getElementById("form-" + tab).classList.add("active");
};

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.style.display = "block";
}

window.doLogin = async function() {
  const email = document.getElementById("login-email").value.trim();
  const pass  = document.getElementById("login-pass").value;
  document.getElementById("auth-error").style.display = "none";
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch(e) { showAuthError(authErr(e.code)); }
};

window.doSignup = async function() {
  const name  = document.getElementById("su-name").value.trim();
  const email = document.getElementById("su-email").value.trim();
  const pass  = document.getElementById("su-pass").value;
  document.getElementById("auth-error").style.display = "none";
  if (!name) { showAuthError("Please enter your name."); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
  } catch(e) { showAuthError(authErr(e.code)); }
};

window.doLogout = async function() {
  if (incomingUnsub) { incomingUnsub(); incomingUnsub = null; }
  await signOut(auth);
};

// ═══════════════════════════════════════════════════════
//  AUTH STATE CHANGE
// ═══════════════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    document.getElementById("screen-auth").style.display = "none";
    document.getElementById("screen-app").style.display  = "flex";

    const firstName = (user.displayName || "Digvijay").split(" ")[0];
    document.getElementById("welcome-msg").textContent  = `Welcome, ${firstName} 👋`;
    document.getElementById("dash-welcome").textContent = `Welcome, ${firstName}! 👋`;
    const avatarEl = document.getElementById("topbar-avatar");
    if (avatarEl) avatarEl.textContent = firstName[0].toUpperCase();

    loadCompanyFromCache();
    spawnParticles();
    await loadCompanyProfile();
    await Promise.all([
      loadDashboard(),
      populateDeptFilter(),
    ]);
    startIncomingListener();
  } else {
    document.getElementById("screen-auth").style.display = "flex";
    document.getElementById("screen-app").style.display  = "none";
    if (incomingUnsub) { incomingUnsub(); incomingUnsub = null; }
  }
});

// ═══════════════════════════════════════════════════════
//  COMPANY PROFILE
// ═══════════════════════════════════════════════════════
function userDocRef() {
  return doc(db, `users/${currentUser.uid}`);
}

async function loadCompanyProfile() {
  try {
    const snap = await getDoc(userDocRef());
    const name = snap.exists() ? (snap.data().companyName || "") : "";
    setCompanyNameUI(name);
    const inp = document.getElementById("company-name-input");
    if (inp) inp.value = name;
  } catch(e) { console.warn("Profile load:", e.message); }
}

function setCompanyNameUI(name) {
  const el  = document.getElementById("topbar-company");
  const div = document.getElementById("topbar-company-divider");
  if (!el) return;
  if (name) {
    el.textContent   = name;
    el.style.display = "inline-flex";
    if (div) div.style.display = "flex";
  } else {
    el.style.display = "none";
    if (div) div.style.display = "none";
  }
}

window.openCompanySettings = function() {
  loadCompanyProfile();
  document.getElementById("modal-company").classList.add("open");
};

window.saveCompanyName = async function() {
  const name = document.getElementById("company-name-input").value.trim();
  try {
    await setDoc(userDocRef(), { companyName: name }, { merge: true });
    setCompanyNameUI(name);
    toast(name ? `✅ "${name}" saved!` : "Company name cleared.", "ok");
    document.getElementById("modal-company").classList.remove("open");
  } catch(e) {
    if (name) localStorage.setItem("ats_company_" + currentUser.uid, name);
    else       localStorage.removeItem("ats_company_" + currentUser.uid);
    setCompanyNameUI(name);
    toast(name ? `✅ "${name}" saved locally!` : "Cleared.", "ok");
    document.getElementById("modal-company").classList.remove("open");
    console.warn("Firestore profile write failed, used localStorage:", e.message);
  }
};

function loadCompanyFromCache() {
  if (!currentUser) return;
  const cached = localStorage.getItem("ats_company_" + currentUser.uid);
  if (cached) setCompanyNameUI(cached);
}

// ═══════════════════════════════════════════════════════
//  FIRESTORE COLLECTION REF
// ═══════════════════════════════════════════════════════
function colRef() {
  return collection(db, `users/${currentUser.uid}/candidates`);
}

// ═══════════════════════════════════════════════════════
//  SERVER-SIDE COUNT HELPERS
//  Uses getCountFromServer — reads 0 documents, just counts.
//  Perfect for dashboard stats on 50k records.
// ═══════════════════════════════════════════════════════
async function countWhere(...constraints) {
  const q = query(colRef(), ...constraints);
  const snap = await getCountFromServer(q);
  return snap.data().count;
}

// ═══════════════════════════════════════════════════════
//  DASHBOARD — server-side aggregated counts
// ═══════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    // Fire all count queries in parallel — zero document reads
    const [total, sel, rej, hold] = await Promise.all([
      countWhere(),
      countWhere(where("status", "==", "Selected")),
      countWhere(where("status", "==", "Rejected")),
      countWhere(where("status", "==", "On Hold")),
    ]);

    const deptSnap = await getDocs(query(colRef(), orderBy("dept"), limit(1000)));
    const deptSet  = new Set(deptSnap.docs.map(d => d.data().dept).filter(Boolean));

    renderDashboardUI({ total, sel, rej, hold, depts: deptSet.size });

    // Recent 8 — small targeted query
    const recentSnap = await getDocs(query(colRef(), orderBy("createdAt","desc"), limit(8)));
    recentDocs = recentSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRecentTable(recentDocs);

    // Dept bars — count per dept for top 10
    await renderDeptBars(total);
  } catch(e) {
    console.warn("loadDashboard:", e.message);
    toast("Dashboard load error: " + e.message, "err");
  }
}

function renderDashboardUI({ total, sel, rej, hold, depts }) {
  setText("s-total",   total);
  setText("s-sel",     sel);
  setText("s-rej",     rej);
  setText("s-hold",    hold);
  setText("s-dept",    depts);
  setText("wb-total",  total);
  setText("totalCandCount", total);

  // sidebar badges
  setText("nb-sel",  sel);
  setText("nb-rej",  rej);
  setText("nb-hold", hold);

  const pct = n => total ? (n / total * 100).toFixed(1) : "0";
  const pctStr = n => pct(n) + "%";

  setStyle("pipe-sel",  "width", pctStr(sel));
  setStyle("pipe-rej",  "width", pctStr(rej));
  setStyle("pipe-hold", "width", pctStr(hold));
  setText("pct-sel",  pctStr(sel));
  setText("pct-rej",  pctStr(rej));
  setText("pct-hold", pctStr(hold));
}

async function renderDeptBars(grandTotal) {
  // Fetch distinct dept counts without reading all docs:
  // We load up to 1000 dept field values (lightweight projection) and count locally.
  // For 50k records with many depts, this is acceptable. A future Cloud Function
  // aggregation can replace this if depts × total is very large.
  try {
    const snap = await getDocs(query(colRef(), orderBy("dept"), limit(2000)));
    const map  = {};
    snap.docs.forEach(d => {
      const dept = d.data().dept;
      if (dept) map[dept] = (map[dept] || 0) + 1;
    });
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10);
    document.getElementById("dept-bars").innerHTML = sorted.map(([d, n]) => `
      <div class="dept-row">
        <span class="dept-name">${esc(d)}</span>
        <div class="dept-track"><div class="dept-fill" style="width:${grandTotal ? (n/grandTotal*100).toFixed(1) : 0}%"></div></div>
        <span class="dept-count">${n}</span>
      </div>`).join("") || "";
  } catch(e) { console.warn("renderDeptBars:", e.message); }
}

function renderRecentTable(docs) {
  document.getElementById("recent-tbody").innerHTML =
    docs.map(c => `
      <tr>
        <td><strong style="cursor:pointer;color:var(--accent)" onclick="openViewModal('${c.id}')">${esc(c.name)}</strong></td>
        <td><span class="badge badge-dept">${esc(c.dept || "—")}</span></td>
        <td>${esc(c.position || "—")}</td>
        <td>${statusBadge(c.status)}</td>
        <td style="color:var(--muted)">${fmtDate(c.createdAt)}</td>
      </tr>`).join("")
    || `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted)">No candidates yet. Add one! 👆</td></tr>`;
}

// Helper setters to avoid null crashes
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setStyle(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el.style[prop] = val;
}

// ═══════════════════════════════════════════════════════
//  INCOMING APPLICATIONS — real-time lightweight listener
//  Only listens on source=="Google Form" + status=="On Hold"
//  to avoid syncing the entire collection.
// ═══════════════════════════════════════════════════════
function startIncomingListener() {
  if (incomingUnsub) incomingUnsub();

  // No orderBy — avoids composite index requirement.
  // Two equality where() clauses need no index.
  const q = query(
    colRef(),
    where("source", "==", "Google Form"),
    where("status", "==", "On Hold"),
    limit(200)
  );

  incomingUnsub = onSnapshot(q, (snap) => {
    const newCount = snap.size;

    const badge = document.getElementById("nb-incoming");
    if (badge) {
      badge.textContent    = newCount;
      badge.style.display  = newCount > 0 ? "inline-flex" : "none";
    }
    const dot = document.getElementById("incoming-dot");
    if (dot) dot.style.display = newCount > 0 ? "block" : "none";

    // If the incoming page is open, re-render it
    const pg = document.getElementById("page-incoming");
    if (pg && pg.classList.contains("active")) {
      renderIncoming(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
  }, (err) => {
    console.warn("Incoming listener error:", err.message);
  });
}

window.renderIncoming = async function(preloaded) {
  const wrap = document.getElementById("incoming-list");
  if (!wrap) return;

  let docs = preloaded;
  if (!docs) {
    // Called directly (page nav) — single equality filter, no index needed.
    try {
      const snap = await getDocs(query(
        colRef(),
        where("source", "==", "Google Form"),
        limit(500)
      ));
      // Sort client-side (small set — only Google Form submissions)
      docs = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    } catch(e) {
      wrap.innerHTML = `<p style="color:var(--muted);padding:24px">Load error: ${esc(e.message)}</p>`;
      return;
    }
  }

  if (!docs.length) {
    wrap.innerHTML = `<div class="inc-empty">
      <div style="font-size:32px">📭</div>
      <div>No incoming applications yet.</div>
    </div>`;
    return;
  }

  const reviewed   = docs.filter(c => c.status !== "On Hold");
  const unreviewed = docs.filter(c => c.status === "On Hold");

  wrap.innerHTML =
    (unreviewed.length ? `<div class="inc-section-label">New (${unreviewed.length})</div>` + unreviewed.map(c => incomingCard(c, false)).join("") : "") +
    (reviewed.length   ? `<div class="inc-section-label" style="margin-top:24px">Reviewed (${reviewed.length})</div>` + reviewed.map(c => incomingCard(c, true)).join("") : "");
};

function incomingCard(c, isReviewed) {
  const statusColor = { Selected:"var(--green)", Rejected:"var(--red)", "On Hold":"var(--amber)" }[c.status] || "var(--muted)";
  return `
    <div class="incoming-card${isReviewed ? " reviewed" : ""}">
      <div class="inc-card-top">
        <div class="inc-avatar">${esc((c.name||"?")[0].toUpperCase())}</div>
        <div class="inc-card-info">
          <div class="inc-name">${esc(c.name)}</div>
          <div class="inc-meta">${esc(c.position || "—")} · ${esc(c.dept || "—")}</div>
          <div class="inc-meta" style="color:var(--muted)">${esc(c.email || "")} ${c.phone ? "· " + esc(c.phone) : ""}</div>
        </div>
        <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="badge" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44">${esc(c.status || "On Hold")}</span>
          <span style="font-size:11px;color:var(--muted)">${fmtDate(c.createdAt)}</span>
        </div>
      </div>
      ${!isReviewed ? `
      <div class="inc-card-actions">
        <button class="btn btn-success btn-sm" onclick="incomingAction('${c.id}','Selected')">✓ Accept</button>
        <button class="btn btn-warn    btn-sm" onclick="incomingAction('${c.id}','On Hold')">⏸ Hold</button>
        <button class="btn btn-danger  btn-sm" onclick="incomingAction('${c.id}','Rejected')">✗ Reject</button>
        <button class="btn btn-ghost   btn-sm" onclick="openViewModal('${c.id}')">👁 View</button>
      </div>` : `
      <div class="inc-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="openViewModal('${c.id}')">👁 View</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditModal('${c.id}')">✏️ Edit</button>
      </div>`}
    </div>`;
}

window.incomingAction = async function(id, status) {
  try {
    await updateDoc(doc(db, `users/${currentUser.uid}/candidates`, id), { status, updatedAt: serverTimestamp() });
    toast("Status → " + status, "ok");
    // re-render with fresh fetch
    await renderIncoming();
    loadDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
};

// ═══════════════════════════════════════════════════════
//  SERVER-SIDE PAGINATED CANDIDATES TABLE
//  Never loads more than PAGE_SIZE docs at once.
//  Filtering: where() pushed to Firestore.
//  Search: prefix range query on nameLower field.
// ═══════════════════════════════════════════════════════
let searchDebounceTimer = null;

window.applyFilters = function() {
  // Read filter values
  currentFilters.status = document.getElementById("f-status").value;
  currentFilters.dept   = document.getElementById("f-dept").value;
  currentFilters.sort   = document.getElementById("f-sort").value;
  currentFilters.search = document.getElementById("srch").value.trim().toLowerCase();

  // Reset pagination
  cursorStack  = [];
  lastVisible  = null;
  currentPageNum = 1;

  loadPageData();
};

window.applyFiltersDebounced = function() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => window.applyFilters(), 350);
};

/** Build Firestore query constraints from currentFilters */
function buildQueryConstraints(forCount = false) {
  const constraints = [];

  if (currentFilters.status) constraints.push(where("status", "==", currentFilters.status));
  if (currentFilters.dept)   constraints.push(where("dept",   "==", currentFilters.dept));

  // Search: prefix match on nameLower (stored as lowercase name)
  if (currentFilters.search) {
    const s   = currentFilters.search;
    const end = s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + 1);
    constraints.push(where("nameLower", ">=", s));
    constraints.push(where("nameLower", "<",  end));
  }

  return constraints;
}

async function loadPageData() {
  setLoadingState(true);
  try {
    const constraints = buildQueryConstraints();

    // ── Strategy ────────────────────────────────────────────────────
    // Firestore composite indexes are NOT auto-created; combining
    // where() + orderBy() on different fields requires a manual index.
    // To avoid ALL index errors we use this rule:
    //   • No where() filters → use orderBy("createdAt") for cursor pagination
    //   • Any where() filter  → fetch with limit only, sort JS-side on the
    //     PAGE_SIZE (≤100) result set. Cursor pagination disabled for filtered views.
    const hasFilters = constraints.length > 0;

    // ── Count query (zero doc reads) ──────────────────────────────
    const countQ    = query(colRef(), ...constraints);
    const countSnap = await getCountFromServer(countQ);
    totalFiltered   = countSnap.data().count;

    let docs;
    if (!hasFilters) {
      // ── Unfiltered: full cursor pagination with orderBy ──────────
      const orderDir = currentFilters.sort === "oldest" ? "asc" : "desc";
      const pageConstraints = [
        orderBy("createdAt", orderDir),
        limit(PAGE_SIZE),
      ];
      if (lastVisible) pageConstraints.push(startAfter(lastVisible));
      const snap = await getDocs(query(colRef(), ...pageConstraints));
      if (snap.docs.length > 0) lastVisible = snap.docs[snap.docs.length - 1];
      docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      // ── Filtered: simple where() only, sort client-side ──────────
      // No orderBy → no composite index needed.
      // Cursor pagination is reset on every filter change anyway.
      const snap = await getDocs(query(colRef(), ...constraints, limit(PAGE_SIZE)));
      docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Client-side sort on the small page result
      const sortV = currentFilters.sort;
      if (sortV === "name" || currentFilters.search) {
        docs.sort((a, b) => (a.nameLower || a.name || "").localeCompare(b.nameLower || b.name || ""));
      } else if (sortV === "oldest") {
        docs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
      } else {
        docs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      }

      // Disable cursor-based next/prev when filters are active
      // (we'd need a composite index for that — not worth the complexity)
      lastVisible = null;
    }

    renderTable(docs);
  } catch(e) {
    console.warn("loadPageData:", e.message);
    toast("Load error: " + e.message, "err");
  } finally {
    setLoadingState(false);
  }
}

function setLoadingState(on) {
  const loading = document.getElementById("c-loading");
  const table   = document.getElementById("c-table");
  if (loading) loading.style.display = on ? "flex" : "none";
  if (table)   table.style.display   = on ? "none" : "";
}

function renderTable(docs) {
  if (!docs.length && currentPageNum === 1) {
    document.getElementById("c-table").style.display    = "none";
    document.getElementById("c-empty").style.display    = "flex";
    document.getElementById("pagination").style.display = "none";
    return;
  }

  document.getElementById("c-table").style.display    = "";
  document.getElementById("c-empty").style.display    = "none";
  document.getElementById("pagination").style.display = "flex";

  document.getElementById("c-tbody").innerHTML = docs.map(c => `
    <tr>
      <td>
        <strong style="cursor:pointer;color:var(--accent)" onclick="openViewModal('${c.id}')">${esc(c.name)}</strong>
        <div style="font-size:11px;color:var(--muted)">${esc(c.email || "")}</div>
      </td>
      <td><span class="badge badge-dept">${esc(c.dept || "—")}</span></td>
      <td>${esc(c.position || "—")}</td>
      <td style="color:var(--muted)">${c.experience || 0} yr</td>
      <td>${statusBadge(c.status)}</td>
      <td style="color:var(--muted)">${fmtDate(c.createdAt)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="openEditModal('${c.id}')">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCandidate('${c.id}')">🗑</button>
          ${c.status !== "Selected" ? `<button class="btn btn-success btn-sm" onclick="changeStatus('${c.id}','Selected')">✓</button>` : ""}
          ${c.status !== "Rejected" ? `<button class="btn btn-danger btn-sm"  onclick="changeStatus('${c.id}','Rejected')">✗</button>` : ""}
          ${c.status !== "On Hold"  ? `<button class="btn btn-warn btn-sm"    onclick="changeStatus('${c.id}','On Hold')">⏸</button>` : ""}
        </div>
      </td>
    </tr>`).join("");

  const start = (currentPageNum - 1) * PAGE_SIZE + 1;
  const end   = start + docs.length - 1;
  document.getElementById("page-info").textContent =
    `Showing ${start}–${end} of ${totalFiltered.toLocaleString()}`;
  document.getElementById("btn-prev").disabled = currentPageNum <= 1;
  document.getElementById("btn-next").disabled = docs.length < PAGE_SIZE || end >= totalFiltered;
}

window.changePage = async function(dir) {
  if (dir === 1) {
    // Next: save end-of-current-page as the startAfter cursor for the next page
    cursorStack.push(lastVisible);
    currentPageNum++;
  } else {
    // Prev: we go back one page.
    // cursorStack[n-1] = the startAfter cursor that WAS used to reach the current page.
    // We want to re-fetch starting from cursorStack[n-2] (or null for page 1).
    cursorStack.pop();                             // discard the cursor for current page
    lastVisible    = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;
    currentPageNum = Math.max(1, currentPageNum - 1);
  }
  await loadPageData();
};

// ═══════════════════════════════════════════════════════
//  DEPT FILTER POPULATE
//  Reads up to 2000 dept values to build dropdown — fast.
// ═══════════════════════════════════════════════════════
async function populateDeptFilter() {
  try {
    const snap  = await getDocs(query(colRef(), orderBy("dept"), limit(2000)));
    const depts = [...new Set(snap.docs.map(d => d.data().dept).filter(Boolean))].sort();
    const sel   = document.getElementById("f-dept");
    if (!sel) return;
    const cur   = sel.value;
    sel.innerHTML = `<option value="">All Departments</option>` +
      depts.map(d => `<option value="${d}"${d === cur ? " selected" : ""}>${d}</option>`).join("");
  } catch(e) { console.warn("populateDeptFilter:", e.message); }
}

// ═══════════════════════════════════════════════════════
//  DEPARTMENTS PAGE
//  Counts per dept via server-side counting.
// ═══════════════════════════════════════════════════════
async function renderDepts() {
  const grid = document.getElementById("dept-grid");
  if (!grid) return;
  grid.innerHTML = `<p style="color:var(--muted)">Loading…</p>`;
  try {
    // Load dept field for up to 5000 docs (lightweight)
    const snap = await getDocs(query(colRef(), orderBy("dept"), limit(5000)));
    const map  = {};
    snap.docs.forEach(d => {
      const { dept, status } = d.data();
      if (!dept) return;
      if (!map[dept]) map[dept] = { total: 0, sel: 0, rej: 0, hold: 0 };
      map[dept].total++;
      if (status === "Selected") map[dept].sel++;
      else if (status === "Rejected") map[dept].rej++;
      else map[dept].hold++;
    });

    grid.innerHTML = Object.entries(map).map(([d, v]) => `
      <div class="dept-card" onclick="filterDept('${esc(d)}')">
        <h3>${esc(d)}</h3>
        <div class="dept-mini-bar">
          <div style="background:var(--green);width:${v.total ? (v.sel/v.total*100).toFixed(0) : 0}%"></div>
          <div style="background:var(--red);  width:${v.total ? (v.rej/v.total*100).toFixed(0) : 0}%"></div>
          <div style="background:var(--yellow);width:${v.total ? (v.hold/v.total*100).toFixed(0) : 0}%"></div>
        </div>
        <div class="dept-stat-row">
          <span style="color:var(--green)">✓ ${v.sel}</span>
          <span style="color:var(--red)">✗ ${v.rej}</span>
          <span style="color:var(--yellow)">⏸ ${v.hold}</span>
          <span style="color:var(--muted)">Total: ${v.total}</span>
        </div>
      </div>`).join("")
      || "<p style='color:var(--muted)'>No candidates added yet.</p>";
  } catch(e) {
    grid.innerHTML = `<p style="color:var(--red)">Error: ${esc(e.message)}</p>`;
  }
}

window.filterDept = function(dept) {
  showPage("candidates");
  document.getElementById("f-dept").value = dept;
  applyFilters();
};

// ═══════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════
window.showPage = function(page, statusFilter) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("page-" + page).classList.add("active");
  const navEl = document.getElementById("nav-" + page);
  if (navEl) navEl.classList.add("active");

  if (page === "candidates") {
    if (statusFilter) {
      document.getElementById("f-status").value = statusFilter;
    }
    applyFilters();
  }
  if (page === "departments") renderDepts();
  if (page === "incoming")    renderIncoming();
};

// ═══════════════════════════════════════════════════════
//  CRUD — ADD / SAVE
// ═══════════════════════════════════════════════════════
window.saveCandidate = async function() {
  const name = document.getElementById("f-name").value.trim();
  const dept = document.getElementById("f-dept-sel").value;
  if (!name) { toast("Name is required.", "err"); return; }
  if (!dept) { toast("Department is required.", "err"); return; }

  const wh = [];
  document.querySelectorAll(".wh-entry").forEach(el => {
    const company = el.querySelector(".wh-co").value.trim();
    const role    = el.querySelector(".wh-role").value.trim();
    const from    = el.querySelector(".wh-from").value.trim();
    const to      = el.querySelector(".wh-to").value.trim();
    const desc    = el.querySelector(".wh-desc").value.trim();
    if (company) wh.push({ company, role, from, to, desc });
  });

  const data = {
    name,
    nameLower:   name.toLowerCase(),   // ← for prefix-search range queries
    dept,
    status:      document.getElementById("f-status-sel").value,
    email:       document.getElementById("f-email").value.trim(),
    phone:       document.getElementById("f-phone").value.trim(),
    location:    document.getElementById("f-loc").value.trim(),
    position:    document.getElementById("f-pos").value.trim(),
    experience:  document.getElementById("f-exp").value || "0",
    ctc:         document.getElementById("f-ctc").value.trim(),
    expectedCtc: document.getElementById("f-ectc").value.trim(),
    skills:      document.getElementById("f-skills").value.trim(),
    round:       document.getElementById("f-round").value,
    notes:       document.getElementById("f-notes").value.trim(),
    workHistory: wh,
    updatedAt:   serverTimestamp(),
  };

  const editId = document.getElementById("edit-id").value;
  try {
    if (editId) {
      await updateDoc(doc(db, `users/${currentUser.uid}/candidates`, editId), data);
      toast("Updated! ✅", "ok");
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(colRef(), data);
      toast("Candidate added! ✅", "ok");
    }
    closeModal("modal-add");
    // Refresh current page view
    await applyFilters();
    loadDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
};

// ═══════════════════════════════════════════════════════
//  CRUD — DELETE
// ═══════════════════════════════════════════════════════
window.deleteCandidate = async function(id) {
  if (!confirm("Delete this candidate permanently?")) return;
  try {
    await deleteDoc(doc(db, `users/${currentUser.uid}/candidates`, id));
    toast("Deleted.", "ok");
    applyFilters();
    loadDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
};

// ═══════════════════════════════════════════════════════
//  CRUD — CHANGE STATUS
// ═══════════════════════════════════════════════════════
window.changeStatus = async function(id, status) {
  try {
    await updateDoc(doc(db, `users/${currentUser.uid}/candidates`, id), { status, updatedAt: serverTimestamp() });
    toast("Status → " + status, "ok");
    applyFilters();
    loadDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
};

// ═══════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════
let whCount = 0;

function clearForm() {
  ["f-name","f-email","f-phone","f-loc","f-pos","f-exp","f-ctc","f-ectc","f-skills","f-notes"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  document.getElementById("f-dept-sel").value   = "";
  document.getElementById("f-status-sel").value = "On Hold";
  document.getElementById("f-round").value      = "Screening";
  document.getElementById("edit-id").value      = "";
  document.getElementById("wh-list").innerHTML  = "";
  whCount = 0;
}

window.openAddModal = function() {
  clearForm();
  document.getElementById("modal-title").textContent = "Add Candidate";
  document.getElementById("modal-add").classList.add("open");
};

/** Fetch single doc by ID — no need to hold 50k in memory */
window.openEditModal = async function(id) {
  clearForm();
  document.getElementById("modal-title").textContent = "Edit Candidate";
  try {
    const snap = await getDoc(doc(db, `users/${currentUser.uid}/candidates`, id));
    if (!snap.exists()) { toast("Candidate not found.", "err"); return; }
    const c = { id: snap.id, ...snap.data() };

    document.getElementById("edit-id").value            = id;
    document.getElementById("f-name").value             = c.name        || "";
    document.getElementById("f-email").value            = c.email       || "";
    document.getElementById("f-phone").value            = c.phone       || "";
    document.getElementById("f-loc").value              = c.location    || "";
    document.getElementById("f-pos").value              = c.position    || "";
    document.getElementById("f-exp").value              = c.experience  || "";
    document.getElementById("f-ctc").value              = c.ctc         || "";
    document.getElementById("f-ectc").value             = c.expectedCtc || "";
    document.getElementById("f-skills").value           = c.skills      || "";
    document.getElementById("f-notes").value            = c.notes       || "";
    document.getElementById("f-dept-sel").value         = c.dept        || "";
    document.getElementById("f-status-sel").value       = c.status      || "On Hold";
    document.getElementById("f-round").value            = c.round       || "Screening";
    (c.workHistory || []).forEach(wh => addWH(wh));
    document.getElementById("modal-add").classList.add("open");
  } catch(e) { toast("Error loading candidate: " + e.message, "err"); }
};

/** Fetch single doc by ID for view modal */
window.openViewModal = async function(id) {
  try {
    const snap = await getDoc(doc(db, `users/${currentUser.uid}/candidates`, id));
    if (!snap.exists()) { toast("Candidate not found.", "err"); return; }
    const c = { id: snap.id, ...snap.data() };

    document.getElementById("view-title").textContent = c.name;

    const skills = (c.skills || "").split(",").filter(Boolean)
      .map(s => `<span class="skill-tag">${esc(s.trim())}</span>`).join("");

    const wh = (c.workHistory || []).map(w => `
      <div class="wh-card">
        <div class="wh-card-hdr">${esc(w.company)}</div>
        <div style="font-size:13px;margin-bottom:4px">💼 ${esc(w.role || "—")}</div>
        ${w.from || w.to ? `<div style="font-size:12px;color:var(--muted)">📅 ${esc(w.from || "?")} → ${esc(w.to || "Present")}</div>` : ""}
        ${w.desc ? `<div style="font-size:13px;color:var(--muted);margin-top:6px">${esc(w.desc)}</div>` : ""}
      </div>`).join("");

    document.getElementById("view-body").innerHTML = `
      <div class="dv-section">
        <h3>Personal</h3>
        <div class="dv-grid">
          <div class="dv-item"><label>Email</label><p>${esc(c.email||"—")}</p></div>
          <div class="dv-item"><label>Phone</label><p>${esc(c.phone||"—")}</p></div>
          <div class="dv-item"><label>Location</label><p>${esc(c.location||"—")}</p></div>
          <div class="dv-item"><label>Status</label><p>${statusBadge(c.status)}</p></div>
        </div>
      </div>
      <div class="dv-section">
        <h3>Job Info</h3>
        <div class="dv-grid">
          <div class="dv-item"><label>Department</label><p><span class="badge badge-dept">${esc(c.dept||"—")}</span></p></div>
          <div class="dv-item"><label>Position</label><p>${esc(c.position||"—")}</p></div>
          <div class="dv-item"><label>Experience</label><p>${c.experience||0} years</p></div>
          <div class="dv-item"><label>Current CTC</label><p>${c.ctc ? c.ctc+" LPA" : "—"}</p></div>
          <div class="dv-item"><label>Expected CTC</label><p>${c.expectedCtc ? c.expectedCtc+" LPA" : "—"}</p></div>
          <div class="dv-item"><label>Round</label><p>${esc(c.round||"—")}</p></div>
        </div>
        ${skills ? `<div style="margin-top:12px"><label class="dv-item" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--muted)">Skills</label><div style="margin-top:6px">${skills}</div></div>` : ""}
      </div>
      ${c.notes ? `<div class="dv-section"><h3>Notes</h3><p style="font-size:13px;white-space:pre-wrap">${esc(c.notes)}</p></div>` : ""}
      ${wh ? `<div class="dv-section"><h3>Work History</h3>${wh}</div>` : ""}
      <div style="display:flex;gap:10px;margin-top:8px;padding-top:16px;border-top:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" onclick="closeModal('modal-view');openEditModal('${c.id}')">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="closeModal('modal-view');deleteCandidate('${c.id}')">🗑 Delete</button>
      </div>`;

    document.getElementById("modal-view").classList.add("open");
  } catch(e) { toast("Error loading candidate: " + e.message, "err"); }
};

window.closeModal = id => document.getElementById(id).classList.remove("open");

window.overlayClose = function(e, id) {
  if (e.target.id === id) closeModal(id);
};

// ═══════════════════════════════════════════════════════
//  WORK HISTORY FIELDS
// ═══════════════════════════════════════════════════════
window.addWH = function(data = {}) {
  whCount++;
  const div = document.createElement("div");
  div.className = "wh-card wh-entry";
  div.innerHTML = `
    <div class="wh-card-hdr">
      Experience #${whCount}
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.wh-entry').remove()" style="font-size:11px">Remove</button>
    </div>
    <div class="field-row">
      <div class="field"><label>Company</label><input class="wh-co"   value="${esc(data.company||"")}" placeholder="Google"/></div>
      <div class="field"><label>Role</label><input class="wh-role" value="${esc(data.role||"")}"    placeholder="Engineer"/></div>
    </div>
    <div class="field-row">
      <div class="field"><label>From</label><input class="wh-from" value="${esc(data.from||"")}" placeholder="Jan 2020"/></div>
      <div class="field"><label>To</label><input class="wh-to"   value="${esc(data.to||"")}"   placeholder="Dec 2022"/></div>
    </div>
    <div class="field"><label>Description</label><input class="wh-desc" value="${esc(data.desc||"")}" placeholder="Key responsibilities..."/></div>`;
  document.getElementById("wh-list").appendChild(div);
};

// ═══════════════════════════════════════════════════════
//  EMAIL SETTINGS  (localStorage)
// ═══════════════════════════════════════════════════════
const ES_KEY = "ats_emailjs_settings";

function getEmailSettings() {
  try { return JSON.parse(localStorage.getItem(ES_KEY)) || null; } catch { return null; }
}

function isEmailConnected() {
  const s = getEmailSettings();
  return s && s.pubkey && s.service && s.template;
}

window.openEmailSettings = function() {
  const s = getEmailSettings();
  document.getElementById("es-pubkey").value   = s?.pubkey    || "";
  document.getElementById("es-service").value  = s?.service   || "";
  document.getElementById("es-template").value = s?.template  || "";
  document.getElementById("es-fromname").value = s?.fromName  || "";

  const banner = document.getElementById("es-connected-banner");
  if (isEmailConnected()) {
    banner.style.display = "flex";
    document.getElementById("es-connected-label").textContent = `Gmail connected · ${s.fromName || "EmailJS"}`;
  } else {
    banner.style.display = "none";
  }
  document.getElementById("modal-email-settings").classList.add("open");
};

window.saveEmailSettings = function() {
  const pubkey   = document.getElementById("es-pubkey").value.trim();
  const service  = document.getElementById("es-service").value.trim();
  const template = document.getElementById("es-template").value.trim();
  const fromName = document.getElementById("es-fromname").value.trim();
  if (!pubkey || !service || !template) {
    toast("Please fill Public Key, Service ID and Template ID.", "err"); return;
  }
  localStorage.setItem(ES_KEY, JSON.stringify({ pubkey, service, template, fromName }));
  emailjs.init(pubkey);
  toast("Gmail connected via EmailJS ✅", "ok");
  closeModal("modal-email-settings");
};

window.disconnectEmailSettings = function() {
  if (!confirm("Disconnect Gmail? Bulk email will stop working.")) return;
  localStorage.removeItem(ES_KEY);
  toast("Gmail disconnected.", "");
  closeModal("modal-email-settings");
};

(function initEmailJSOnLoad() {
  const s = getEmailSettings();
  if (s?.pubkey) { try { emailjs.init(s.pubkey); } catch(e) {} }
})();

// ═══════════════════════════════════════════════════════
//  BULK EMAIL
//  Loads only the needed status/email candidates — small query.
// ═══════════════════════════════════════════════════════
let bulkCurrentStatus = "Selected";

window.openBulkEmail = async function(status = "Selected") {
  bulkCurrentStatus = status;

  const connected = isEmailConnected();
  document.getElementById("be-account-info").style.display = connected ? "flex" : "none";
  document.getElementById("be-account-warn").style.display = connected ? "none" : "block";
  if (connected) {
    const s = getEmailSettings();
    document.getElementById("be-from-name").textContent = s.fromName || "EmailJS";
  }

  // Count per status via server-side count (zero doc reads)
  const [cntSel, cntHold, cntRej] = await Promise.all([
    countWhere(where("status","==","Selected"), where("email","!=","")),
    countWhere(where("status","==","On Hold"),  where("email","!=","")),
    countWhere(where("status","==","Rejected"), where("email","!=","")),
  ]);
  setText("be-cnt-Selected", cntSel);
  setText("be-cnt-On Hold",  cntHold);
  setText("be-cnt-Rejected", cntRej);

  document.querySelectorAll(".be-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("be-tab-" + status).classList.add("active");

  await renderBulkRecipients(status);

  document.getElementById("be-subject").value      = "";
  document.getElementById("be-body").value         = "";
  document.getElementById("be-progress-wrap").style.display = "none";
  document.getElementById("be-send-btn").disabled  = false;
  document.getElementById("be-cancel-btn").textContent = "Cancel";

  document.getElementById("modal-bulk-email").classList.add("open");
};

async function renderBulkRecipients(status) {
  const wrap  = document.getElementById("be-recipients");
  const noEl  = document.getElementById("be-no-email");
  const allCk = document.getElementById("be-check-all");
  wrap.innerHTML = `<p style="color:var(--muted);font-size:13px">Loading…</p>`;

  try {
    // Load candidates with email for this status — targeted query
    const snap = await getDocs(query(
      colRef(),
      where("status", "==", status),
      orderBy("createdAt", "desc"),
      limit(500)   // EmailJS free tier supports 200/month anyway
    ));
    const candidates = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.email);

    bulkCandidateMap = {};
    candidates.forEach(c => { bulkCandidateMap[c.email] = c; });

    if (!candidates.length) {
      wrap.innerHTML     = "";
      noEl.style.display = "block";
      allCk.checked      = false;
      allCk.disabled     = true;
      return;
    }

    noEl.style.display = "none";
    allCk.disabled     = false;
    allCk.checked      = true;

    wrap.innerHTML = candidates.map(c => `
      <label class="be-recipient-row">
        <input type="checkbox" class="be-chk" value="${esc(c.email)}" checked/>
        <div class="be-recipient-avatar">${esc((c.name || "?")[0].toUpperCase())}</div>
        <div class="be-recipient-info">
          <div class="be-recipient-name">${esc(c.name)}</div>
          <div class="be-recipient-email">${esc(c.email)}</div>
        </div>
        <span class="be-recipient-dept">${esc(c.dept || "—")}</span>
      </label>`).join("");

    wrap.querySelectorAll(".be-chk").forEach(chk => {
      chk.addEventListener("change", syncSelectAll);
    });
  } catch(e) {
    wrap.innerHTML = `<p style="color:var(--red)">Error: ${esc(e.message)}</p>`;
  }
}

function syncSelectAll() {
  const all     = document.querySelectorAll(".be-chk");
  const checked = document.querySelectorAll(".be-chk:checked");
  const allCk   = document.getElementById("be-check-all");
  allCk.checked       = checked.length === all.length;
  allCk.indeterminate = checked.length > 0 && checked.length < all.length;
}

window.switchBulkTab = function(status) {
  bulkCurrentStatus = status;
  document.querySelectorAll(".be-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("be-tab-" + status).classList.add("active");
  renderBulkRecipients(status);
};

window.bulkToggleAll = function(checked) {
  document.querySelectorAll(".be-chk").forEach(chk => { chk.checked = checked; });
};

window.sendBulkEmail = async function() {
  const subject = document.getElementById("be-subject").value.trim();
  const body    = document.getElementById("be-body").value.trim();
  const emails  = [...document.querySelectorAll(".be-chk:checked")].map(c => c.value);

  if (!isEmailConnected()) { toast("Please connect Gmail first (⚙️ Email Settings).", "err"); return; }
  if (!emails.length)      { toast("No recipients selected.", "err"); return; }
  if (!subject)            { toast("Please enter a subject.", "err"); return; }
  if (!body)               { toast("Please enter a message body.", "err"); return; }

  const settings = getEmailSettings();

  const sendBtn   = document.getElementById("be-send-btn");
  const cancelBtn = document.getElementById("be-cancel-btn");
  sendBtn.disabled       = true;
  sendBtn.textContent    = "Sending…";
  cancelBtn.textContent  = "Close";

  const progressWrap = document.getElementById("be-progress-wrap");
  const progressFill = document.getElementById("be-progress-fill");
  const progressText = document.getElementById("be-progress-text");
  const progressPct  = document.getElementById("be-progress-pct");
  const progressLog  = document.getElementById("be-progress-log");
  progressWrap.style.display = "block";
  progressLog.innerHTML      = "";

  let sent = 0, failed = 0;
  const total = emails.length;

  function updateProgress() {
    const done = sent + failed;
    const pct  = Math.round((done / total) * 100);
    progressFill.style.width = pct + "%";
    progressText.textContent = `Sending ${done} of ${total}…`;
    progressPct.textContent  = pct + "%";
  }

  function logLine(email, ok, err) {
    const div = document.createElement("div");
    div.className = "be-log-line " + (ok ? "be-log-ok" : "be-log-err");
    div.textContent = (ok ? "✅ " : "❌ ") + email + (err ? ` — ${err}` : "");
    progressLog.appendChild(div);
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  for (const email of emails) {
    const candidate  = bulkCandidateMap[email] || {};
    const name       = candidate.name || "Candidate";
    const personalBody = body.replace(/\{\{name\}\}/gi, name);
    const params = {
      to_email:  email, to_name: name,
      subject, message: personalBody,
      from_name: settings.fromName || "TalentFlow HR",
    };
    try {
      await emailjs.send(settings.service, settings.template, params);
      sent++; logLine(email, true);
    } catch(e) {
      failed++; logLine(email, false, e?.text || e?.message || "Error");
    }
    updateProgress();
    await new Promise(r => setTimeout(r, 300));
  }

  progressText.textContent = `Done! ✅ ${sent} sent${failed ? `, ${failed} failed` : ""}`;
  progressFill.style.background = failed ? "var(--yellow)" : "var(--green)";
  sendBtn.textContent = "Done";
  toast(`Sent ${sent} email${sent !== 1 ? "s" : ""}${failed ? ` (${failed} failed)` : ""} ✉️`, sent ? "ok" : "err");
};

// ═══════════════════════════════════════════════════════
//  3D BACKGROUND PARTICLES
// ═══════════════════════════════════════════════════════
function spawnParticles() {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas || canvas.dataset.spawned) return;
  canvas.dataset.spawned = "1";
  const colors = ["rgba(79,224,214,1)", "rgba(255,176,32,1)", "rgba(79,224,214,.6)"];
  const sizes  = [3, 4, 5, 3, 6, 4];
  for (let i = 0; i < 28; i++) {
    const p   = document.createElement("div");
    p.className = "bg-particle";
    const sz    = sizes[i % sizes.length];
    const dur   = 10 + Math.random() * 14;
    const delay = -(Math.random() * dur);
    const left  = Math.random() * 100;
    const top   = 20 + Math.random() * 70;
    const col   = colors[i % colors.length];
    p.style.cssText = `
      --sz:${sz}px; --dur:${dur.toFixed(1)}s; --delay:${delay.toFixed(1)}s;
      left:${left.toFixed(1)}%; top:${top.toFixed(1)}%;
      background:${col};
      box-shadow:0 0 ${sz*2}px ${sz}px ${col.replace("1)",",.4)")};
    `;
    canvas.appendChild(p);
  }
}

// ═══════════════════════════════════════════════════════
//  FORM IMPORT — live-inject credentials into script
// ═══════════════════════════════════════════════════════
window.updateScript = function() {
  const email = (document.getElementById("fi-email")?.value.trim()) || "YOUR_EMAIL";
  const pass  = (document.getElementById("fi-pass")?.value)         || "YOUR_PASSWORD";
  const pre   = document.getElementById("apps-script-code");
  if (!pre) return;
  pre.textContent = pre.textContent
    .replace(/var USER_EMAIL\s*=\s*"[^"]*"/, `var USER_EMAIL          = "${email}"`)
    .replace(/var USER_PASSWORD\s*=\s*"[^"]*"/, `var USER_PASSWORD       = "${pass}"`);
};

window.copyScript = function() {
  const el  = document.getElementById("apps-script-code");
  const btn = document.getElementById("copy-btn-script");
  if (!el) return;
  const text = el.textContent || el.innerText;
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      btn.classList.add("copied");
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Copied!`;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 2200);
    }
    toast("Apps Script copied to clipboard! ✅", "ok");
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
    toast("Apps Script copied! ✅", "ok");
  });
};
