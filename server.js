const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const path = require('path');
const { processJobApplication } = require('./src/agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
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

  res.status(202).json({
    message: 'Job application run accepted.',
    acceptedCount: urls.length
  });


  urls.forEach((url) => {
    console.log(`Starting background agent for: ${url}`);

    // Call your main agent loop asynchronously so it doesn't block the server.
    // Ensure you pass both the URL and the user data it needs to fill the forms.
    processJobApplication(url, userData).catch((error) => {
      console.error(`[CRITICAL ERROR] Agent failed on ${url}:`, error);
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});