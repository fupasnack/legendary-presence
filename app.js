// app.js — seluruh logic digabung: Auth, Role Guard, Firestore, Cloudinary, UI, Notifikasi, PWA

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyA-xV3iuv-KAE_-xhiXZSPCTn54EgYUD40",
  authDomain: "presensi-online-f0964.firebaseapp.com",
  projectId: "presensi-online-f0964",
  storageBucket: "presensi-online-f0964.firebasestorage.app",
  messagingSenderId: "895308244103",
  appId: "1:895308244103:web:ab240a8be762a44f49c422",
  measurementId: "G-E9C7760C2S"
};

// Cloudinary
const CLOUD_NAME = "dn2o2vf04";
const UPLOAD_PRESET = "presensi_unsigned";

// UID roles (tetap di sisi klien sesuai permintaanmu)
const ADMIN_UIDS = new Set([
  "odO8ZtMgTKeao0SDuy9L3gUmkx02", // annisa@fupa.id
  "ujHnWTnftGh6scTI8cQyN8fhmOB2"  // karomi@fupa.id
]);
const KARYAWAN_UIDS = new Set([
  "HD4EsoL2ykgwQeBl6RP1WfrcCKw1", // cabang1@fupa.id
  "FD69ceLyhqedlBfhbLb2I0TljY03", // cabang2@fupa.id
  "h5aw8ppJSgP9PQM0Oc2HtugUAH02"  // cabang3@fupa.id
]);

// Inisialisasi Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Util UI
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const toast = (msg) => {
  const t = $("#toast");
  if (!t) return alert(msg);
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 2200);
};

// PWA register SW
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js");
  });
}

// Notifikasi browser (tanpa FCM, pakai Notification API murni)
async function ensureNotificationPermission() {
  try {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission !== "denied") {
      const res = await Notification.requestPermission();
      return res === "granted";
    }
    return false;
  } catch { return false; }
}
function notify(msg) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") new Notification("Presensi FUPA", { body: msg });
}

