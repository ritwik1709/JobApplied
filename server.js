const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();
const path = require('path');
const crypto = require('crypto');
const { processJobApplication } = require('./src/agent');

const app = express();
const PORT = process.env.PORT || 3000;
const jobStatuses = new Map();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://job-applied.vercel.app,http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

function createJobStatus(jobId, urls) {
  const now = new Date().toISOString();
  const status = {
    jobId,
    state: 'queued',
    message: 'Job queued.',
    currentUrl: null,
    currentAction: null,
    totalUrls: urls.length,
    completedUrls: 0,
    failedUrls: 0,
    logs: [],
    createdAt: now,
    updatedAt: now
  };

  jobStatuses.set(jobId, status);
  return status;
}

function updateJobStatus(jobId, patch = {}) {
  const existing = jobStatuses.get(jobId);
  if (!existing) return null;

  const next = {
    ...existing,
    ...patch,
    logs: patch.log
      ? [...existing.logs, { message: patch.log, at: new Date().toISOString() }].slice(-25)
      : existing.logs,
    updatedAt: new Date().toISOString()
  };

  delete next.log;
  jobStatuses.set(jobId, next);
  return next;
}

app.get('/api/v1/jobs/status/:jobId', (req, res) => {
  const status = jobStatuses.get(req.params.jobId);

  if (!status) {
    return res.status(404).json({ message: 'Job status not found.' });
  }

  return res.json(status);
});


app.post('/api/v1/jobs/apply', (req, res) => {
  const urls = Array.isArray(req.body) ? req.body : req.body?.urls;
  const userData = req.body?.userData || {};

  if (!Array.isArray(urls)) {
    return res.status(400).json({
      message: 'Request body must be an array of URLs or an object with a urls array.'
    });
  }

  console.log('Received job application URLs:', urls);

  const jobId = crypto.randomUUID();
  createJobStatus(jobId, urls);
  updateJobStatus(jobId, {
    state: 'running',
    message: 'Job accepted. Automation run started.',
    log: `Accepted ${urls.length} job URL(s).`
  });

  res.status(202).json({
    message: 'Job application run accepted.',
    acceptedCount: urls.length,
    jobId
  });


  urls.forEach((url, index) => {
    console.log(`Starting background agent for: ${url}`);

    // Call your main agent loop asynchronously so it doesn't block the server.
    // Ensure you pass both the URL and the user data it needs to fill the forms.
    processJobApplication(url, userData, {
      jobId,
      urlIndex: index,
      totalUrls: urls.length,
      updateJobStatus
    }).catch((error) => {
      console.error(`[CRITICAL ERROR] Agent failed on ${url}:`, error);
      updateJobStatus(jobId, {
        state: 'failed',
        message: `Automation failed for ${url}.`,
        failedUrls: (jobStatuses.get(jobId)?.failedUrls || 0) + 1,
        log: `[${url}] ${error?.message || error}`,
        currentUrl: url
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});