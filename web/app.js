// --- State ---
let currentStep = 1;
let lastOutputFile = null; // carries filename across steps

// --- Step Navigation ---
const stepBtns = document.querySelectorAll(".step-btn");
const steps = document.querySelectorAll(".step");

function goToStep(n) {
  currentStep = n;
  stepBtns.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.step) === n);
  });
  steps.forEach((s) => {
    s.classList.toggle("active", s.id === `step-${n}`);
  });
  if (n === 3) refreshGenerateDropdowns();
  if (n === 4) refreshSendDropdown();
}

stepBtns.forEach((btn) => {
  btn.addEventListener("click", () => goToStep(Number(btn.dataset.step)));
});

// --- Parse mode toggle ---
document.querySelectorAll('input[name="parseMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const isComments = radio.value === "comments" && radio.checked;
    document.querySelectorAll(".messages-opts").forEach((el) => (el.style.display = isComments ? "none" : ""));
    document.querySelectorAll(".comments-opts").forEach((el) => (el.style.display = isComments ? "" : "none"));
  });
});

// --- Env Check ---
async function checkEnv() {
  try {
    const res = await fetch("/api/env");
    const env = await res.json();
    const el = document.getElementById("env-checklist");
    const vars = ["TG_API_ID", "TG_API_HASH", "TG_SESSION", "OPENAI_API_KEY"];
    el.innerHTML = vars
      .map(
        (v) =>
          `<div class="env-item"><span class="dot ${env[v] ? "ok" : "missing"}"></span>${v}</div>`
      )
      .join("");

    // Show auth section if session is missing
    if (!env.TG_SESSION) {
      document.getElementById("auth-section").style.display = "";
    }
  } catch (err) {
    document.getElementById("env-checklist").innerHTML =
      '<p style="color:#f08060">Failed to check environment.</p>';
  }
}

// --- Auth ---
async function startAuth() {
  const btn = document.getElementById("auth-start-btn");
  btn.disabled = true;
  btn.textContent = "Connecting...";

  try {
    const res = await fetch("/api/auth/start", { method: "POST" });
    const data = await res.json();
    if (data.error) {
      document.getElementById("auth-status").textContent = "Error: " + data.error;
      btn.disabled = false;
      btn.textContent = "Start Auth";
      return;
    }
    showAuthStep(data.step);
  } catch (err) {
    document.getElementById("auth-status").textContent = "Connection failed.";
    btn.disabled = false;
    btn.textContent = "Start Auth";
  }
}

function showAuthStep(step) {
  const statusEl = document.getElementById("auth-status");
  const inputGroup = document.getElementById("auth-input-group");
  const startBtn = document.getElementById("auth-start-btn");
  const label = document.getElementById("auth-label");
  const input = document.getElementById("auth-input");

  if (step === "done") {
    statusEl.textContent = "Authentication successful! Session saved.";
    inputGroup.style.display = "none";
    startBtn.style.display = "none";
    checkEnv(); // refresh the checklist
    return;
  }

  startBtn.style.display = "none";
  inputGroup.style.display = "flex";
  input.value = "";
  input.focus();

  const labels = {
    phone: "Phone number:",
    code: "Verification code:",
    password: "2FA password:",
  };
  label.textContent = labels[step] || step + ":";
  statusEl.textContent = `Step: ${step}`;
}

async function submitAuth() {
  const input = document.getElementById("auth-input");
  const value = input.value.trim();
  if (!value) return;

  const btn = document.getElementById("auth-submit-btn");
  btn.disabled = true;

  try {
    const res = await fetch("/api/auth/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    const data = await res.json();
    if (data.error) {
      document.getElementById("auth-status").textContent = "Error: " + data.error;
    } else {
      showAuthStep(data.step);
    }
  } catch (err) {
    document.getElementById("auth-status").textContent = "Request failed.";
  }

  btn.disabled = false;
}

// Allow Enter key in auth input
document.getElementById("auth-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAuth();
});

// --- SSE Log Streaming ---
function streamJob(jobId, logPanelId, onOutputFile, onDone) {
  const panel = document.getElementById(logPanelId);
  panel.innerHTML = "";

  const source = new EventSource(`/api/stream/${jobId}`);

  source.addEventListener("stdout", (e) => {
    const line = JSON.parse(e.data);
    const div = document.createElement("div");
    div.className = "log-line";
    div.textContent = line;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
  });

  source.addEventListener("stderr", (e) => {
    const line = JSON.parse(e.data);
    const div = document.createElement("div");
    div.className = "log-line stderr";
    div.textContent = line;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
  });

  source.addEventListener("output_file", (e) => {
    const file = JSON.parse(e.data);
    if (onOutputFile) onOutputFile(file);
  });

  source.addEventListener("exit", (e) => {
    const code = JSON.parse(e.data);
    const div = document.createElement("div");
    div.className = "log-line info";
    div.textContent = code === "0" || code === 0
      ? "--- Process completed successfully ---"
      : `--- Process exited with code ${code} ---`;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
    source.close();
    if (onDone) onDone(Number(code));
  });

  source.onerror = () => {
    source.close();
    const div = document.createElement("div");
    div.className = "log-line stderr";
    div.textContent = "--- Connection lost ---";
    panel.appendChild(div);
  };

  return source;
}

