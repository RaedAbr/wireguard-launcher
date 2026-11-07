"use strict";

const REGIONS = [
  ["Australia","Sydney","ap-southeast-2",0],["Australia","Melbourne","ap-southeast-4",1],["Brazil","Sao Paulo","sa-east-1",0],
  ["Canada","Montreal","ca-central-1",0],["Canada","Calgary","ca-west-1",1],["France","Paris","eu-west-3",0],
  ["Germany","Frankfurt","eu-central-1",0],["Hong Kong","","ap-east-1",1],["India","Mumbai","ap-south-1",0],
  ["India","Hyderabad","ap-south-2",1],["Indonesia","Jakarta","ap-southeast-3",1],["Ireland","Dublin","eu-west-1",0],
  ["Israel","Tel Aviv","il-central-1",1],["Italy","Milan","eu-south-1",1],["Japan","Tokyo","ap-northeast-1",0],
  ["Japan","Osaka","ap-northeast-3",0],["Malaysia","Kuala Lumpur","ap-southeast-5",1],["Mexico","Queretaro","mx-central-1",1],
  ["New Zealand","Auckland","ap-southeast-6",1],["Singapore","","ap-southeast-1",0],["South Africa","Cape Town","af-south-1",1],
  ["South Korea","Seoul","ap-northeast-2",0],["Spain","Madrid","eu-south-2",1],["Sweden","Stockholm","eu-north-1",0],
  ["Switzerland","Zurich","eu-central-2",1],["Taiwan","Taipei","ap-east-2",1],["Thailand","Bangkok","ap-southeast-7",1],
  ["UAE","Dubai","me-central-1",1],["UK","London","eu-west-2",0],["USA","N. Virginia","us-east-1",0],
  ["USA","Ohio","us-east-2",0],["USA","N. California","us-west-1",0],["USA","Oregon","us-west-2",0]
].map(([country, city, id, optIn]) => ({ country, city, id, optIn: !!optIn }));

const TEMPLATE = document.querySelector('meta[name="wgl-template"]')?.content || "";
const LIVE = !!TEMPLATE;
const STEPS = ["Country", "Review", "AWS", "Connect"];
const STORE_KEY = "wgl.vpns";
const SAMPLE_KEY = "SAMPLE-KEY-SHOWN-IN-THE-PREVIEW-ONLY";
const RESOURCES = [
  ["VPN server", "t3.micro, Ubuntu 26.04, 8 GB disk, with a public IPv4 address"],
  ["Private network", "A network, gateway and route, kept apart from anything else in your account"],
  ["Firewall", "Opens only UDP port 51820 for WireGuard. SSH stays closed."],
  ["Timer", "A small function that checks every 15 minutes and deletes this VPN when its time is up"],
  ["Timer role", "Lets the timer delete this VPN. It has no password or access keys."]
];

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = id => document.getElementById(id);
const view = $("view");
const state = { step: 0, region: REGIONS.find(r => r.id === "eu-west-3"), amount: 4, unit: "hours", filter: "", current: null, sheet: null, error: "", notice: "", memory: [] };

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const place = r => r.city ? `${r.country} (${r.city})` : r.country;
const regionOf = id => REGIONS.find(r => r.id === id) || { country: id, city: "", id, optIn: false };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/* Durations are in minutes, shown as their two largest units. */
const span = m => {
  const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), min = m % 60;
  return [d ? plural(d, "day") : "", h ? plural(h, "hour") : "", min && !d ? plural(min, "minute") : ""]
    .filter(Boolean).join(" ") || "less than a minute";
};
const UNITS = { minutes: { size: 1, min: 15, max: 180, step: 5 }, hours: { size: 60, min: 1, max: 72, step: 1 }, days: { size: 1440, min: 1, max: 30, step: 1 } };
const minutesChosen = () => state.amount * UNITS[state.unit].size;
const minutesLeft = v => Math.max(0, Math.floor((v.startedAt + v.minutes * 60 - Date.now() / 1000) / 60));
const stackName = id => `wireguard-vpn-${id}`;
const consoleHome = id => `https://${id}.console.aws.amazon.com/cloudformation/home?region=${id}`;
const stacksLink = id => `${consoleHome(id)}#/stacks?filteringText=${stackName(id)}&filteringStatus=active&viewNested=true`;

