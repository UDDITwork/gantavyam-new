# Deployment

| Part | Where | How |
|---|---|---|
| Frontend (`client/`) | Vercel | connect this GitHub repo, root directory `client` |
| Backend (`server/`) | Google Cloud Run | `hosting/deploy-backend.sh` (builds the image in Cloud Build) |
| Database | Turso | a hosted libSQL database, see `server/db/README.md` |

## 1. Turso database

1. Create a database at <https://turso.tech> (pick a region close to the Cloud Run region, e.g. Mumbai `aws-ap-south-1` for `asia-south1`).
2. Copy its URL (`libsql://<db>-<org>.turso.io`) and create a **database token** for it.
3. Optional: load data exported from MongoDB with `server/scripts/importMongoExport.js`.

## 2. Backend on Cloud Run

Run from the repository root. Use your own project and account ids:

```bash
export GCP_PROJECT=<project-id>
export GCP_ACCOUNT=<you@example.com>

# one-time: turn on the Google Cloud APIs the deployment uses
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  --project "$GCP_PROJECT" --account "$GCP_ACCOUNT"

# store the secrets in Secret Manager (asks for the Turso token and the admin e-mail/password; set TURSO_DATABASE_URL first to skip the URL question)
bash hosting/create-secrets.sh

# build and deploy; ALLOWED_ORIGINS lists the frontend URLs that may call the API (comma separated)
ALLOWED_ORIGINS=https://<your-app>.vercel.app bash hosting/deploy-backend.sh
```

The service runs as **one always-on instance** (`--min-instances 1 --max-instances 1 --no-cpu-throttling`): Socket.IO
connections and the background timers (queue clean-up, TTL sweeper) live in that process's memory. Cloud Run closes
a WebSocket after the request timeout (set to 60 minutes); the clients reconnect on their own.

The script prints the service URL, e.g. `https://gantavyam-backend-xxxxx-el.a.run.app`.

Settings the backend reads (see `server/.env.example`): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `JWT_SECRET`,
`DEFAULT_ADMIN_EMAIL`, `DEFAULT_ADMIN_PASSWORD`, `ALLOWED_ORIGINS`, and optionally `CLOUDINARY_*`, `TWILIO_*`,
`FAST2SMS_API_KEY`. Without Cloudinary, uploaded files fall back to the container's disk, which is lost on restart.

## 3. Frontend on Vercel

Import the repository, then set:

* **Root Directory:** `client` (Framework preset: Create React App)
* **Environment variables:**
  * `REACT_APP_API_URL` = `https://<cloud-run-url>/api`
  * `REACT_APP_SOCKET_URL` = `https://<cloud-run-url>`
  * `REACT_APP_GOOGLE_MAPS_API_KEY` = your Google Maps key (allow the Vercel domain in the key's HTTP referrer restrictions)

Deploy, then add the Vercel URL to the backend's `ALLOWED_ORIGINS` and re-run `hosting/deploy-backend.sh`.
