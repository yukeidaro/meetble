# Meetble in the cloud: anyone signs in with Google

Cloud mode turns on when the server has `GOOGLE_CLIENT_ID`. Then:

- **Accounts.** The first "Continue with Google" creates the account. Each account keeps its own profile ("My profile"), its own runs (`/data/runs/<id>/`), and its own site connections.
- **Connections (LinkedIn, X, Luma, Instagram).** Clicking an account card opens "Connect": your profile URL or handle, plus the site's session cookie (`li_at`, `auth_token`, `luma.auth-session-key`, `sessionid`). Cookies are encrypted at rest (AES-256-GCM, key from `MEETBLE_SECRET`) and never sent back to the browser. Disconnect deletes them.
- **Browser research on the server.** Each run starts a headless Chromium, sets that account's saved cookies, and points `browser_tools.py` at it with `MEETBLE_CDP_URL`. No Allow prompt, no one's own Chrome. Without saved cookies the browser steps are skipped and web, podcast and X API research still run.
- **Local mode is unchanged.** Without `GOOGLE_CLIENT_ID`, `node server.mjs` is the single-user app on your computer that reads your own Chrome.

## Deploy to Google Cloud Run (gcloud CLI)

Open [Cloud Shell](https://shell.cloud.google.com) (already signed in), then:

```bash
git clone https://github.com/yukeidaro/meetble && cd meetble
gcloud config set project <your-project-id>
cp .env.example .env && nano .env        # paste ANTHROPIC_API_KEY, XAI_API_KEY, EXA_API_KEY ...
./deploy-cloudrun.sh                      # builds the Dockerfile, deploys, prints the URL (token-locked for now)
```

Then make the Google sign-in client once (the script prints these links with your project filled in):

1. Google Auth Platform → **Get started**: app name Meetble, audience External.
2. **Clients → Create client** → Web application → Authorized JavaScript origins: the Cloud Run URL.
3. Re-deploy with the client ID: `GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com ./deploy-cloudrun.sh`

While the app is in "Testing", only test users you add under **Audience** can sign in; **Publish app** opens it to every Google account. To keep it to a list, set `MEETBLE_ALLOWED_EMAILS="a@gmail.com,@yourcompany.com"` when deploying.

What the script sets up: region `asia-east1` (Taiwan), 1 instance (runs live in memory), 2 vCPU / 4 GiB, no CPU throttling, 60-minute stream timeout, and a Cloud Storage bucket mounted at `/data` for accounts, runs and the generated `MEETBLE_SECRET`.

Everyone shares the server's API keys, and `MEETBLE_MAX_RUNS` (default 3) caps runs at once.

Delete it all: `gcloud run services delete meetble --region asia-east1` and `gcloud storage rm -r gs://<project>-meetble-data`.

## Run cloud mode locally

```bash
npm ci && npm run build
GOOGLE_CLIENT_ID=<id> MEETBLE_SECRET=dev MEETBLE_DATA=./data CHROME_PATH=/usr/bin/chromium node server.mjs
```

Add `http://localhost:8787` to the client's Authorized JavaScript origins.