/* ---- Saved VPNs: kept in this browser only ---- */
function load() {
  if (!LIVE) return state.memory;
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; }
}
function save(list) {
  if (!LIVE) { state.memory = list; return; }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }
  catch (e) { throw new Error("This browser won't save your VPN key. Turn off private browsing and try again."); }
}
/* A finished VPN has deleted itself, so its entry and private key have no further use. */
function vpns() {
  const now = Date.now() / 1000, list = load();
  const kept = list.filter(v => v.minutes && v.startedAt + v.minutes * 60 + 7200 > now);
  if (kept.length !== list.length) { try { save(kept); } catch (e) { /* kept for next time */ } }
  return kept;
}
const vpnIn = id => vpns().find(v => v.region === id);
/* After a reload the page forgets which VPN it showed, so it falls back to the newest one. */
const currentVpn = () => vpnIn(state.current) || vpns().slice(-1)[0];

/* ---- Keys: the private key is made here and never leaves this browser ---- */
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const toUrlSafe = b64 => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrlSafe = s => `${s.replace(/-/g, "+").replace(/_/g, "/")}=`;
async function makeKeys() {
  if (!LIVE) return { publicKey: "A".repeat(43), privateKey: SAMPLE_KEY };
  if (!crypto.subtle) throw new Error("Open this page over https to create your key.");
  let pair;
  try { pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]); }
  catch (e) { throw new Error("This browser is too old to create a WireGuard key. Update it and try again."); }
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey: toUrlSafe(toBase64(pub)), privateKey: toBase64(pkcs8.slice(-32)) };
}

function createLink(v) {
  const page = location.origin + location.pathname;
  const q = [
    ["templateURL", TEMPLATE], ["stackName", stackName(v.region)], ["param_ClientPublicKey", v.publicKey],
    ["param_Minutes", v.minutes], ["param_PageUrl", page]
  ].map(([k, val]) => `${k}=${encodeURIComponent(val)}`).join("&");
  return `${consoleHome(v.region)}#/stacks/create/review?${q}`;
}

