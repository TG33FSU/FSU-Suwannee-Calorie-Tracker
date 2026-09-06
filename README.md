# Suwannee Tracker

A MyFitnessPal-style calorie diary built around the Suwannee Room at FSU. The public build is designed to run as one web service: the menu is shared and refreshed on the server, while each person's diary, goals, custom foods, and ratings stay private in that person's browser.

## Local

```bash
npm install
npm start
```

Open http://localhost:3000.

## Production deployment: Railway

This project includes a `Dockerfile` so Railway runs the Puppeteer scraper with a Linux Chromium binary. Railway automatically detects a root `Dockerfile` when deploying the repository. citeturn538032search9

### 1. Put the project on GitHub

Create a GitHub repository and upload the contents of this folder. Do not upload `node_modules/` or private local data.

### 2. Create the Railway service

In Railway, create a new project and deploy the GitHub repository. The service runs `node server.js` from the Docker image.

### 3. Add persistent storage

Attach a Railway Volume to the service and set its mount path to `/app/data`. Railway volumes persist data across deploys/restarts, and because this app writes to `./data`, `/app/data` is the correct mount point. citeturn538032search1turn538032search8

### 4. Generate a public domain

In the Railway service, open **Settings → Networking → Generate Domain**. That creates the public URL people can visit. citeturn538032search13

### 5. Let the server keep the menu fresh

The server automatically syncs the menu on startup when no fresh cache exists, then checks every 15 minutes and refreshes when the cache is older than four hours. Users can also use the Sync button, with a server-side cooldown so a crowd cannot hammer the scraper.

The app does not need a separate cron service for this setup. Railway recommends cron jobs for short-lived scheduled tasks and persistent services for long-running web apps; this app is already a long-running web service. citeturn538032search2turn538032search7

## What other users get

- A public URL that works from any phone or computer.
- Shared Suwannee Room menu data, including all meal periods the scraper discovers.
- Fast menu loading from the server cache instead of making every visitor scrape the dining site.
- Private per-browser diary, goals, custom foods, and ratings.
- No account or password required.

## Important product limitation

Private user data is browser-local in this public build. That is deliberate: it prevents students from seeing or overwriting one another's diaries without adding a full authentication/database system. Clearing browser storage or switching to a different browser/device starts a new local profile.

The scraper still depends on the structure of Seminole Dining's live website. If that site's HTML changes, the scraper may need another selector update.
