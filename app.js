// ══════════════════════════════════════════════════════
//  Mini ATS — app.js
//  Firebase v10 (modular CDN) + pure JS
// ══════════════════════════════════════════════════════

import { initializeApp }                                    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword,
         signInWithEmailAndPassword, signOut,
         onAuthStateChanged, updateProfile }                from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs,
         doc, updateDoc, deleteDoc,
         query, orderBy, serverTimestamp, onSnapshot }      from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ──────────────────────────────────────────────────────
//  🔥  PASTE YOUR FIREBASE CONFIG HERE
// ──────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyB3Z4-HU5pADplI-5ONrnV-4sm-eYMXRLo",
  authDomain:        "ats-system-d83ef.firebaseapp.com",
  projectId:         "ats-system-d83ef",
  storageBucket:     "ats-system-d83ef.firebasestorage.app",
  messagingSenderId: "150874136182",
  appId:             "1:150874136182:web:c0a8542124cc33647f0957"
};
// ──────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── State ──
let currentUser   = null;
let allCandidates = [];
let filtered      = [];
let currentPage   = 1;
let whCount       = 0;
let incomingUnsub = null;   // Firestore real-time unsub handle
const PAGE_SIZE   = 50;     // supports 500+ records across 10 pages

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
function toast(msg, type = "") {
  const c = document.getElementById("toasts");
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function statusBadge(s) {
  const cls = { Selected: "badge-sel", Rejected: "badge-rej", "On Hold": "badge-hold" };
  return `<span class="badge ${cls[s] || "badge-hold"}">${s || "On Hold"}</span>`;
}

function authErr(code) {
  return {
    "auth/invalid-email":        "Invalid email address.",
    "auth/user-not-found":       "No account found.",
    "auth/wrong-password":       "Wrong password.",
    "auth/email-already-in-use": "Email already registered.",
    "auth/weak-password":        "Password too weak (min 6 chars).",
    "auth/invalid-credential":   "Invalid email or password.",
    "auth/too-many-requests":    "Too many attempts. Try later.",
  }[code] || "Error: " + code;
}

// ═══════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════
window.switchTab = function(tab) {
  document.getElementById("form-login").style.display  = tab === "login"  ? "block" : "none";
  document.getElementById("form-signup").style.display = tab === "signup" ? "block" : "none";
  document.getElementById("tab-login").classList.toggle("active",  tab === "login");
  document.getElementById("tab-signup").classList.toggle("active", tab === "signup");
  document.getElementById("auth-form-login-header").style.display  = tab === "login"  ? "block" : "none";
  document.getElementById("auth-form-signup-header").style.display = tab === "signup" ? "block" : "none";
  document.getElementById("auth-error").style.display = "none";
};

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  el.style.display = "flex";
  document.getElementById("auth-error-text").textContent = msg;
}

window.doLogin = async function() {
  const email = document.getElementById("login-email").value.trim();
  const pass  = document.getElementById("login-pass").value;
  if (!email || !pass) { showAuthError("Please fill all fields."); return; }
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    toast("Welcome back! 👋", "ok");
  } catch(e) { showAuthError(authErr(e.code)); }
};

window.doSignup = async function() {
  const name  = document.getElementById("su-name").value.trim();
  const email = document.getElementById("su-email").value.trim();
  const pass  = document.getElementById("su-pass").value;
  if (!name || !email || !pass) { showAuthError("Please fill all fields."); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    toast("Account created! Welcome 🎉", "ok");
  } catch(e) { showAuthError(authErr(e.code)); }
};