/* ---- Moving between screens ---- */
function swap(change) {
  if (document.startViewTransition && !reduced) document.startViewTransition(change);
  else change();
}
function focusTop() {
  const h = view.querySelector("h1");
  if (h) h.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
/* Each step has its own address, so the browser's Back button returns to the previous step. */
const ROUTES = ["start", "review", "finish", "ready"];
function go(step) {
  state.sheet = null;
  if (location.hash === `#${ROUTES[step]}`) swap(showScreen);
  else location.hash = ROUTES[step];
}
/* For screens that can't be shown, so Back doesn't land on them again. */
function redirect(step) {
  location.replace(`#${ROUTES[step]}`);
}
function showScreen() {
  const name = location.hash.slice(1), step = ROUTES.indexOf(name);
  state.sheet = name === "delete" ? state.deleting : null;
  if (name === "delete" && !state.sheet) return redirect(0);
  if (step >= 0) state.step = step;
  const flow = step >= 0 || name === "delete";
  $("home").hidden = flow;
  $("flow").hidden = !flow;
  if (flow) { render(); focusTop(); } else { renderHomeFleet(); window.scrollTo(0, 0); }
}
function renderRoute() {
  $("route").innerHTML = STEPS.map((s, i) =>
    `<li class="${i < state.step ? "done" : i === state.step ? "now" : ""}"${i === state.step ? ' aria-current="step"' : ""}><i></i>${s}</li>`).join("");
}
const errorBox = () => state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : "";
const oneDevice = `<p class="note"><b>One VPN, one device.</b> This VPN works on this device only. For another device, start a separate VPN from that device, in a different country.</p>`;

/* ---- Your VPNs ---- */
function fleet() {
  const list = vpns();
  if (!list.length) return "";
  const notice = state.notice;
  state.notice = "";
  const rows = list.map(v => {
    const ready = !!v.ip;
    return `<div class="server">
      <div class="server-top"><b>${esc(place(regionOf(v.region)))}</b><span class="status${ready ? "" : " off"}">${ready ? "Ready" : "Waiting for AWS"}</span></div>
      <p class="small">${ready ? `Removes itself in about ${span(minutesLeft(v))}` : "Finish in AWS, then tap the link in the Outputs tab."}</p>
      <div class="actions">
        ${ready ? `<button class="mini" data-act="details" data-id="${v.region}">Connection details</button>`
                : `<button class="mini" data-act="continue" data-id="${v.region}">Continue</button>`}
        <button class="mini danger" data-act="delete" data-id="${v.region}">Delete now</button>
      </div>
    </div>`;
  }).join("");
  return `<section class="panel" aria-label="Your VPNs">
    <div class="fleet-head"><h2>Your VPNs</h2><span class="small">Started in this browser</span></div>
    ${notice ? `<p class="msg" role="status">${esc(notice)}</p>` : ""}
    <div>${rows}</div>
  </section>`;
}
function renderHomeFleet() {
  const box = $("fleet-home"), html = fleet();
  box.innerHTML = html;
  box.hidden = !html;
}

function deleteSheet() {
  const v = vpnIn(state.sheet);
  if (!v) { state.sheet = null; return render(); }
  const where = esc(place(regionOf(v.region)));
  view.innerHTML = `
    <h1 tabindex="-1">Delete your VPN in ${where}</h1>
    <p class="lead">This page can't reach your AWS account, so you delete it there. It takes about a minute.</p>
    <ol class="how panel">
      <li>Open AWS and sign in.</li>
      <li>Select <code>${stackName(v.region)}</code>.</li>
      <li>Choose <b>Delete</b>, then confirm.</li>
    </ol>
    <p class="small">AWS removes the server, disk, firewall and network, with nothing left to pay for. You can't undo this.</p>
    <div class="actions">
      ${LIVE ? `<a class="btn wide" href="${esc(stacksLink(v.region))}" target="_blank" rel="noopener">Open AWS</a>`
             : `<button class="btn wide" data-act="noop">Open AWS</button>`}
    </div>
    <p class="msg" id="sheet-msg" role="status"></p>
    <div class="actions">
      <button class="quiet" data-act="cancel">Keep it</button>
      <button class="quiet" data-act="forget" data-id="${v.region}">It's deleted, remove from this list</button>
    </div>`;
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === "details") { state.current = id; go(3); }
  else if (act === "continue") { state.current = id; go(2); }
  else if (act === "delete") { state.error = ""; state.deleting = id; location.hash = "delete"; }
  else if (act === "cancel") history.back();
  else if (act === "noop") $("sheet-msg").textContent = "The real page opens your AWS CloudFormation page here.";
  else if (act === "forget") {
    save(vpns().filter(v => v.region !== id));
    state.notice = `Removed ${regionOf(id).country} from this list.`;
    redirect(0);
  }
});

