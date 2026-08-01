#!/usr/bin/env node
// Multi-profile Flow API with parallel execution across multiple Chrome instances
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROFILES_FILE = path.join(PROJECT_ROOT, 'config', 'profiles.json');
const JOBS_FILE = path.join(PROJECT_ROOT, 'outputs', 'jobs-multi.json');

const PORT = 8080;
const API_KEY = '68a816138699337a887c64d14b5402f8';

// Load profiles
let profiles = [];
try {
  const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
  profiles = data.profiles.filter(p => p.enabled);
  console.log(`[multi-api] Loaded ${profiles.length} profiles`);
} catch (e) {
  console.error('[multi-api] Failed to load profiles:', e.message);
  process.exit(1);
}

// Job storage
const jobs = new Map();
const queue = [];
let nextProfileIndex = 0;

function loadJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    for (const j of arr) jobs.set(j.id, j);
  } catch {}
}

function saveJobs() {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2));
  } catch {}
}

loadJobs();

// Round-robin profile selector
function selectProfile() {
  if (profiles.length === 0) return null;
  const profile = profiles[nextProfileIndex];
  nextProfileIndex = (nextProfileIndex + 1) % profiles.length;
  return profile;
}

// Forward request to profile-specific API (running on different port)
async function forwardToProfileAPI(profile, jobData) {
  const profilePort = 8080 + profiles.findIndex(p => p.id === profile.id) + 1;
  const url = `http://localhost:${profilePort}/generate`;
  
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(jobData)
    });
    
    return await resp.json();
  } catch (e) {
    console.error(`[multi-api] Forward to ${profile.id} failed:`, e.message);
    return { error: 'profile_unavailable', profileId: profile.id };
  }
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  
  // Health check
  if (req.method === 'GET' && urlPath === '/health') {
    return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({
      ok: true,
      profiles: profiles.length,
      activeProfiles: profiles.map(p => ({id: p.id, email: p.email, port: 8080 + profiles.findIndex(pp => pp.id === p.id) + 1}))
    }));
  }
  
  // Generate endpoint
  if (req.method === 'POST' && urlPath === '/generate') {
    if (req.headers['x-api-key'] !== API_KEY) {
      return res.writeHead(401, {'Content-Type': 'application/json'}).end(JSON.stringify({error: 'unauthorized'}));
    }
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let jobData;
      try {
        jobData = JSON.parse(body);
      } catch {
        return res.writeHead(400, {'Content-Type': 'application/json'}).end(JSON.stringify({error: 'invalid_json'}));
      }
      
      // Select profile
      const profile = selectProfile();
      if (!profile) {
        return res.writeHead(503, {'Content-Type': 'application/json'}).end(JSON.stringify({error: 'no_profiles_available'}));
      }
      
      // Forward to profile API
      const result = await forwardToProfileAPI(profile, jobData);
      
      // Store job with profile info
      if (result.jobId) {
        const job = {
          id: result.jobId,
          profileId: profile.id,
          email: profile.email,
          prompt: jobData.prompt,
          createdAt: Date.now(),
          ...result
        };
        jobs.set(job.id, job);
        saveJobs();
      }
      
      res.writeHead(result.error ? 500 : 200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    });
    return;
  }
  
  // Job status
  if (req.method === 'GET' && urlPath.startsWith('/jobs/')) {
    const jobId = urlPath.slice('/jobs/'.length);
    const job = jobs.get(jobId);
    
    if (!job) {
      return res.writeHead(404, {'Content-Type': 'application/json'}).end(JSON.stringify({error: 'not_found'}));
    }
    
    // Forward status check to profile API
    const profilePort = 8080 + profiles.findIndex(p => p.id === job.profileId) + 1;
    try {
      const resp = await fetch(`http://localhost:${profilePort}/jobs/${jobId}`);
      const status = await resp.json();
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({...status, profileId: job.profileId, email: job.email}));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'profile_api_unavailable', jobId, profileId: job.profileId}));
    }
    return;
  }
  
  res.writeHead(404, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'not_found'}));
});

server.listen(PORT, () => {
  console.log(`[multi-api] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[multi-api] Profiles: ${profiles.map(p => p.id).join(', ')}`);
  console.log(`[multi-api] Load balancing: Round-robin`);
});