// --- Parse ---
async function runParse(e) {
  e.preventDefault();
  const mode = document.querySelector('input[name="parseMode"]:checked').value;
  const chatId = document.getElementById("chatId").value.trim();
  if (!chatId) return false;

  const body = { mode, chatId };
  if (mode === "messages") {
    body.limit = Number(document.getElementById("parseLimit").value);
  } else {
    body.posts = Number(document.getElementById("parsePosts").value);
    body.commentsPerPost = Number(document.getElementById("parseComments").value);
  }

  const btn = document.getElementById("parse-btn");
  btn.disabled = true;
  btn.textContent = "Running...";
  document.getElementById("parse-continue").style.display = "none";

  try {
    const res = await fetch("/api/run/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      document.getElementById("parse-log").textContent = "Error: " + data.error;
      btn.disabled = false;
      btn.textContent = "Parse";
      return false;
    }

    streamJob(
      data.jobId,
      "parse-log",
      (file) => {
        // Extract just the filename from the full path
        lastOutputFile = file.split("/").pop();
      },
      (code) => {
        btn.disabled = false;
        btn.textContent = "Parse";
        if (code === 0 && lastOutputFile) {
          document.getElementById("parse-continue").style.display = "";
        }
      }
    );
  } catch (err) {
    document.getElementById("parse-log").textContent = "Request failed.";
    btn.disabled = false;
    btn.textContent = "Parse";
  }
  return false;
}

// --- Generate ---
async function refreshGenerateDropdowns() {
  const [dataRes, promptRes] = await Promise.all([
    fetch("/api/files/data"),
    fetch("/api/files/prompts"),
  ]);
  const dataFiles = await dataRes.json();
  const promptFiles = await promptRes.json();

  const genInput = document.getElementById("genInput");
  genInput.innerHTML = dataFiles
    .map((f) => `<option value="${f.name}">${f.name}</option>`)
    .join("");

  // Pre-select the output from parse step
  if (lastOutputFile) {
    const opt = genInput.querySelector(`option[value="${lastOutputFile}"]`);
    if (opt) opt.selected = true;
  }

  const genPrompt = document.getElementById("genPrompt");
  genPrompt.innerHTML = promptFiles
    .map((f) => `<option value="${f.name}">${f.name}</option>`)
    .join("");

  // Load prompt preview for first option
  if (promptFiles.length > 0) loadPromptPreview(promptFiles[0].name);
}

async function loadPromptPreview(filename) {
  try {
    const res = await fetch(`/api/files/prompts/${encodeURIComponent(filename)}`);
    const text = await res.text();
    document.getElementById("promptPreview").value = text;
  } catch {
    document.getElementById("promptPreview").value = "Failed to load preview.";
  }
}

document.getElementById("genPrompt").addEventListener("change", (e) => {
  loadPromptPreview(e.target.value);
});

async function runGenerate(e) {
  e.preventDefault();
  const inputFile = document.getElementById("genInput").value;
  const promptFile = document.getElementById("genPrompt").value;
  if (!inputFile || !promptFile) return false;

  const btn = document.getElementById("generate-btn");
  btn.disabled = true;
  btn.textContent = "Running...";
  document.getElementById("generate-continue").style.display = "none";

  try {
    const res = await fetch("/api/run/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputFile, promptFile }),
    });
    const data = await res.json();
    if (data.error) {
      document.getElementById("generate-log").textContent = "Error: " + data.error;
      btn.disabled = false;
      btn.textContent = "Generate";
      return false;
    }

    streamJob(
      data.jobId,
      "generate-log",
      (file) => {
        lastOutputFile = file.split("/").pop();
      },
      (code) => {
        btn.disabled = false;
        btn.textContent = "Generate";
        if (code === 0 && lastOutputFile) {
          document.getElementById("generate-continue").style.display = "";
        }
      }
    );
  } catch (err) {
    document.getElementById("generate-log").textContent = "Request failed.";
    btn.disabled = false;
    btn.textContent = "Generate";
  }
  return false;
}

function continueToGenerate() {
  goToStep(3);
}

// --- Send ---
async function refreshSendDropdown() {
  const res = await fetch("/api/files/data");
  const files = await res.json();
  const generated = files.filter((f) => f.name.includes("_generated_"));

  const sendInput = document.getElementById("sendInput");
  sendInput.innerHTML = generated
    .map((f) => `<option value="${f.name}">${f.name}</option>`)
    .join("");

  // Pre-select from generate step
  if (lastOutputFile) {
    const opt = sendInput.querySelector(`option[value="${lastOutputFile}"]`);
    if (opt) opt.selected = true;
  }
}

async function runSend(e) {
  e.preventDefault();
  const inputFile = document.getElementById("sendInput").value;
  if (!inputFile) return false;

  if (!confirm("This will post to Telegram. Continue?")) return false;

  const mode = document.querySelector('input[name="sendMode"]:checked').value;
  const delay = Number(document.getElementById("sendDelay").value);

  const btn = document.getElementById("send-btn");
  btn.disabled = true;
  btn.textContent = "Sending...";

  try {
    const res = await fetch("/api/run/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputFile, mode, delay }),
    });
    const data = await res.json();
    if (data.error) {
      document.getElementById("send-log").textContent = "Error: " + data.error;
      btn.disabled = false;
      btn.textContent = "Send";
      return false;
    }

    streamJob(
      data.jobId,
      "send-log",
      null,
      (code) => {
        btn.disabled = false;
        btn.textContent = "Send";
      }
    );
  } catch (err) {
    document.getElementById("send-log").textContent = "Request failed.";
    btn.disabled = false;
    btn.textContent = "Send";
  }
  return false;
}

function continueToSend() {
  goToStep(4);
}

// --- Init ---
// Expose functions to HTML onclick handlers
window.startAuth = startAuth;
window.submitAuth = submitAuth;
window.runParse = runParse;
window.runGenerate = runGenerate;
window.runSend = runSend;
window.continueToGenerate = continueToGenerate;
window.continueToSend = continueToSend;

checkEnv();
