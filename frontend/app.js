const form = document.getElementById('jobForm');
const urlsField = document.getElementById('urls');
const userDataField = document.getElementById('userData');
const statusEl = document.getElementById('status');
const clearBtn = document.getElementById('clearBtn');
const API_BASE_URL = 'https://jobapplied.onrender.com';
let currentJobId = null;
let statusPoller = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function renderJobStatus(status) {
  const lines = [
    `Job ID: ${status.jobId}`,
    `State: ${status.state}`,
    `Message: ${status.message || '—'}`,
    `Current URL: ${status.currentUrl || '—'}`,
    `Current Action: ${status.currentAction || '—'}`,
    `Completed URLs: ${status.completedUrls || 0}`,
    `Failed URLs: ${status.failedUrls || 0}`,
    `Updated At: ${status.updatedAt || '—'}`
  ];

  if (Array.isArray(status.logs) && status.logs.length) {
    lines.push('', 'Recent Logs:');
    status.logs.slice(-8).forEach((entry) => {
      lines.push(`- ${entry.at}: ${entry.message}`);
    });
  }

  setStatus(lines.join('\n'));
}

async function pollJobStatus(jobId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/jobs/status/${jobId}`);
    if (!response.ok) {
      throw new Error(`Status request failed (${response.status})`);
    }

    const status = await response.json();
    renderJobStatus(status);

    if (status.state === 'completed' || status.state === 'failed') {
      if (statusPoller) {
        clearInterval(statusPoller);
        statusPoller = null;
      }
    }
  } catch (error) {
    setStatus(`Status polling failed: ${error.message}`);
  }
}

function parseUrls(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseUserData(raw) {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {};
  }

  const parseCandidate = (candidate) => {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.userData) {
      return parsed.userData;
    }
    return parsed;
  };

  try {
    return parseCandidate(trimmed);
  } catch (firstError) {
    try {
      return parseCandidate(`{${trimmed}}`);
    } catch (secondError) {
      throw firstError;
    }
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const urls = parseUrls(urlsField.value);
  if (!urls.length) {
    setStatus('Please add at least one job URL.');
    return;
  }

  let userData = {};
  if (userDataField.value.trim()) {
    try {
      userData = parseUserData(userDataField.value);
    } catch (error) {
      setStatus(
        `User Data JSON is invalid: ${error.message}. Paste either a full JSON object or the fragment inside userData.`
      );
      return;
    }
  }

  setStatus('Submitting job application run...');

  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/jobs/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ urls, userData })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || 'Request failed');
    }

    currentJobId = payload.jobId;
    setStatus(
      `Accepted ${payload.acceptedCount} job URL(s). Job ID: ${payload.jobId}\nStarting status updates...`
    );

    if (statusPoller) {
      clearInterval(statusPoller);
    }

    await pollJobStatus(payload.jobId);
    statusPoller = setInterval(() => {
      pollJobStatus(payload.jobId);
    }, 2500);
  } catch (error) {
    setStatus(`Request failed: ${error.message}`);
  }
});

clearBtn.addEventListener('click', () => {
  urlsField.value = '';
  userDataField.value = '';
  currentJobId = null;
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }
  setStatus('Idle.');
});