// Dapatkan server time via Firestore serverTimestamp comparator
async function getServerTime() {
  const docRef = db.collection("_meta").doc("_srv");
  await docRef.set({ t: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const snap = await docRef.get();
  const ts = snap.get("t");
  return ts ? ts.toDate() : new Date(); // fallback
}
function fmtDateTime(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtHM(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function sameYMD(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

// Aturan hari & jam
// - Minggu default non-presensi kecuali dipaksa admin
// - Berangkat: 04:30–05:30
// - Pulang: 10:00–11:00
// - Toleransi terlambat: 30 menit setelah awal window -> status "terlambat" jika upload di <= akhir window + 30
const WINDOW = {
  berangkat: { start: {h:4,m:30}, end:{h:5,m:30} },
  pulang:    { start: {h:10,m:0}, end:{h:11,m:0} }
};
function inWindow(d, jenis, extraLateMin=30) {
  const w = WINDOW[jenis];
  const start = new Date(d); start.setHours(w.start.h, w.start.m, 0, 0);
  const end = new Date(d);   end.setHours(w.end.h,   w.end.m,   0, 0);
  const lateEnd = new Date(end.getTime() + extraLateMin*60000);
  if (d < start) return {allowed:false, status:"dilarang"};
  if (d >= start && d <= end) return {allowed:true, status:"tepat"};
  if (d > end && d <= lateEnd) return {allowed:true, status:"terlambat"};
  return {allowed:false, status:"dilarang"};
}

async function getScheduleOverride(dateYMD) {
  // admin menulis ke _settings/today: { mode: "auto"|"forceOn"|"forceOff", date: "YYYY-MM-DD" }
  const doc = await db.collection("_settings").doc("today").get();
  if (doc.exists) {
    const d = doc.data();
    if (d.date === dateYMD) return d.mode; // mode khusus untuk hari ini
  }
  return "auto";
}

function ymd(d){
  const pad = (n) => n.toString().padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// Role guard
function redirectByRole(uid, pathIfAdmin, pathIfKaryawan) {
  if (ADMIN_UIDS.has(uid)) {
    if (!location.pathname.endsWith(pathIfAdmin)) location.href = pathIfAdmin;
  } else if (KARYAWAN_UIDS.has(uid)) {
    if (!location.pathname.endsWith(pathIfKaryawan)) location.href = pathIfKaryawan;
  } else {
    auth.signOut();
    toast("Akses ditolak: akun belum diberi peran yang benar.");
  }
}
function guardPage(uid, required) {
  const isAdmin = ADMIN_UIDS.has(uid);
  const isKaryawan = KARYAWAN_UIDS.has(uid);
  if (required === "admin" && !isAdmin) { location.href = "index.html"; return false; }
  if (required === "karyawan" && !isKaryawan) { location.href = "index.html"; return false; }
  return true;
}

// Auto bootstrap koleksi & dokumen penting tanpa setup manual
async function bootstrapCollections(user) {
  // users profile doc
  const up = db.collection("users").doc(user.uid);
  await up.set({
    email: user.email || "",
    role: ADMIN_UIDS.has(user.uid) ? "admin" : (KARYAWAN_UIDS.has(user.uid) ? "karyawan" : "unknown"),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // meta server tick
  await db.collection("_meta").doc("_srv").set({ t: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

  // settings today default
  const todayDoc = db.collection("_settings").doc("today");
  if (!(await todayDoc.get()).exists) {
    await todayDoc.set({ mode:"auto", date: ymd(new Date()) });
  }
}

// Auth routing untuk semua halaman
auth.onAuthStateChanged(async (user) => {
  const path = location.pathname.toLowerCase();
  if (!user) {
    // Cegah akses langsung
    if (path.endsWith("karyawan.html") || path.endsWith("admin.html")) {
      location.href = "index.html";
    }
    // halaman login tidak butuh apa-apa
    if (path.endsWith("index.html") || path.endsWith("/")) {
      bindLoginPage();
    }
    return;
  }

  await bootstrapCollections(user);

  // Update server time live
  startServerClock("#serverTime");

  // Routing per halaman
  if (path.endsWith("index.html") || path.endsWith("/")) {
    // Setelah login, arahkan sesuai role
    redirectByRole(user.uid, "admin.html", "karyawan.html");
    return;
  }

  if (path.endsWith("karyawan.html")) {
    if (!guardPage(user.uid, "karyawan")) return;
    await ensureNotificationPermission();
    bindKaryawanPage(user);
  }

  if (path.endsWith("admin.html")) {
    if (!guardPage(user.uid, "admin")) return;
    await ensureNotificationPermission();
    bindAdminPage(user);
  }
});

// Halaman login
function bindLoginPage() {
  const loginBtn = $("#loginBtn");
  if (!loginBtn) return;
  loginBtn.onclick = async () => {
    const email = $("#email").value.trim();
    const pass = $("#password").value.trim();
    if (!email || !pass) { toast("Isi email dan kata sandi."); return; }
    try {
      await auth.signInWithEmailAndPassword(email, pass);
      // onAuthStateChanged akan redirect by role
    } catch (e) {
      toast("Gagal masuk. Periksa kembali kredensial.");
    }
  };
}

// Jam server live
async function startServerClock(sel) {
  const el = $(sel);
  if (!el) return;
  const tick = async () => {
    try {
      const t = await getServerTime();
      el.textContent = `Waktu server: ${fmtDateTime(t)} WIB`;
    } catch {
      el.textContent = `Waktu server: tidak tersedia`;
    }
  };
  await tick();
  setInterval(tick, 10_000);
}

// Ambil lokasi
function getLocation(timeout=8000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Geolokasi tidak didukung."));
    navigator.geolocation.getCurrentPosition(
      (pos) => res({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => rej(err),
      { enableHighAccuracy:true, timeout, maximumAge: 2_000 }
    );
  });
}

// Kamera
async function startCamera(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  } catch (e) {
    toast("Tidak bisa mengakses kamera.");
    throw e;
  }
}
function captureToCanvas(videoEl, canvasEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  const MAXW = 720; // kurangi ukuran
  const scale = Math.min(1, MAXW / w);
  canvasEl.width = Math.round(w * scale);
  canvasEl.height = Math.round(h * scale);
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
}

// Kompres gambar ke kualitas kecil (jpeg 0.5 -> 0.3)
async function canvasToCompressedBlob(canvas, targetKB=80) {
  let quality = 0.6;
  let blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  // jika > target kb, turunkan quality
  for (let i=0; i<3 && blob.size/1024 > targetKB; i++) {
    quality = Math.max(0.3, quality - 0.1);
    blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  }
  return blob;
}

// Upload ke Cloudinary unsigned
async function uploadToCloudinary(file) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`;
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", UPLOAD_PRESET);
  const r = await fetch(url, { method:"POST", body: form });
  if (!r.ok) throw new Error("Upload Cloudinary gagal");
  const data = await r.json();
  return data.secure_url;
}

// Simpan presensi
async function savePresensi({ uid, nama, jenis, status, lat, lng, selfieUrl, serverDate }) {
  const ts = serverDate || new Date();
  const doc = {
    uid, nama: nama || "", jenis, status,
    lat, lng,
    selfieUrl: selfieUrl || "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    localTime: fmtDateTime(ts),
    ymd: ymd(ts)
  };
  await db.collection("presensi").add(doc);
}

// Ambil riwayat singkat karyawan
function subscribeRiwayat(uid, cb) {
  return db.collection("presensi")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(10)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      cb(arr);
    });
}

// Notifikasi list untuk karyawan (pengumuman + progres cuti)
function subscribeNotifForKaryawan(uid, cb) {
  return db.collection("notifs")
    .where("targets", "array-contains-any", ["all", uid])
    .orderBy("createdAt", "desc")
    .limit(20)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      cb(arr);
    });
}

// Cuti collection
async function ajukanCuti(uid, nama, jenis, tanggal, catatan) {
  await db.collection("cuti").add({
    uid, nama, jenis, tanggal, catatan: catatan || "",
    status: "menunggu",
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Admin list cuti
function subscribeCuti(cb) {
  return db.collection("cuti")
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      cb(arr);
    });
}
async function setCutiStatus(id, status) {
  await db.collection("cuti").doc(id).set({ status }, { merge:true });
}

// Pengumuman
async function kirimPengumuman(text, adminUid) {
  await db.collection("notifs").add({
    type: "announce",
    text,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    from: adminUid,
    targets: ["all"]
  });
  notify("Pengumuman terkirim ke semua karyawan.");
}

// Jadwal wajib
async function setHariMode(mode, dateStr) {
  await db.collection("_settings").doc("today").set({
    mode, date: dateStr
  }, { merge: true });
}

// Profil simpan (nama, alamat, foto profil -> Cloudinary)
async function saveProfile(uid, { nama, alamat, pfpUrl }) {
  const d = {};
  if (nama !== undefined) d.nama = nama;
  if (alamat !== undefined) d.alamat = alamat;
  if (pfpUrl !== undefined) d.pfp = pfpUrl;
  d.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection("users").doc(uid).set(d, { merge: true });
}

// Ambil profil
async function getProfile(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : {};
}

// Halaman Karyawan bindings
async function bindKaryawanPage(user) {
  const video = $("#cam");
  const canvas = $("#canvas");
  const preview = $("#preview");
  const jenisSel = $("#jenis");
  const statusText = $("#statusText");
  const statusChip = $("#statusChip");
  const locText = $("#locText");

  // Guard kamera
  const stream = await startCamera(video);

  // Lokasi
  let coords = null;
  try {
    coords = await getLocation();
    locText.textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
  } catch {
    locText.textContent = "Lokasi tidak aktif";
  }

  // Profil muat
  const profile = await getProfile(user.uid);
  if (profile.pfp) $("#pfp").src = profile.pfp;
  if (profile.nama) $("#nama").value = profile.nama;
  if (profile.alamat) $("#alamat").value = profile.alamat;

  // Status window
  async function refreshStatus() {
    const serverNow = await getServerTime();
    const today = ymd(serverNow);
    const override = await getScheduleOverride(today);
    const isSunday = serverNow.getDay() === 0;
    const jenis = jenisSel.value;

    let wajib = true;
    if (override === "forceOn") wajib = true;
    else if (override === "forceOff") wajib = false;
    else wajib = !isSunday;

    if (!wajib) {
      statusText.textContent = "Hari ini tidak wajib presensi";
      statusChip.className = "status s-warn";
      return { allowed: false, reason:"not-required" };
    }

    const win = inWindow(serverNow, jenis, 30);
    if (!win.allowed) {
      statusText.textContent = "Di luar jam presensi";
      statusChip.className = "status s-bad";
      return { allowed:false, reason:"out-of-window" };
    } else {
      statusText.textContent = win.status === "tepat" ? "Tepat waktu" : "Terlambat";
      statusChip.className = "status " + (win.status === "tepat" ? "s-good" : "s-warn");
      return { allowed:true, status:win.status, serverNow };
    }
  }
  let lastStatus = await refreshStatus();
  setInterval(async () => { lastStatus = await refreshStatus(); }, 30_000);

  // Snap
  $("#snapBtn").onclick = () => {
    captureToCanvas(video, canvas);
    canvas.style.display = "block";
    preview.style.display = "none";
    toast("Foto diambil. Anda bisa langsung upload.");
  };

  // Upload
  $("#uploadBtn").onclick = async () => {
    // Periksa status window lagi
    lastStatus = await refreshStatus();
    if (!lastStatus.allowed) {
      toast("Presensi ditolak: di luar jadwal atau tidak wajib.");
      return;
    }
    if (!coords) {
      toast("Lokasi belum aktif.");
      return;
    }
    // Pastikan ada gambar di canvas
    if (canvas.width === 0 || canvas.height === 0) {
      toast("Ambil selfie dulu.");
      return;
    }
    try {
      const blob = await canvasToCompressedBlob(canvas, 80);
      const url = await uploadToCloudinary(blob);
      preview.src = url;
      preview.style.display = "block";
      // Simpan presensi
      const nama = ($("#nama")?.value || profile.nama || user.email.split("@")[0]).trim();
      const jenis = jenisSel.value;
      const status = lastStatus.status === "tepat" ? "tepat" : "terlambat";
      await savePresensi({
        uid: user.uid,
        nama,
        jenis,
        status,
        lat: coords.lat,
        lng: coords.lng,
        selfieUrl: url,
        serverDate: lastStatus.serverNow
      });
      toast("Presensi tersimpan.");
      notify(`Presensi ${jenis} tercatat (${status}).`);
    } catch (e) {
      toast("Gagal menyimpan presensi.");
    }
  };

  // Riwayat singkat
  const unsubLog = subscribeRiwayat(user.uid, (items) => {
    const list = $("#logList");
    list.innerHTML = "";
    items.forEach(it => {
      const badge = it.status === "tepat" ? "s-good" : (it.status==="terlambat"?"s-warn":"s-bad");
      const el = document.createElement("div");
      el.className = "row";
      el.style.justifyContent = "space-between";
      el.innerHTML = `
        <div class="row" style="gap:8px">
          <span class="material-symbols-rounded">schedule</span>
          <b>${it.localTime}</b>
          <span>•</span>
          <span>${it.jenis}</span>
        </div>
        <span class="status ${badge}">${it.status}</span>
      `;
      list.appendChild(el);
    });
  });

  // Notifikasi dialog
  $("#notifBtn").onclick = () => $("#notifDlg").showModal();
  const unsubNotif = subscribeNotifForKaryawan(user.uid, (items) => {
    const list = $("#notifList");
    list.innerHTML = "";
    items.forEach(it => {
      const el = document.createElement("div");
      el.className = "card";
      const sub = it.type === "announce" ? "Pengumuman" : "Info";
      el.innerHTML = `
        <div style="font-weight:700">${sub}</div>
        <div style="opacity:.8; margin-top:4px">${it.text || "(tanpa teks)"}</div>
      `;
      list.appendChild(el);
    });
  });

  // Cuti FAB
  $("#cutiFab").onclick = () => $("#cutiDlg").showModal();
  $("#ajukanCutiBtn").onclick = async () => {
    const jenis = $("#cutiJenis").value;
    const tanggal = $("#cutiTanggal").value;
    const catatan = $("#cutiCatatan").value.trim();
    if (!tanggal) { toast("Pilih tanggal cuti."); return; }
    const nama = ($("#nama")?.value || profile.nama || user.email.split("@")[0]).trim();
    await ajukanCuti(user.uid, nama, jenis, tanggal, catatan);
    toast("Permintaan cuti dikirim.");
    notify("Permintaan cuti terkirim.");
    $("#cutiDlg").close();
  };

  // Profil dialog
  $("#profileBtn").onclick = () => $("#profileDlg").showModal();
  $("#saveProfileBtn").onclick = async () => {
    try {
      let pfpUrl;
      const file = $("#pfpFile").files?.[0];
      if (file) {
        // kompres
        const img = await file.arrayBuffer();
        const blob = new Blob([img]);
        // Untuk kompres file, gunakan canvas perantara
        const imgEl = document.createElement("img");
        imgEl.src = URL.createObjectURL(file);
        await new Promise(r => imgEl.onload = r);
        const c = document.createElement("canvas");
        const scale = Math.min(1, 512 / Math.max(imgEl.width, imgEl.height));
        c.width = Math.max(64, Math.round(imgEl.width * scale));
        c.height = Math.max(64, Math.round(imgEl.height * scale));
        const ctx = c.getContext("2d");
        ctx.drawImage(imgEl, 0, 0, c.width, c.height);
        const pfpBlob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.7));
        pfpUrl = await uploadToCloudinary(pfpBlob);
        $("#pfp").src = pfpUrl;
      }
      const nama = $("#nama").value.trim();
      const alamat = $("#alamat").value.trim();
      await saveProfile(user.uid, { nama, alamat, pfpUrl });
      toast("Profil tersimpan.");
      notify("Profil berhasil diperbarui.");
    } catch {
      toast("Gagal menyimpan profil.");
    }
  };
  $("#logoutBtn").onclick = async () => { await auth.signOut(); location.href = "index.html"; };

  // Bersihkan stream saat keluar
  window.addEventListener("beforeunload", () => {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    unsubLog && unsubLog();
    unsubNotif && unsubNotif();
  });
}

// Halaman Admin bindings
function toCSV(rows, columns) {
  const esc = (v) => `"${(v ?? "").toString().replace(/"/g,'""')}"`;
  const header = columns.map(esc).join(",");
  const body = rows.map(r => columns.map(k => esc(r[k])).join(",")).join("\n");
  return header + "\n" + body;
}
function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type:"text/csv"}));
  a.download = filename;
  a.click();
}

async function bindAdminPage(user) {
  // Profil muat
  const profile = await getProfile(user.uid);
  if (profile.pfp) $("#pfp").src = profile.pfp;
  if (profile.nama) $("#nama").value = profile.nama;
  if (profile.alamat) $("#alamat").value = profile.alamat;

  // Dialogs
  $("#profileBtn").onclick = () => $("#profileDlg").showModal();
  $("#logoutBtn").onclick = async () => { await auth.signOut(); location.href="index.html"; };

  // Simpan profil
  $("#saveProfileBtn").onclick = async () => {
    try {
      let pfpUrl;
      const file = $("#pfpFile").files?.[0];
      if (file) {
        const imgEl = document.createElement("img");
        imgEl.src = URL.createObjectURL(file);
        await new Promise(r => imgEl.onload = r);
        const c = document.createElement("canvas");
        const scale = Math.min(1, 512 / Math.max(imgEl.width, imgEl.height));
        c.width = Math.max(64, Math.round(imgEl.width * scale));
        c.height = Math.max(64, Math.round(imgEl.height * scale));
        const ctx = c.getContext("2d");
        ctx.drawImage(imgEl, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.7));
        pfpUrl = await uploadToCloudinary(blob);
        $("#pfp").src = pfpUrl;
      }
      const nama = $("#nama").value.trim();
      const alamat = $("#alamat").value.trim();
      await saveProfile(user.uid, { nama, alamat, pfpUrl });
      toast("Profil admin tersimpan.");
      notify("Profil admin diperbarui.");
    } catch {
      toast("Gagal menyimpan profil admin.");
    }
  };

  // Notifikasi (cuti)
  $("#notifBtn").onclick = () => $("#notifDlg").showModal();
  const cutiList = $("#cutiList");
  const unsubCuti = subscribeCuti((items) => {
    cutiList.innerHTML = "";
    items.forEach(it => {
      const row = document.createElement("div");
      row.className = "card";
      row.innerHTML = `
        <div class="row" style="justify-content:space-between">
          <div class="row">
            <span class="material-symbols-rounded">person</span><b>${it.nama || it.uid}</b>
            <span>•</span>
            <span>${it.jenis}</span>
            <span>•</span>
            <span>${it.tanggal}</span>
          </div>
          <div class="row">
            <span class="status ${it.status==='menunggu'?'s-warn':(it.status==='disetujui'?'s-good':'s-bad')}">${it.status}</span>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end; margin-top:8px">
          <button class="btn" data-act="approve" data-id="${it.id}"><span class="material-symbols-rounded">check</span> Setujui</button>
          <button class="btn" data-act="reject" data-id="${it.id}" style="background:#222"><span class="material-symbols-rounded">close</span> Tolak</button>
        </div>
      `;
      cutiList.appendChild(row);
    });
    // Bind actions
    $$("[data-act='approve']").forEach(b => b.onclick = async () => {
      await setCutiStatus(b.dataset.id, "disetujui");
      toast("Cuti disetujui.");
      notify("Ada cuti disetujui.");
    });
    $$("[data-act='reject']").forEach(b => b.onclick = async () => {
      await setCutiStatus(b.dataset.id, "ditolak");
      toast("Cuti ditolak.");
      notify("Ada cuti ditolak.");
    });
  });

  // Pengumuman
  $("#announceFab").onclick = async () => {
    const text = prompt("Tulis pengumuman:");
    if (!text) return;
    await kirimPengumuman(text, user.uid);
    toast("Pengumuman terkirim.");
  };
  $("#sendAnnounce").onclick = async () => {
    const text = $("#announceText").value.trim();
    if (!text) { toast("Tulis isi pengumuman."); return; }
    await kirimPengumuman(text, user.uid);
    $("#announceText").value = "";
    toast("Pengumuman terkirim.");
  };

  // Jadwal wajib / tidak
  $("#saveSchedule").onclick = async () => {
    const mode = $("#wajibHari").value;
    const now = await getServerTime();
    await setHariMode(mode, ymd(now));
    toast("Pengaturan hari tersimpan.");
  };

  // Tabel presensi + filter + export CSV
  let lastData = [];
  async function loadPresensi() {
    let q = db.collection("presensi").orderBy("createdAt", "desc").limit(500);
    const nama = $("#fNama").value.trim().toLowerCase();
    const tanggal = $("#fTanggal").value;
    // Firestore tidak bisa compound query yang fleksibel untuk text, maka filter di klien setelah pengambilan
    const snap = await q.get();
    const arr = [];
    snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
    let filtered = arr;
    if (tanggal) filtered = filtered.filter(x => x.ymd === tanggal);
    if (nama) filtered = filtered.filter(x => (x.nama||"").toLowerCase().includes(nama));
    lastData = filtered;
    renderTable(filtered);
  }
  function renderTable(rows) {
    const tb = $("#tableBody");
    tb.innerHTML = "";
    rows.forEach(r => {
      const badge = r.status === "tepat" ? "s-good" : (r.status==="terlambat"?"s-warn":"s-bad");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.localTime || ""}</td>
        <td>${r.nama || r.uid}</td>
        <td>${r.jenis}</td>
        <td><span class="status ${badge}">${r.status}</span></td>
        <td>${(r.lat?.toFixed?.(5) || r.lat || "")}, ${(r.lng?.toFixed?.(5) || r.lng || "")}</td>
        <td>${r.selfieUrl ? `<a href="${r.selfieUrl}" target="_blank">Lihat</a>` : "-"}</td>
      `;
      tb.appendChild(tr);
    });
  }
  $("#applyFilter").onclick = () => loadPresensi();
  $("#exportCsv").onclick = () => {
    if (!lastData.length) { toast("Tidak ada data untuk diekspor."); return; }
    const cols = ["localTime","nama","jenis","status","lat","lng","selfieUrl","uid","ymd"];
    const csv = toCSV(lastData, cols);
    download(`presensi_${Date.now()}.csv`, csv);
  };
  // Muat awal + refresh periodik ringan
  await loadPresensi();
  setInterval(loadPresensi, 20_000);

  // Create akun karyawan (tanpa logout admin)
  // Trik: buat second app instance untuk createUser supaya sesi admin tetap
  const secondApp = firebase.apps.length > 1 ? firebase.apps[1] : firebase.initializeApp(firebaseConfig, "second");
  const secondAuth = secondApp.auth();

  $("#createUserBtn").onclick = async () => {
    const email = $("#newEmail").value.trim();
    const pass = $("#newPass").value.trim();
    if (!email || !pass) { toast("Isi email dan kata sandi."); return; }
    try {
      const cred = await secondAuth.createUserWithEmailAndPassword(email, pass);
      const uid = cred.user.uid;
      await db.collection("users").doc(uid).set({
        email, role:"karyawan", createdBy: user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
      // Kembalikan secondAuth ke kosong signOut agar tidak mengganggu
      await secondAuth.signOut();
      toast("Akun karyawan dibuat.");
      notify("Akun karyawan baru telah dibuat.");
    } catch (e) {
      toast("Gagal membuat akun karyawan.");
    }
  };

  // Bersih
  window.addEventListener("beforeunload", () => {
    unsubCuti && unsubCuti();
  });
}