window.doLogout = async function() {
  await signOut(auth);
  allCandidates = [];
  toast("Logged out.");
};

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    document.getElementById("screen-auth").style.display = "none";
    document.getElementById("screen-app").style.display  = "flex";

    // Personalise welcome messages & avatar
    const firstName = (user.displayName || "Digvijay").split(" ")[0];
    document.getElementById("welcome-msg").textContent  = `Welcome, ${firstName} 👋`;
    document.getElementById("dash-welcome").textContent = `Welcome, ${firstName}! 👋`;
    const avatarEl = document.getElementById("topbar-avatar");
    if (avatarEl) avatarEl.textContent = firstName[0].toUpperCase();

    spawnParticles();
    await loadCandidates();
    renderDashboard();
    startIncomingListener();   // live real-time listener for form submissions
  } else {
    document.getElementById("screen-auth").style.display = "flex";
    document.getElementById("screen-app").style.display  = "none";
    if (incomingUnsub) { incomingUnsub(); incomingUnsub = null; }
  }
});

// ═══════════════════════════════════════════════════════
//  FIRESTORE
// ═══════════════════════════════════════════════════════
function colRef() {
  return collection(db, `users/${currentUser.uid}/candidates`);
}

async function loadCandidates() {
  document.getElementById("c-loading").style.display = "flex";
  document.getElementById("c-table").style.display   = "none";
  try {
    const q    = query(colRef(), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    allCandidates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    applyFilters();
    populateDeptFilter();
  } catch(e) {
    toast("Load error: " + e.message, "err");
  }
  document.getElementById("c-loading").style.display = "none";
}

window.saveCandidate = async function() {
  const name = document.getElementById("f-name").value.trim();
  const dept = document.getElementById("f-dept-sel").value;
  if (!name) { toast("Name is required.", "err"); return; }
  if (!dept) { toast("Department is required.", "err"); return; }

  // collect work history
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
    name, dept,
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
    await loadCandidates();
    renderDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
};

window.deleteCandidate = async function(id) {
  if (!confirm("Delete this candidate permanently?")) return;
  try {
    await deleteDoc(doc(db, `users/${currentUser.uid}/candidates`, id));
    toast("Deleted.", "ok");
    await loadCandidates();
    renderDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
};

window.changeStatus = async function(id, status) {
  try {
    await updateDoc(doc(db, `users/${currentUser.uid}/candidates`, id), { status, updatedAt: serverTimestamp() });
    toast("Status → " + status, "ok");
    await loadCandidates();
    renderDashboard();
  } catch(e) { toast("Error: " + e.message, "err"); }
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

  if (page === "candidates" && statusFilter) {
    document.getElementById("f-status").value = statusFilter;
    applyFilters();
  }
  if (page === "departments") renderDepts();
  if (page === "incoming")    renderIncoming();
};

// ═══════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════
function renderDashboard() {
  const total = allCandidates.length;
  const sel   = allCandidates.filter(c => c.status === "Selected").length;
  const rej   = allCandidates.filter(c => c.status === "Rejected").length;
  const hold  = allCandidates.filter(c => c.status === "On Hold").length;
  const depts = new Set(allCandidates.map(c => c.dept).filter(Boolean)).size;

  document.getElementById("s-total").textContent  = total;
  document.getElementById("s-sel").textContent    = sel;
  document.getElementById("s-rej").textContent    = rej;
  document.getElementById("s-hold").textContent   = hold;
  document.getElementById("s-dept").textContent   = depts;
  document.getElementById("wb-total").textContent = total;

  // sidebar badges
  document.getElementById("nb-sel").textContent  = sel;
  document.getElementById("nb-rej").textContent  = rej;
  document.getElementById("nb-hold").textContent = hold;

  const pct = n => total ? (n / total * 100).toFixed(1) + "%" : "0%";
  document.getElementById("pipe-sel").style.width  = pct(sel);
  document.getElementById("pipe-rej").style.width  = pct(rej);
  document.getElementById("pipe-hold").style.width = pct(hold);

  // percentage labels under the bar
  document.getElementById("pct-sel").textContent  = pct(sel);
  document.getElementById("pct-rej").textContent  = pct(rej);
  document.getElementById("pct-hold").textContent = pct(hold);

  // dept bars
  const deptMap = {};
  allCandidates.forEach(c => { if (c.dept) deptMap[c.dept] = (deptMap[c.dept] || 0) + 1; });
  const sorted = Object.entries(deptMap).sort((a, b) => b[1] - a[1]);
  document.getElementById("dept-bars").innerHTML = sorted.map(([d, n]) => `
    <div class="dept-row">
      <span class="dept-name">${esc(d)}</span>
      <div class="dept-track"><div class="dept-fill" style="width:${total ? (n/total*100).toFixed(1) : 0}%"></div></div>
      <span class="dept-count">${n}</span>
    </div>`).join("");

  // recent
  document.getElementById("recent-tbody").innerHTML =
    allCandidates.slice(0, 8).map(c => `
      <tr>
        <td><strong style="cursor:pointer;color:var(--accent)" onclick="openViewModal('${c.id}')">${esc(c.name)}</strong></td>
        <td><span class="badge badge-dept">${esc(c.dept || "—")}</span></td>
        <td>${esc(c.position || "—")}</td>
        <td>${statusBadge(c.status)}</td>
        <td style="color:var(--muted)">${fmtDate(c.createdAt)}</td>
      </tr>`).join("")
    || `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted)">No candidates yet. Add one! 👆</td></tr>`;
}

// ═══════════════════════════════════════════════════════
//  INCOMING APPLICATIONS — real-time Firestore listener
// ═══════════════════════════════════════════════════════
function startIncomingListener() {
  if (incomingUnsub) incomingUnsub();   // clear any old listener
  const q = query(colRef(), orderBy("createdAt", "desc"));
  incomingUnsub = onSnapshot(q, (snap) => {
    // Rebuild full list from snapshot so it stays in sync with loadCandidates
    allCandidates = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Count new unreviewed form submissions = source Google Form + status On Hold
    const newCount = allCandidates.filter(
      c => c.source === "Google Form" && c.status === "On Hold"
    ).length;

    // Update the sidebar badge
    const badge = document.getElementById("nb-incoming");
    if (badge) {
      badge.textContent = newCount;
      badge.style.display = newCount > 0 ? "inline-flex" : "none";
    }

    // Update topbar notification dot
    const dot = document.getElementById("incoming-dot");
    if (dot) dot.style.display = newCount > 0 ? "block" : "none";

    // If the incoming page is open, re-render it live
    const pg = document.getElementById("page-incoming");
    if (pg && pg.classList.contains("active")) renderIncoming();

    // Also refresh dashboard stats
    renderDashboard();
  }, (err) => {
    console.warn("Incoming listener error:", err.message);
  });
}

window.renderIncoming = function() {
  const formCandidates = allCandidates
    .filter(c => c.source === "Google Form")
    .sort((a, b) => {
      const ta = a.createdAt?.seconds || 0;
      const tb = b.createdAt?.seconds || 0;
      return tb - ta;
    });

  const unreviewed = formCandidates.filter(c => c.status === "On Hold");
  const reviewed   = formCandidates.filter(c => c.status !== "On Hold");

  const grid      = document.getElementById("incoming-grid");
  const reviewed_grid = document.getElementById("reviewed-grid");
  const emptyEl   = document.getElementById("incoming-empty");
  const statsEl   = document.getElementById("incoming-stats");
  if (!grid) return;

  // Update stats bar
  const total = formCandidates.length;
  const sel   = formCandidates.filter(c => c.status === "Selected").length;
  const rej   = formCandidates.filter(c => c.status === "Rejected").length;
  const hold  = unreviewed.length;
  if (statsEl) {
    document.getElementById("inc-s-total").textContent  = total;
    document.getElementById("inc-s-new").textContent    = hold;
    document.getElementById("inc-s-sel").textContent    = sel;
    document.getElementById("inc-s-rej").textContent    = rej;
  }

  // Render unreviewed cards
  if (!unreviewed.length) {
    grid.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "flex";
  } else {
    if (emptyEl) emptyEl.style.display = "none";
    grid.innerHTML = unreviewed.map(c => incomingCard(c, false)).join("");
  }

  // Render reviewed section
  if (reviewed_grid) {
    reviewed_grid.innerHTML = reviewed.length
      ? reviewed.map(c => incomingCard(c, true)).join("")
      : `<p style="color:var(--muted);font-size:13px;padding:12px 0">No reviewed submissions yet.</p>`;
  }
};

function incomingCard(c, isReviewed) {
  const initials = (c.name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const statusClass = c.status === "Selected" ? "badge-sel"
                    : c.status === "Rejected"  ? "badge-rej"
                    : "badge-hold";
  const timeAgo = fmtDate(c.createdAt);

  return `
  <div class="incoming-card ${isReviewed ? "incoming-card-reviewed" : "incoming-card-new"}">
    <div class="inc-card-header">
      <div class="inc-avatar">${initials}</div>
      <div class="inc-info">
        <div class="inc-name" onclick="openViewModal('${c.id}')">${esc(c.name)}</div>
        <div class="inc-meta">
          ${c.position ? `<span>${esc(c.position)}</span>` : ""}
          ${c.dept     ? `<span class="badge badge-dept" style="font-size:10px">${esc(c.dept)}</span>` : ""}
        </div>
      </div>
      <span class="badge ${statusClass}" style="margin-left:auto;flex-shrink:0">${esc(c.status)}</span>
    </div>
    <div class="inc-details">
      ${c.email    ? `<span>📧 ${esc(c.email)}</span>` : ""}
      ${c.phone    ? `<span>📞 ${esc(c.phone)}</span>` : ""}
      ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ""}
      ${c.experience ? `<span>⏱ ${esc(c.experience)} yrs exp</span>` : ""}
    </div>
    ${c.skills ? `<div class="inc-skills">${c.skills.split(",").filter(Boolean).map(s => `<span class="skill-tag">${esc(s.trim())}</span>`).join("")}</div>` : ""}
    <div class="inc-time">🕐 Applied: ${timeAgo}</div>
    ${!isReviewed ? `
    <div class="inc-actions">
      <button class="btn btn-success btn-sm" onclick="changeStatus('${c.id}','Selected')">✓ Select</button>
      <button class="btn btn-warn btn-sm"    onclick="changeStatus('${c.id}','On Hold')">⏸ Hold</button>
      <button class="btn btn-danger btn-sm"  onclick="changeStatus('${c.id}','Rejected')">✗ Reject</button>
      <button class="btn btn-ghost btn-sm"   onclick="openViewModal('${c.id}')">👁 View</button>
    </div>` : `
    <div class="inc-actions">
      <button class="btn btn-ghost btn-sm" onclick="openViewModal('${c.id}')">👁 View Full Profile</button>
      ${c.status === "Rejected" ? `<button class="btn btn-warn btn-sm" onclick="changeStatus('${c.id}','On Hold')">↩ Move to Hold</button>` : ""}
      ${c.status === "Selected" ? `<button class="btn btn-ghost btn-sm" onclick="changeStatus('${c.id}','Rejected')">✗ Reject</button>` : ""}
    </div>`}
  </div>`;
}

// ═══════════════════════════════════════════════════════
//  CANDIDATES TABLE
// ═══════════════════════════════════════════════════════
window.applyFilters = function() {
  const srch    = document.getElementById("srch").value.toLowerCase();
  const statF   = document.getElementById("f-status").value;
  const deptF   = document.getElementById("f-dept").value;
  const sortV   = document.getElementById("f-sort").value;

  filtered = allCandidates.filter(c => {
    const matchSrch = !srch || [c.name, c.email, c.position, c.skills]
      .some(f => (f || "").toLowerCase().includes(srch));
    const matchStat = !statF || c.status === statF;
    const matchDept = !deptF || c.dept === deptF;
    return matchSrch && matchStat && matchDept;
  });

  if (sortV === "name")   filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (sortV === "oldest") filtered.reverse();

  currentPage = 1;
  renderTable();
};

function renderTable() {
  const start   = (currentPage - 1) * PAGE_SIZE;
  const pageArr = filtered.slice(start, start + PAGE_SIZE);

  if (!filtered.length) {
    document.getElementById("c-table").style.display   = "none";
    document.getElementById("c-empty").style.display   = "flex";
    document.getElementById("pagination").style.display = "none";
    return;
  }

  document.getElementById("c-table").style.display    = "";
  document.getElementById("c-empty").style.display    = "none";
  document.getElementById("pagination").style.display = "flex";

  document.getElementById("c-tbody").innerHTML = pageArr.map(c => `
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

  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  document.getElementById("page-info").textContent =
    `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`;
  document.getElementById("btn-prev").disabled = currentPage === 1;
  document.getElementById("btn-next").disabled = currentPage >= pages;
}

window.changePage = function(dir) {
  currentPage += dir;
  renderTable();
};

function populateDeptFilter() {
  const depts   = [...new Set(allCandidates.map(c => c.dept).filter(Boolean))].sort();
  const sel     = document.getElementById("f-dept");
  const current = sel.value;
  sel.innerHTML = `<option value="">All Departments</option>` +
    depts.map(d => `<option value="${d}"${d === current ? " selected" : ""}>${d}</option>`).join("");
}

// ═══════════════════════════════════════════════════════
//  DEPARTMENTS PAGE
// ═══════════════════════════════════════════════════════
function renderDepts() {
  const map = {};
  allCandidates.forEach(c => {
    if (!c.dept) return;
    if (!map[c.dept]) map[c.dept] = { total: 0, sel: 0, rej: 0, hold: 0 };
    map[c.dept].total++;
    if (c.status === "Selected") map[c.dept].sel++;
    else if (c.status === "Rejected") map[c.dept].rej++;
    else map[c.dept].hold++;
  });

  const grid = document.getElementById("dept-grid");
  grid.innerHTML = Object.entries(map).map(([d, v]) => `
    <div class="dept-card" onclick="filterDept('${d}')">
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
}

window.filterDept = function(dept) {
  showPage("candidates");
  document.getElementById("f-dept").value = dept;
  applyFilters();
};

// ═══════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════
function clearForm() {
  ["f-name","f-email","f-phone","f-loc","f-pos","f-exp","f-ctc","f-ectc","f-skills","f-notes"]
    .forEach(id => { document.getElementById(id).value = ""; });
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

window.openEditModal = function(id) {
  const c = allCandidates.find(x => x.id === id);
  if (!c) return;
  clearForm();
  document.getElementById("modal-title").textContent  = "Edit Candidate";
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
};

window.openViewModal = function(id) {
  const c = allCandidates.find(x => x.id === id);
  if (!c) return;
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
  // pre-fill saved values
  document.getElementById("es-pubkey").value   = s?.pubkey    || "";
  document.getElementById("es-service").value  = s?.service   || "";
  document.getElementById("es-template").value = s?.template  || "";
  document.getElementById("es-fromname").value = s?.fromName  || "";

  const banner = document.getElementById("es-connected-banner");
  if (isEmailConnected()) {
    banner.style.display = "flex";
    document.getElementById("es-connected-label").textContent =
      `Gmail connected · ${s.fromName || "EmailJS"}`;
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
  // initialise EmailJS with new key
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

// Initialise EmailJS on page load if already saved
(function initEmailJSOnLoad() {
  const s = getEmailSettings();
  if (s?.pubkey) { try { emailjs.init(s.pubkey); } catch(e) {} }
})();

// ═══════════════════════════════════════════════════════
//  BULK EMAIL
// ═══════════════════════════════════════════════════════
let bulkCurrentStatus = "Selected";
// map email -> candidate (for name personalisation)
let bulkCandidateMap  = {};

window.openBulkEmail = function(status = "Selected") {
  bulkCurrentStatus = status;

  // show/hide Gmail connection banner
  const connected = isEmailConnected();
  document.getElementById("be-account-info").style.display = connected ? "flex" : "none";
  document.getElementById("be-account-warn").style.display = connected ? "none" : "block";
  if (connected) {
    const s = getEmailSettings();
    document.getElementById("be-from-name").textContent = s.fromName || "EmailJS";
  }

  // populate tab counts
  ["Selected", "On Hold", "Rejected"].forEach(s => {
    const cnt = allCandidates.filter(c => c.status === s && c.email).length;
    document.getElementById("be-cnt-" + s).textContent = cnt;
  });

  // activate correct tab
  document.querySelectorAll(".be-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("be-tab-" + status).classList.add("active");

  renderBulkRecipients(status);

  // reset compose + progress
  document.getElementById("be-subject").value      = "";
  document.getElementById("be-body").value         = "";
  document.getElementById("be-progress-wrap").style.display = "none";
  document.getElementById("be-send-btn").disabled  = false;
  document.getElementById("be-cancel-btn").textContent = "Cancel";

  document.getElementById("modal-bulk-email").classList.add("open");
};

function renderBulkRecipients(status) {
  const candidates = allCandidates.filter(c => c.status === status && c.email);
  const wrap  = document.getElementById("be-recipients");
  const noEl  = document.getElementById("be-no-email");
  const allCk = document.getElementById("be-check-all");

  // rebuild candidate map for name lookup
  bulkCandidateMap = {};
  candidates.forEach(c => { bulkCandidateMap[c.email] = c; });

  if (!candidates.length) {
    wrap.innerHTML         = "";
    noEl.style.display     = "block";
    allCk.checked          = false;
    allCk.disabled         = true;
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

  // Lock UI
  const sendBtn   = document.getElementById("be-send-btn");
  const cancelBtn = document.getElementById("be-cancel-btn");
  sendBtn.disabled       = true;
  sendBtn.textContent    = "Sending…";
  cancelBtn.textContent  = "Close";

  // Show progress
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
    progressFill.style.width   = pct + "%";
    progressText.textContent   = `Sending ${done} of ${total}…`;
    progressPct.textContent    = pct + "%";
  }

  function logLine(email, ok, err) {
    const div = document.createElement("div");
    div.className = "be-log-line " + (ok ? "be-log-ok" : "be-log-err");
    div.textContent = (ok ? "✅ " : "❌ ") + email + (err ? ` — ${err}` : "");
    progressLog.appendChild(div);
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  // Send one by one with a small delay to avoid rate limits
  for (const email of emails) {
    const candidate = bulkCandidateMap[email] || {};
    const name      = candidate.name || "Candidate";
    // Replace {{name}} placeholder in body
    const personalBody = body.replace(/\{\{name\}\}/gi, name);

    const params = {
      to_email: email,
      to_name:  name,
      subject:  subject,
      message:  personalBody,
      from_name: settings.fromName || "TalentFlow HR",
    };

    try {
      await emailjs.send(settings.service, settings.template, params);
      sent++;
      logLine(email, true);
    } catch(e) {
      failed++;
      logLine(email, false, e?.text || e?.message || "Error");
    }
    updateProgress();
    // 300ms gap between sends to respect EmailJS rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  // Done
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
    const p = document.createElement("div");
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
      box-shadow:0 0 ${sz * 2}px ${sz}px ${col.replace("1)", ".4)")};
    `;
    canvas.appendChild(p);
  }
}

// ═══════════════════════════════════════════════════════
//  FORM IMPORT — copy Apps Script to clipboard
// ═══════════════════════════════════════════════════════
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
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Apps Script copied! ✅", "ok");
  });
};