/* ---- Step 1: country ---- */
function regionList() {
  const q = state.filter.trim().toLowerCase();
  const hit = REGIONS.filter(r => `${r.country} ${r.city} ${r.id}`.toLowerCase().includes(q));
  const item = r => `<label class="region"><input type="radio" name="region" value="${r.id}"${r.id === state.region.id ? " checked" : ""}><span>${esc(place(r))}</span><span class="code">${r.id}</span></label>`;
  const ready = hit.filter(r => !r.optIn), extra = hit.filter(r => r.optIn);
  if (!hit.length) return `<p class="empty">No AWS region matches "${esc(state.filter)}".</p>`;
  return (ready.length ? `<div class="group">On by default</div>${ready.map(item).join("")}` : "") +
         (extra.length ? `<div class="group">Turn on in AWS first</div>${extra.map(item).join("")}` : "");
}
function country() {
  view.innerHTML = `
    ${fleet()}
    ${errorBox()}
    <h1 tabindex="-1">Where should your VPN come out?</h1>
    <p class="lead">Websites will see you as being in the country you pick.</p>
    <label class="field" for="q">Find a country
      <input id="q" type="search" placeholder="France, Tokyo, eu-west-3" value="${esc(state.filter)}" autocomplete="off">
    </label>
    <div class="regions" id="regions" role="radiogroup" aria-label="Country">${regionList()}</div>
    <div class="field">
      <label for="amount">Delete everything automatically after</label>
      <div class="duration">
        <input id="amount" type="number" inputmode="numeric" min="${UNITS[state.unit].min}" max="${UNITS[state.unit].max}" step="${UNITS[state.unit].step}" value="${state.amount}">
        <select id="unit" aria-label="Unit">${Object.keys(UNITS).map(u => `<option value="${u}"${u === state.unit ? " selected" : ""}>${u}</option>`).join("")}</select>
      </div>
      <p class="small">From 15 minutes to 30 days. You can delete it sooner in AWS.</p>
    </div>
    <div class="actions"><button class="btn wide" id="next">Review ${esc(state.region.country)}</button></div>`;
  const list = $("regions"), next = $("next"), amount = $("amount");
  const clamp = () => {
    const u = UNITS[state.unit];
    Object.assign(amount, { min: u.min, max: u.max, step: u.step });
    state.amount = Math.min(u.max, Math.max(u.min, Math.round(+amount.value) || u.min));
    amount.value = state.amount;
  };
  $("q").addEventListener("input", e => { state.filter = e.target.value; list.innerHTML = regionList(); });
  list.addEventListener("change", e => { state.region = regionOf(e.target.value); next.textContent = `Review ${state.region.country}`; });
  amount.addEventListener("change", clamp);
  $("unit").addEventListener("change", e => {
    const total = minutesChosen();
    state.unit = e.target.value;
    amount.value = Math.round(total / UNITS[state.unit].size);
    clamp();
  });
  next.addEventListener("click", () => { clamp(); state.error = ""; go(1); });
}

