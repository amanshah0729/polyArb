require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('Error: API_KEY not found in .env file');
  process.exit(1);
}

const BASE_URL = 'https://api.the-odds-api.com';
const ENDPOINT = `/v4/sports/?apiKey=${API_KEY}`;

const url = `${BASE_URL}${ENDPOINT}`;

// Create outputs directory structure
const OUTPUTS_DIR = path.join(__dirname, 'outputs', 'sports');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`Error: API returned status code ${res.statusCode}`);
      console.error('Response:', data);
      return;
    }

    try {
      const sports = JSON.parse(data);
      
      // Build output string
      let output = '\n=== Available Sports ===\n\n';
      
      if (sports.length === 0) {
        output += 'No sports found.\n';
        console.log(output);
        return;
      }

      sports.forEach((sport, index) => {
        const sportInfo = `${index + 1}. ${sport.title} (${sport.key})\n` +
          `   Group: ${sport.group}\n` +
          `   Description: ${sport.description || 'N/A'}\n` +
          `   Active: ${sport.active ? 'Yes' : 'No'}\n` +
          `   Has Outrights: ${sport.has_outrights ? 'Yes' : 'No'}\n\n`;
        output += sportInfo;
      });

      output += `\nTotal: ${sports.length} sports\n\n`;

      // Display quota info from response headers if available
      const remaining = res.headers['x-requests-remaining'];
      const used = res.headers['x-requests-used'];
      
      if (remaining !== undefined) {
        const quotaInfo = `Requests remaining: ${remaining}\nRequests used: ${used}\n`;
        output += quotaInfo;
      }

      // Add timestamp header
      const timestamp = new Date().toISOString();
      const header = `Generated: ${timestamp}\n${'='.repeat(50)}\n`;
      const fullOutput = header + output;

      // Display to console
      console.log(fullOutput);

      // Save to file
      const filename = `sports_${new Date().toISOString().replace(/[:.]/g, '-').split('T')[0]}_${Date.now()}.txt`;
      const filepath = path.join(OUTPUTS_DIR, filename);
      fs.writeFileSync(filepath, fullOutput, 'utf8');
      console.log(`\nOutput saved to: ${filepath}\n`);

    } catch (error) {
      console.error('Error parsing JSON response:', error.message);
      console.error('Response data:', data);
    }
  });
}).on('error', (error) => {
  console.error('Error making request:', error.message);
});