/* ---- Step 2: review ---- */
function review() {
  const r = state.region, h = minutesChosen(), max = Math.max(0.01, h / 60 * 0.03).toFixed(2), taken = vpnIn(r.id);
  view.innerHTML = `
    <h1 tabindex="-1">Here's what will happen in your AWS account</h1>
    <p class="lead">Nothing is created until you confirm in AWS.</p>
    ${oneDevice}
    ${r.optIn ? `<p class="note"><b>${esc(place(r))} may be off in your account.</b> If AWS shows an error, turn it on under Account, then AWS Regions. This can take a few minutes.</p>` : ""}
    ${taken?.ip ? `<p class="note">You already have a VPN in ${esc(r.country)}. Delete it first, or pick another country.</p>` : ""}
    ${taken && !taken.ip ? `<p class="note">You started a VPN in ${esc(r.country)} but haven't finished in AWS. Continue where you left off.</p>` : ""}
    ${errorBox()}
    <section class="panel">
      <div class="rows">
        <div class="row"><b>Exit country</b><span>${esc(place(r))}</span></div>
        <div class="row"><b>AWS region</b><span class="code">${r.id}</span></div>
        <div class="row"><b>Deleted after</b><span>${span(h)}</span></div>
      </div>
    </section>
    <section class="stack">
      <h2>Created for you</h2>
      <div class="panel"><div class="rows">${RESOURCES.map(([n, why]) => `<div class="row"><b>${n}</b><small>${why}</small></div>`).join("")}</div></div>
      <details class="fold">
        <summary>What can the timer role do?</summary>
        <p class="small">It can delete this VPN's stack, timer and role, and terminate this VPN's server. To remove the network, AWS also gives it the right to delete networks and firewalls in this region. Its code only ever deletes this VPN.</p>
      </details>
    </section>
    <section class="stack">
      <h2>Estimated cost</h2>
      <div class="panel">
        <p class="cost">About 1 to 3 cents an hour</p>
        <p class="lead">At most about $${max} for ${span(h)}. AWS bills your account directly, and data you use is charged on top.</p>
      </div>
    </section>
    <div class="actions">
      <button class="quiet" id="back">Change</button>
      <button class="btn wide" id="next"${taken?.ip ? " disabled" : ""}>Continue to AWS</button>
    </div>`;
  $("back").addEventListener("click", () => { state.error = ""; go(0); });
  $("next").addEventListener("click", async () => {
    state.error = "";
    if (taken) { state.current = r.id; return go(2); }
    try {
      const keys = await makeKeys();
      save([...vpns(), { region: r.id, minutes: h, startedAt: Math.floor(Date.now() / 1000), ...keys }]);
      state.current = r.id;
      go(2);
    } catch (e) { state.error = e.message; render(); }
  });
}

/* ---- Step 3: AWS ---- */
function aws() {
  const v = currentVpn();
  if (!v) return redirect(0);
  if (v.ip) {
    view.innerHTML = `
      <h1 tabindex="-1">Done in AWS</h1>
      <p class="lead">Your VPN in ${esc(place(regionOf(v.region)))} is ready.</p>
      <div class="actions"><button class="btn wide" id="ready">Show connection details</button></div>`;
    $("ready").addEventListener("click", () => go(3));
    return;
  }
  view.innerHTML = `
    <h1 tabindex="-1">Finish in AWS</h1>
    <p class="lead">AWS opens with everything filled in. Keep this browser, because your key is saved here.</p>
    <ol class="how panel">
      <li>Sign in to your AWS account.</li>
      <li>At the bottom, tick <b>I acknowledge that AWS CloudFormation might create IAM resources</b>.</li>
      <li>Tap <b>Create stack</b>, then wait about 3 minutes for <b>CREATE_COMPLETE</b>.</li>
      <li>Open the <b>Outputs</b> tab and tap the link next to <b>OpenThisLink</b>.</li>
    </ol>
    <div class="actions">
      ${LIVE ? `<a class="btn wide" href="${esc(createLink(v))}" target="_blank" rel="noopener">Open AWS</a>`
             : `<button class="btn wide" id="simulate">Simulate AWS finishing</button>`}
    </div>
    <p class="small">If the link opens another browser, your key won't be there. Open it in this browser instead.</p>
    <div class="actions">
      <button class="quiet" id="to-list">Back to your VPNs</button>
      <button class="quiet" id="cancel">I changed my mind</button>
    </div>`;
  $("to-list").addEventListener("click", () => go(0));
  $("cancel").addEventListener("click", () => { save(vpns().filter(x => x.region !== v.region)); redirect(0); });
  $("simulate")?.addEventListener("click", () => {
    save(vpns().map(x => x.region === v.region ? { ...x, ip: "203.0.113.24", serverKey: SAMPLE_KEY } : x));
    go(3);
  });
}

/* ---- Step 4: connect ---- */
function config(v) {
  return `[Interface]
PrivateKey = ${v.privateKey}
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = ${v.serverKey}
Endpoint = ${v.ip}:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;
}
function connect() {
  const v = currentVpn();
  if (!v) return redirect(0);
  if (!v.ip) return redirect(2);
  const conf = config(v), file = `wireguard-${v.region}.conf`;
  view.innerHTML = `
    <h1 tabindex="-1">Your VPN is ready</h1>
    <p><span class="status">Ready in ${esc(place(regionOf(v.region)))}</span></p>
    <p class="lead">Removes itself in about ${span(minutesLeft(v))}.${LIVE ? "" : " Sample details below."}</p>
    <p class="note"><b>Add this to one device only.</b> Using it on two devices makes them disconnect each other.</p>
    <section class="panel stack">
      <h2>On this device</h2>
      <p class="lead">Save the file, then import it in the WireGuard app.</p>
      <div class="actions"><button class="btn wide" id="save">Save ${esc(file)}</button></div>
      <p class="msg" id="msg" aria-live="polite"></p>
    </section>
    <section class="panel stack">
      <h2>Or scan it</h2>
      <p class="lead">Scan this code with the WireGuard app on your phone. It contains your private key, so don't share it.</p>
      <div id="qr" class="qr-live"></div>
    </section>
    <details class="fold">
      <summary>Show the configuration</summary>
      <pre class="mono-box" tabindex="0">${esc(conf)}</pre>
    </details>
    <div class="actions">
      <button class="quiet" id="to-list">Back to your VPNs</button>
      <button class="quiet danger" data-act="delete" data-id="${v.region}">Delete now</button>
    </div>`;
  const box = $("qr");
  if (LIVE && window.qrcode) {
    const qr = qrcode(0, "L");
    qr.addData(conf);
    qr.make();
    box.innerHTML = qr.createImgTag(4, 0, "WireGuard configuration QR code");
  } else {
    box.innerHTML = `<div class="qr">The real QR code appears here</div>`;
  }
  $("save").addEventListener("click", () => {
    if (!LIVE) { $("msg").textContent = "The real page saves this file with your private key in it."; return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([conf], { type: "text/plain" }));
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $("msg").textContent = "Saved. Import it in the WireGuard app.";
  });
  $("to-list").addEventListener("click", () => go(0));
}

function render() {
  renderRoute();
  $("route").hidden = !!state.sheet;
  if (state.sheet) return deleteSheet();
  [country, review, aws, connect][state.step]();
}

/* ---- The link back from AWS: public values only ---- */
function acceptReturnLink() {
  const m = location.hash.match(/^#connect=([a-z0-9-]+)\.(\d{1,3}(?:\.\d{1,3}){3})\.([\w-]{43})\.([\w-]{43})$/);
  if (!location.hash.startsWith("#connect=")) return;
  history.replaceState(null, "", `${location.pathname}#start`);
  if (!m) { state.error = "That link looks incomplete. Open it again from the Outputs tab in AWS."; return; }
  const [, region, ip, serverKey, publicKey] = m;
  const list = vpns(), v = list.find(x => x.region === region && x.publicKey === publicKey);
  if (!v) {
    state.error = "This browser doesn't have the key for that VPN. Open the link in the browser where you started it.";
    return;
  }
  save(list.map(x => x === v ? { ...x, ip, serverKey: fromUrlSafe(serverKey) } : x));
  state.current = region;
  history.replaceState(null, "", `${location.pathname}#ready`);
}

/* ---- Landing page motion ---- */
function animateLanding() {
  const items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduced) {
    document.documentElement.classList.add("motion");
    const seen = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add("in"); seen.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px" });
    items.forEach(el => seen.observe(el));
  }
  if (reduced) return;
  const names = ["France", "Japan", "Brazil", "Sweden", "Canada", "Singapore"];
  const word = $("word"), exit = $("exit");
  let i = 0;
  setInterval(() => {
    if (document.hidden || $("home").hidden) return;
    word.classList.add("out");
    setTimeout(() => {
      i = (i + 1) % names.length;
      word.textContent = exit.textContent = names[i];
      word.classList.remove("out");
    }, 280);
  }, 2800);
}

document.querySelector("[data-home]").addEventListener("click", e => {
  e.preventDefault();
  state.sheet = null;
  if (location.hash) location.hash = "";
  else window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
});
document.querySelector("[data-scroll]").addEventListener("click", e => {
  e.preventDefault();
  $("how").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
});
window.addEventListener("hashchange", () => swap(showScreen));

/* ---- How-to video: YouTube loads only after the visitor presses play ---- */
function setupVideo() {
  const link = document.querySelector('meta[name="wgl-video"]')?.content || "";
  const id = (link.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) || link.match(/^([\w-]{11})$/) || [])[1];
  if (!id) return;
  $("watch").hidden = false;
  $("video-play").addEventListener("click", () => {
    const lang = ["fr", "de", "ar"].find(l => (navigator.language || "").startsWith(l)) || "en";
    const frame = document.createElement("iframe");
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&hl=${lang}&cc_lang_pref=${lang}`;
    frame.title = "How to start your own VPN with WireGuard Launcher";
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    $("video").replaceChildren(frame);
  }, { once: true });
}

setupVideo();
$("demo").hidden = LIVE;
acceptReturnLink();
animateLanding();
showScreen();
